import type {
  AiErrorCode,
  CountResult,
  DecisionFailureKind,
  DecisionWireAnswer,
  DecisionWireRequest,
  DecisionWireResult,
  InferenceEvent,
  Provider,
  RequestBody,
  RouteDecl,
  RouteTable,
} from '@agnes/protocol'
import { SLOT_NAMES } from '@agnes/protocol'
import {
  type DecisionAdapter,
  type DecisionAdapterAnswer,
  DecisionAdapterError,
  type DecisionUsage,
  type WireAdapter,
} from './adapter.js'
import type { ContractStore } from './contract-store.js'
import { resolveCredentials } from './credentials.js'
import { buildDecisionRegistry, type DecisionRegistry } from './decision-registry.js'
import { createState, finish, step } from './decode/machine.js'
import { PARSER_VERSION } from './decode/rules/index.js'
import type { DecodeContext } from './decode/types.js'
import { AiSetupError } from './errors.js'
import { guardSequence } from './guard.js'
import { buildRegistry, type Registry } from './registry.js'
import { type ResolvedDecision, resolveDecisionSelection, resolveSelection, SlotUnresolved } from './route.js'
import { buildStamp, renderPrefixedPrompt, type SentReport } from './stamp.js'
import { estimateBilling, estimateCredits } from './usage.js'

// A caller that says nothing still gets a bounded wait: an unbounded first-token wait is how a
// hung route turns into a hung turn.
const DEFAULT_TIMEOUT = { firstToken: 120_000, total: 600_000 }

export type InferenceDeps = {
  registry: Registry
  routes: RouteTable
  contract: ContractStore
  clock: () => number
  parserVersion: string
  /**
   * How many ledger credits one dollar buys. Required rather than defaulted, because a default here
   * is the one place this can go wrong quietly: a caller that never thought about the unit records
   * dollars in a column a budget cap reads as credits. `createProvider` chooses one on a caller's
   * behalf and says so; nothing else does.
   */
  creditsPerUsd: number
  /** The decision routes, when any were fitted: inference refuses them by name. */
  decisions?: DecisionRegistry
}

/**
 * One inference, as an event stream. Two properties hold for every path through it:
 *
 * Nothing throws. The caller is a kernel step that has to write a turn either way, so a failure
 * that escaped as an exception would leave a request in the ledger with no outcome. Every failure —
 * an unavailable request selection, an adapter that threw, an adapter that simply stopped — leaves here as an
 * `error` event.
 *
 * The sequence is `sent` first and one terminal event last. `sent` is emitted before the first adapter event is
 * forwarded, so a turn is always attributable to a model and a contract even if the wire never
 * answered; and once `done` or `error` has been forwarded nothing further is passed on, so an
 * adapter that keeps talking after finishing cannot append to a finished turn.
 */
export async function* runInference(
  deps: InferenceDeps,
  req: RequestBody,
  opts: Parameters<Provider['infer']>[1],
): AsyncIterable<InferenceEvent> {
  // A decision slot or a decision route never reaches a chat adapter. Neither would resolve against
  // the chat registry anyway; naming the reason keeps the refusal from reading as a missing model.
  if (!(SLOT_NAMES as readonly string[]).includes(req.slot) || deps.decisions?.lookup(req.route)) {
    yield {
      type: 'error',
      reason: 'error',
      code: 'NO_MODEL',
      message: `slot=${req.slot} route=${req.route} (slot-kind)`,
      retryable: false,
    }
    return
  }
  let resolved: ReturnType<typeof resolveSelection>
  try {
    resolved = resolveSelection(deps.registry, req.slot, req.route, req.model)
  } catch (e) {
    if (e instanceof SlotUnresolved) {
      yield { type: 'error', reason: 'error', code: e.code, message: e.detail, retryable: false }
      return
    }
    throw e
  }
  const hit = deps.registry.lookup(resolved.route)
  // resolveSelection only returns a route it found in this same registry, so this cannot miss for the
  // registry this package builds. It is still encoded as an event rather than assumed away, because
  // `Registry` is an interface a caller may implement.
  if (!hit) {
    yield {
      type: 'error',
      reason: 'error',
      code: 'NO_ADAPTER',
      message: `route=${resolved.route}`,
      retryable: false,
    }
    return
  }
  let wireReq: RequestBody
  try {
    if (req.contractId !== resolved.model.contract_id) throw new Error('contract mismatch')
    if (req.contractId !== null && deps.contract.prefixHash(req.contractId) === null)
      throw new Error('contract unavailable')
    wireReq = {
      ...req,
      system: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        renderPrefixedPrompt(req, deps.contract),
      ),
    }
  } catch {
    yield {
      type: 'error',
      reason: 'error',
      code: 'CONTRACT_MISMATCH',
      message: 'selected model contract is unavailable or inconsistent',
      retryable: false,
    }
    return
  }
  let sentReport: SentReport | undefined
  let sentEmitted = false
  const emitSent = (): InferenceEvent => {
    sentEmitted = true
    return { type: 'sent', stamp: buildStamp(req, deps.contract, deps.parserVersion, sentReport) }
  }
  // The clock starts where the turn does. Both figures on the timing block are measured from here,
  // so they describe the same interval a caller timing this call from outside would have measured.
  const startedAt = deps.clock()
  let ttftMs: number | undefined
  const markFirstToken = () => {
    if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(deps.clock() - startedAt))
  }
  const streamOpts = {
    reportSent: (report: SentReport) => {
      if (!sentEmitted) sentReport = structuredClone(report)
    },
    signal: opts.signal,
    toolNames: opts.toolNames,
    ...(opts.retry === false ? { retry: false as const } : {}),
    sessionKey: req.sessionKey,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT,
  }
  // The decode chain sits between the adapter and the caller, so the same recovery rules apply to
  // every wire protocol instead of being reimplemented per vendor. Its ordinals and the native
  // calls' come from one counter: they number the calls of a single turn, and a reader must be able
  // to order them without knowing how each one was carried.
  let ordinal = 0
  const dctx: DecodeContext = { toolNames: opts.toolNames, nextOrdinal: () => ordinal++ }
  let dstate = createState()
  const flush = (): InferenceEvent[] => {
    const r = finish(dstate, dctx)
    dstate = r.state
    return r.events
  }
  let terminal = false
  try {
    for await (const ev of hit.adapter.stream(resolved.route, wireReq, streamOpts)) {
      if (!sentEmitted) yield emitSent()
      if (terminal) break
      if (ev.type === 'text_delta' || ev.type === 'thinking_delta') {
        const r = step(
          dstate,
          { kind: ev.type === 'text_delta' ? 'text' : 'thinking', delta: ev.delta },
          dctx,
        )
        dstate = r.state
        for (const e of r.events) {
          markFirstToken()
          yield e
        }
        continue
      }
      // Anything that is not prose ends the run of prose. Whatever the chain is still holding was
      // text all along, and it has to leave before this event does - a held tail emitted after the
      // turn's usage, or after its terminal event, would be text appended to a finished turn.
      for (const e of flush()) {
        markFirstToken()
        yield e
      }
      // The adapter reports the call it read off the wire; how it was recovered is this layer's to
      // say, and off a native protocol field the answer is `native`.
      if (ev.type === 'toolcall_end') {
        // A call is output too. A turn whose whole answer was a tool call still had a first token,
        // and reporting no time to it would read as a turn that produced nothing.
        markFirstToken()
        yield { ...ev, call: { ...ev.call, ordinal: ordinal++ }, via: 'native' }
        continue
      }
      if (ev.type === 'toolcall_delta') {
        markFirstToken()
        yield ev
        continue
      }
      if (ev.type === 'usage') {
        // What the turn cost and how long it took, filled in here because this is the only layer
        // that knows both the catalogue price and when the turn began. A gateway that billed the
        // request is authoritative and is not second-guessed - including when it billed zero.
        const safeBilling =
          ev.billing &&
          Object.keys(ev.billing).length === 3 &&
          ['usdMicros', 'source', 'subscription'].every((key) => Object.hasOwn(ev.billing ?? {}, key)) &&
          Number.isSafeInteger(ev.billing.usdMicros) &&
          ev.billing.usdMicros >= 0 &&
          (ev.billing.source === 'gateway' || ev.billing.source === 'estimated') &&
          typeof ev.billing.subscription === 'boolean'
            ? ev.billing
            : estimateBilling(resolved.model, ev.tokens)
        // Do not let an invalid runtime billing object survive through the spread below. Adapter
        // implementations are TypeScript-typed, but a remote decoder can still hand one an invalid
        // value; only the closed shape above is allowed onto the public stream.
        const { billing: _untrustedBilling, ...usage } = ev
        yield {
          ...usage,
          credits: ev.credits ?? estimateCredits(resolved.model, ev.tokens, deps.creditsPerUsd),
          ...(safeBilling ? { billing: safeBilling } : {}),
          timing: {
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            durationMs: Math.max(0, Math.round(deps.clock() - startedAt)),
          },
        }
        continue
      }
      if (ev.type === 'done' || ev.type === 'error') terminal = true
      yield ev
    }
    if (!sentEmitted) yield emitSent()
    if (!terminal) {
      for (const e of flush()) yield e
      yield {
        type: 'error',
        reason: 'error',
        code: 'TRANSPORT',
        message: 'stream ended without a terminal event',
        retryable: true,
      }
    }
  } catch (e) {
    if (!sentEmitted) yield emitSent()
    // The thrown value's own text is not forwarded: it is written by the wire library and can quote
    // request material. What the caller needs is the class of failure and whether to retry.
    if (!terminal)
      yield {
        type: 'error',
        reason: opts.signal.aborted ? 'aborted' : 'error',
        code: opts.signal.aborted ? 'ABORTED' : 'TRANSPORT',
        message: e instanceof Error ? e.name : 'adapter failed',
        retryable: !opts.signal.aborted,
      }
  }
}

// No route table here: the decision target travels in each request, filled by the caller from the
// session's current preset, so switching presets switches the target with no facade state.
export type DecisionDeps = {
  registry: Registry
  decisions: DecisionRegistry
  creditsPerUsd: number
}

/**
 * What provider.decide rejects with; its shape is protocol's DecisionFailure. (Not declared with
 * `implements`: under exactOptionalPropertyTypes an optional parameter property reads as
 * `string | undefined`, which the readonly optional `route` of that type does not accept.)
 */
export class DecisionError extends Error {
  constructor(
    readonly kind: DecisionFailureKind,
    readonly code: AiErrorCode,
    readonly route?: string,
    note?: string,
  ) {
    super(`${code}: decision ${kind}${note ? ` (${note})` : ''}`)
    this.name = 'DecisionError'
  }
}

/**
 * Once the time limit has fired, every failure is a timeout, whatever the adapter reported on its
 * way out: an aborted fetch looks like a transport error from inside the adapter.
 */
export function decisionFailureKind(code: AiErrorCode, timedOut: boolean): DecisionFailureKind {
  if (timedOut) return 'timeout'
  if (code === 'FORMAT' || code === 'CONTRACT_MISMATCH') return 'invalid'
  return 'unavailable'
}

const plainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const tokenCount = (v: unknown): boolean => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 0)

/**
 * One decision query. It resolves the route and model the request names against the decision
 * catalogue (never a boot-time table: the caller fills both from the current preset), bounds the
 * call by `req.timeoutMs` even against an adapter that ignores its signal, classifies failures,
 * checks the envelope and prices the call. It does not judge the answers: extra fields, sums that miss one and the like pass
 * through unchanged, because the caller's validator is the one check that fails closed on them.
 */
export async function runDecision(
  deps: DecisionDeps,
  req: DecisionWireRequest,
  opts: { signal: AbortSignal },
): Promise<DecisionWireResult> {
  let target: ResolvedDecision
  try {
    target = resolveDecisionSelection(deps.registry, deps.decisions, req.route, req.model)
  } catch (e) {
    if (e instanceof SlotUnresolved) throw new DecisionError('unavailable', e.code, e.route, e.detail)
    throw e
  }
  const hit = deps.decisions.lookup(target.route)
  if (!hit) throw new DecisionError('unavailable', 'NO_ADAPTER', target.route)
  const inner = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    inner.abort()
  }, req.timeoutMs)
  const forward = () => inner.abort()
  if (opts.signal.aborted) inner.abort()
  else opts.signal.addEventListener('abort', forward, { once: true })
  const abandoned = new Promise<never>((_, reject) => {
    const fail = () => reject(new DecisionAdapterError(timedOut ? 'TIMEOUT' : 'ABORTED'))
    if (inner.signal.aborted) fail()
    else inner.signal.addEventListener('abort', fail, { once: true })
  })
  abandoned.catch(() => undefined)
  let raw: DecisionAdapterAnswer
  try {
    raw = await Promise.race([hit.adapter.decide(target.route, req, { signal: inner.signal }), abandoned])
  } catch (e) {
    const code: AiErrorCode = timedOut ? 'TIMEOUT' : e instanceof DecisionAdapterError ? e.code : 'TRANSPORT'
    throw new DecisionError(decisionFailureKind(code, timedOut), code, target.route)
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', forward)
    inner.abort()
  }
  // An adapter is typed, but a vendor body reached it untyped; nothing below trusts the type.
  const envelope = raw as unknown as Record<string, unknown> | null | undefined
  const reported = envelope?.usage
  const answeredBy = envelope?.model
  if (
    !plainObject(envelope?.answers) ||
    typeof answeredBy !== 'string' ||
    answeredBy.length === 0 ||
    answeredBy.length > 256 ||
    !plainObject(reported) ||
    !tokenCount(reported.inputTokens) ||
    !tokenCount(reported.outputTokens)
  )
    throw new DecisionError('invalid', 'FORMAT', target.route)
  const usage = reported as DecisionUsage
  const tokens = {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
  }
  const cost = usage.costUsd
  const gateway = typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
  const credits = gateway
    ? Math.max(0, Math.round((cost as number) * deps.creditsPerUsd * 1e6) / 1e6)
    : estimateCredits(target.model, tokens, deps.creditsPerUsd)
  return {
    answers: envelope?.answers as Record<string, DecisionWireAnswer>,
    model: answeredBy,
    route: target.route,
    usage: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      ...(gateway ? { costUsd: cost as number } : {}),
    },
    credits,
    creditSource: gateway ? 'gateway' : 'estimated',
  }
}

/**
 * Assembles the model seam once, at startup. Three things happen here and nowhere else: the route
 * table is resolved to adapters, every declared credential is fetched and handed to its adapter, and
 * the registry is sealed — after which the fingerprint that identifies this assembly can no longer
 * move under a later catalogue refresh.
 *
 * `count` is present only when at least one fitted adapter can count, so a caller can tell "nobody
 * here counts" (fall back to an estimate once) from "this route does not" (answered per request).
 */
export function createProvider(opts: {
  adapters: WireAdapter[]
  /**
   * Decision adapters and the decision routes the profile declared. They go into a registry of
   * their own; the chat registry refuses them.
   */
  decision?: { adapters: readonly DecisionAdapter[]; routes: readonly RouteDecl[] }
  routes: RouteTable
  contract: ContractStore
  secrets: (ref: string) => string
  clock: () => number
  parserVersion?: string
  pricing?: { creditsPerUsd: number }
  log?: { warn: (message: string) => void }
  /**
   * Explicit API-key routes which may be configured after startup.  Every other unresolved
   * credential remains an assembly failure; an optional route fails closed with AUTH on request.
   */
  optionalCredentialRefs?: ReadonlySet<string>
}): Provider & { registry: Registry; decisionRegistry?: DecisionRegistry } {
  const registry = buildRegistry(opts.adapters)
  const decisionAdapters = opts.decision?.adapters ?? []
  const decisions =
    opts.decision && (decisionAdapters.length > 0 || opts.decision.routes.length > 0)
      ? buildDecisionRegistry(decisionAdapters, opts.decision.routes)
      : undefined
  // Route names are one namespace across both registries: a decision route that reuses a chat
  // route's name would leave every route-keyed reader unsure which of the two it meant.
  for (const { route } of decisions?.routes() ?? [])
    if (registry.lookup(route))
      throw new AiSetupError('DUPLICATE_ROUTE', { route, kinds: ['chat', 'decision'] })
  resolveCredentials(
    [...opts.adapters, ...decisionAdapters],
    opts.secrets,
    opts.optionalCredentialRefs === undefined ? {} : { optionalRefs: opts.optionalCredentialRefs },
  )
  registry.seal()
  // With no price table the factor is 1, which makes the ledger's credits column a column of
  // dollars. That is a legal reading and a dangerous default, because a per-request cap written in
  // credits is compared against this number - so an assembly is told once, rather than left to
  // discover it from a ledger. It is not an error: plenty of callers run inference without keeping
  // books, and making all of them configure a price table charges the cost to the wrong people.
  if (opts.pricing?.creditsPerUsd === undefined)
    opts.log?.warn('no pricing.creditsPerUsd: cost ledger credits will be denominated in USD')
  const deps: InferenceDeps = {
    registry,
    routes: opts.routes,
    contract: opts.contract,
    clock: opts.clock,
    parserVersion: opts.parserVersion ?? PARSER_VERSION,
    ...(decisions ? { decisions } : {}),
    get creditsPerUsd() {
      return opts.pricing?.creditsPerUsd ?? 1
    },
  }
  const anyCounts = opts.adapters.some((a) => typeof a.count === 'function')
  const provider: Provider & { registry: Registry; decisionRegistry?: DecisionRegistry } = {
    registry,
    // Guarded on the way out, not inside runInference: the guard is a property of what this facade
    // promises a caller, and tests that build the deps by hand still reach the unguarded stream.
    infer: (req, o) => guardSequence(runInference(deps, req, o)),
    models: () => registry.models(),
  }
  if (anyCounts) {
    provider.count = async (req, o): Promise<CountResult> => {
      // Unsupported means a valid selected model lacks counting, never an unknown selection.
      const selected = resolveSelection(registry, req.slot, req.route, req.model)
      const target = registry.lookup(selected.route)
      if (
        req.contractId !== selected.model.contract_id ||
        (req.contractId !== null && opts.contract.prefixHash(req.contractId) === null)
      )
        throw new AiSetupError('CONTRACT_MISMATCH')
      if (!target?.adapter.count) return { source: 'unsupported' }
      const system = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        renderPrefixedPrompt(req, opts.contract),
      )
      return target.adapter.count(req.route, { ...req, system }, o)
    }
  }
  if (decisions) {
    const decisionDeps: DecisionDeps = {
      registry,
      decisions,
      get creditsPerUsd() {
        return opts.pricing?.creditsPerUsd ?? 1
      },
    }
    provider.decisionRegistry = decisions
    provider.decide = (req, o) => runDecision(decisionDeps, req, o)
    provider.decisionModels = () => decisions.models()
  }
  return provider
}
