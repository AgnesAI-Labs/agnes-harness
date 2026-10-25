import type { ModelRequestTrace, ModelRequestTraceHandle } from '@agnes/extension-api'
import type {
  CountResult,
  DecodeRule,
  InferenceEvent,
  Provider,
  RequestBody,
  RouteTable,
} from '@agnes/protocol'
import type { WireAdapter } from './adapter.js'
import type { ContractStore } from './contract-store.js'
import { resolveCredentials } from './credentials.js'
import { createState, finish, step } from './decode/machine.js'
import { PARSER_VERSION } from './decode/rules/index.js'
import type { DecodeContext } from './decode/types.js'
import { AiSetupError } from './errors.js'
import { checkedResponse, guardSequence } from './guard.js'
import { canonicalJson, sha256Hex } from './hash.js'
import { InferenceTiming } from './inference-timing.js'
import { buildRegistry, type Registry } from './registry.js'
import { resolveSelection, SlotUnresolved } from './route.js'
import { buildStamp, renderPrefixedPrompt, type SentReport } from './stamp.js'
import { estimateBilling, estimateCredits } from './usage.js'

// A caller that says nothing still gets a bounded wait: an unbounded first-token wait is how a
// hung route turns into a hung turn.
const DEFAULT_TIMEOUT = { firstToken: 120_000, total: 600_000 }

export type InferenceDeps = {
  trace?: ModelRequestTrace
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
  const timing = new InferenceTiming(deps.clock)
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
  // A payload is content only an adapter that reads it can act on. Refused here, ahead of the trace
  // and of `sent`, so a misrouted request leaves no record of having been sent and nothing reaches
  // an adapter that would drop what the caller meant. A request without a payload is not affected.
  if (req.payload !== undefined && hit.adapter.acceptsPayload !== true) {
    yield {
      type: 'error',
      reason: 'error',
      code: 'CONTRACT_MISMATCH',
      message: 'the selected adapter does not accept a payload',
      retryable: false,
    }
    return
  }
  if (wireReq.sections && req.contractId !== null)
    wireReq.sections = [
      {
        id: 'model:contract',
        order: -1000,
        source: `model-contract:${req.contractId}`,
        text: wireReq.system.slice(0, wireReq.system.length - req.system.length - 1),
      },
      ...wireReq.sections,
    ]
  timing.prepared()
  let trace: ModelRequestTraceHandle | undefined
  try {
    let endpoint: string | null = null
    try {
      const url = new URL(hit.decl.baseUrl)
      endpoint = `${url.origin}${url.pathname}`
    } catch {
      /* Non-HTTP adapters have no endpoint identifier. */
    }
    const traceStore = deps.trace
    if (traceStore)
      trace = await timing.capture(() =>
        traceStore.begin(wireReq, {
          id: hit.adapter.id,
          version: hit.adapter.version ?? null,
          api: hit.decl.api,
          endpoint,
        }),
      )
  } catch {
    /* Passive local capture cannot interrupt a request. */
  }
  const recordEvent = (event: unknown) => {
    try {
      trace?.event(event)
    } catch {
      /* Passive capture failure cannot alter the public inference stream. */
    }
  }
  let sentReport: SentReport | undefined
  let sentEmitted = false
  const emitSent = (): InferenceEvent => {
    sentEmitted = true
    return {
      type: 'sent',
      stamp: {
        ...buildStamp(req, deps.contract, deps.parserVersion, sentReport),
        ...(trace ? { requestTraceId: trace.id } : {}),
      },
    }
  }
  // Preserve the legacy adapter-start-to-output/usage samples; new fields include local capture.
  const startedAt = deps.clock()
  let ttftMs: number | undefined
  const markFirstToken = () => {
    timing.output()
    if (ttftMs === undefined) ttftMs = Math.max(0, Math.round(deps.clock() - startedAt))
  }
  const streamOpts = {
    reportDispatch: () => timing.dispatched(),
    reportSent: (report: SentReport) => {
      if (!sentEmitted) sentReport = structuredClone(report)
    },
    reportAttempt: async (event: import('@agnes/extension-api').ModelAdapterAttemptObservation) => {
      try {
        const attempt = trace?.attempt?.bind(trace)
        if (attempt) await timing.capture(() => attempt(event))
      } catch {
        /* Passive attempt observation. */
      }
    },
    reportRequest: async (body: unknown, attemptId?: string) => {
      try {
        const handle = trace
        if (handle) await timing.capture(() => handle.wire(body, attemptId))
      } catch {
        /* A failed capture never changes transport. */
      }
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
  //
  // Reading calls out of prose is an opt-in of the model record: the recovery rules it lists, and
  // none at all when it declares native tool calling. A native model that quotes a call in its
  // answer is describing one; making it would be acting on words the model may have just declined.
  const formats = resolved.model.toolCallFormats
  const recover = formats.includes('native') ? [] : formats.filter((f): f is DecodeRule => f !== 'native')
  let ordinal = 0
  const dctx: DecodeContext = { toolNames: opts.toolNames, recover, nextOrdinal: () => ordinal++ }
  let dstate = createState()
  const flush = (): InferenceEvent[] => {
    const r = finish(dstate, dctx)
    dstate = r.state
    return r.events
  }
  let terminal = false
  let outcome: Extract<InferenceEvent, { type: 'done' | 'error' }> | undefined
  try {
    for await (const ev of hit.adapter.stream(resolved.route, wireReq, streamOpts)) {
      if (!sentEmitted) yield emitSent()
      if (terminal) break
      recordEvent(ev)
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
        const { billing: _untrustedBilling, response, ...usage } = ev
        // Credits the adapter did not state come from the gateway's own dollars when it billed the
        // request (a subscription has no per-request price to derive them from), and from the
        // catalogue otherwise. The source follows the figure: it says `gateway` only when a gateway
        // supplied the number, whatever label the adapter attached.
        const gatewayCredits =
          ev.credits === undefined && safeBilling?.source === 'gateway' && !safeBilling.subscription
            ? Math.max(0, Math.round((safeBilling.usdMicros / 1e6) * deps.creditsPerUsd * 1e6) / 1e6)
            : undefined
        yield {
          ...usage,
          ...checkedResponse(response),
          credits:
            ev.credits ?? gatewayCredits ?? estimateCredits(resolved.model, ev.tokens, deps.creditsPerUsd),
          creditSource:
            ev.credits !== undefined
              ? ev.creditSource
              : gatewayCredits !== undefined
                ? 'gateway'
                : 'estimated',
          ...(safeBilling ? { billing: safeBilling } : {}),
          timing: {
            ...timing.snapshot(false),
            ...(ttftMs !== undefined ? { ttftMs } : {}),
            durationMs: Math.max(0, Math.round(deps.clock() - startedAt)),
          },
        }
        continue
      }
      if (ev.type === 'done' || ev.type === 'error') {
        terminal = true
        timing.ended()
        if (ev.type === 'error') yield { ...ev, timing: timing.snapshot(false) }
        else outcome = ev
        break
      }
      if (ev.type === 'media') timing.output()
      yield ev
    }
    if (!sentEmitted) yield emitSent()
    if (!terminal) {
      for (const e of flush()) {
        timing.output()
        yield e
      }
      recordEvent({ type: 'error', reason: 'error', code: 'TRANSPORT' })
      timing.ended()
      yield {
        timing: timing.snapshot(false),
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
    if (!terminal) {
      recordEvent({
        type: 'error',
        reason: opts.signal.aborted ? 'aborted' : 'error',
        code: opts.signal.aborted ? 'ABORTED' : 'TRANSPORT',
      })
      timing.ended()
      yield {
        timing: timing.snapshot(false),
        type: 'error',
        reason: opts.signal.aborted ? 'aborted' : 'error',
        code: opts.signal.aborted ? 'ABORTED' : 'TRANSPORT',
        message: e instanceof Error ? e.name : 'adapter failed',
        retryable: !opts.signal.aborted,
      }
    }
  } finally {
    try {
      const handle = trace
      if (handle) await timing.capture(() => handle.finish())
    } catch {
      /* Local storage failure is isolated from inference. */
    }
  }
  if (outcome) yield { ...outcome, timing: timing.snapshot(true) }
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
  trace?: ModelRequestTrace
  adapters: WireAdapter[]
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
}): Provider & { registry: Registry } {
  const registry = buildRegistry(opts.adapters)
  resolveCredentials(
    opts.adapters,
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
    ...(opts.trace ? { trace: opts.trace } : {}),
    registry,
    routes: opts.routes,
    contract: opts.contract,
    clock: opts.clock,
    parserVersion: opts.parserVersion ?? PARSER_VERSION,
    get creditsPerUsd() {
      return opts.pricing?.creditsPerUsd ?? 1
    },
  }
  const anyCounts = opts.adapters.some((a) => typeof a.count === 'function')
  const provider: Provider & { registry: Registry } = {
    registry,
    // Guarded on the way out, not inside runInference: the guard is a property of what this facade
    // promises a caller, and tests that build the deps by hand still reach the unguarded stream.
    infer: (req, o) => guardSequence(runInference(deps, req, o)),
    models: () => registry.models(),
    describeRoute: (route, model) => {
      const hit = registry.lookup(route)
      if (!hit) return undefined
      const adapter = { id: hit.adapter.id, version: hit.adapter.version ?? null }
      // Only the host is reported. The digest stands in for everything else about where the route
      // points - path, query, userinfo - so a caller can tell that the target changed without the
      // base URL, which may carry credentials, ever leaving the facade.
      let endpointHost: string | null = null
      try {
        endpointHost = new URL(hit.decl.baseUrl).host
      } catch {
        /* A base URL that does not parse has no host to report. */
      }
      return {
        adapter,
        api: hit.decl.api,
        endpointHost,
        routeDigest: sha256Hex(
          canonicalJson({ baseUrl: hit.decl.baseUrl, api: hit.decl.api, adapter, model }),
        ),
      }
    },
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
  return provider
}
