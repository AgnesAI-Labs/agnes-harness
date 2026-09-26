import type { HookPayloadMap, HookReturnMap } from '@agnes/extension-api'
import type { Billing, InferenceEvent, ThinkingLevel } from '@agnes/protocol'
import { settleTreeSpend } from '../child/runtime-budget.js'
import type { SurfaceNode } from '../project/surface.js'
import { pairClosed, validateReplace } from '../project/surface.js'
import type { CostLedger, TokenCounts } from '../reduce/shapes.js'
import { deriveRequest } from '../request/derive.js'
import { canonicalJson } from '../request/hash.js'
import { toProviderRequest } from '../request/to-provider.js'
import { applyBeforeRequestPatches } from '../request/transforms.js'
import { CoreError, type EventInput, type Seq } from '../types.js'
import { quoteBudget } from './calibrate.js'
import { elideSpan } from './compaction-elide.js'
import {
  compactionTriggerTokens,
  contextTokens,
  contextWindowFor,
  lastCacheHint,
  reserveTreeBudget,
} from './gate.js'
import { estimateTokens, resolveModel, surfaceToolCalls } from './inference.js'
import { type OpStateObj, type OpStatePhase, withPhase } from './op-state.js'
import type { CompactionPort, SessionImpl, StepOutcome } from './session.js'

export type CompactionPlan = Exclude<HookReturnMap['before_compact'], null>
export type BeforeCompactPayload = HookPayloadMap['before_compact']
export type CompactPayload = HookPayloadMap['compact']

type RunnerOptions = {
  plan(
    payload: BeforeCompactPayload,
    config: Readonly<{ keepRecentTokens: number }>,
  ): Promise<CompactionPlan | null>
  onCompact(payload: CompactPayload): Promise<void>
}

const HYSTERESIS_MARGIN_FRACTION = 0.5
const CACHE_WARM_RATIO = 0.5

function isCacheWarm(cache?: { cacheRead: number; input: number }): boolean {
  if (!cache) return false
  const total = cache.cacheRead + cache.input
  return total > 0 && cache.cacheRead / total >= CACHE_WARM_RATIO
}

/** The policy half is injected; this class owns only threshold and overflow mechanism decisions. */
export class CompactionRunner implements CompactionPort {
  readonly runnable = true
  // Session-lifetime, not durable: the worst a process restart costs is losing one deferral (the
  // very next over-threshold check compacts immediately instead of waiting), never the reverse. A
  // durable flag would need a ledger row of its own for a one-shot grace period that is cheap to
  // simply redo if a restart happens to land inside it.
  private deferredOnce = false
  // Not durable, for the same reason: consecutive transient summary failures of threshold
  // compactions within one turn. A restart forgets them, which costs at most one more retry.
  transientFailures = 0
  transientTurn: number | undefined

  constructor(readonly options: RunnerOptions) {}

  shouldCompact(p: {
    contextTokens: number
    contextWindow: number
    reserveTokens: number
    cache?: { cacheRead: number; input: number }
  }): boolean {
    if (!Number.isFinite(p.reserveTokens) || p.reserveTokens < 0)
      throw new CoreError('E_ENVELOPE', 'compaction reserveTokens must be nonnegative')
    const over = p.contextTokens - (p.contextWindow - p.reserveTokens)
    if (over <= 0) {
      this.deferredOnce = false
      return false
    }
    // "Marginal" is scaled to the preset's own declared safety margin rather than an absolute
    // token count, so a preset with a small reserve does not get a proportionally huge grace band
    // and one with a large reserve does not get a proportionally tiny one.
    const marginal = over <= p.reserveTokens * HYSTERESIS_MARGIN_FRACTION
    if (marginal && isCacheWarm(p.cache) && !this.deferredOnce) {
      // One more request gets to spend the warm cache it is about to lose; the next
      // over-threshold check, whichever turn it falls in, compacts regardless of warmth.
      this.deferredOnce = true
      return false
    }
    this.deferredOnce = false
    return true
  }

  onOverflow(): 'compaction' {
    return 'compaction'
  }
}

/**
 * Why a summary is unusable. `permanent` is an answer of the wrong shape that a retry would repeat:
 * cut off, empty, calling a tool, deviating, or over its window. `retryable` is a transient provider
 * or transport failure. `config` is a compaction route that cannot work as set up (credentials,
 * model, adapter, contract, or a final error nobody classified), and `budget` includes an exhausted
 * quota: neither may be hidden behind a lossy fallback.
 */
type SummaryFailure = 'cancelled' | 'budget' | 'config' | 'permanent' | 'retryable'
/** When two segments fail differently, the first class listed here decides. */
const FAILURE_ORDER: readonly SummaryFailure[] = ['cancelled', 'budget', 'config', 'permanent', 'retryable']

const CONFIG_CODES = new Set([
  'AUTH',
  'NO_MODEL',
  'NO_ADAPTER',
  'FORMAT',
  'CONTRACT_MISMATCH',
  'SECRET_UNRESOLVED',
  'INVALID_BASE_URL',
  'DUPLICATE_ROUTE',
  'UNSEALED',
])

/** The class of a provider failure by its code; `retryable` decides only for codes with no class. */
function classify(code: string | undefined, retryable: boolean): SummaryFailure {
  if (code === 'QUOTA') return 'budget'
  if (code === 'OVERFLOW') return 'permanent'
  if (code !== undefined && CONFIG_CODES.has(code)) return 'config'
  return retryable ? 'retryable' : 'config'
}

type SummaryResult = {
  text: string
  tokens: TokenCounts
  credits?: number
  creditSource: CostLedger['creditSource']
  billing?: Billing
  failed: boolean
  failure?: SummaryFailure
  /** Why `failed`, when known; lands in `x/core/compaction-failed.reason`. */
  cause?: string
}

// Matches DeriveInput['toolCalls']'s per-item shape exactly (not a narrower projection of it): C1
// passes this array straight into deriveRequest as toolCalls, since a summary now replays real
// tool_result nodes and derive re-attaches each one's originating call the same way an ordinary
// turn's derivation does. toolUseId and ordinal exist for that re-attachment, not for anything read
// in this file directly.
type ToolCallForSummary = {
  assistantSeq: Seq
  toolUseId: string
  name: string
  args: unknown
  ordinal: number
}

const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  ...(a.reasoning !== undefined || b.reasoning !== undefined
    ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
    : {}),
})

/** Each assistant message's call arguments, estimated as the model sees them: they are sent too. */
function callArgsTokens(calls: readonly ToolCallForSummary[]): Map<Seq, number> {
  const out = new Map<Seq, number>()
  for (const call of calls)
    out.set(call.assistantSeq, (out.get(call.assistantSeq) ?? 0) + estimateTokens(canonicalJson(call.args)))
  return out
}

function hookSurface(
  surface: readonly SurfaceNode[],
  argsTokens: ReadonlyMap<Seq, number>,
): ReturnType<BeforeCompactPayload['getSurface']> {
  return surface.map((node) => {
    const type =
      node.kind === 'summary'
        ? 'summary'
        : node.kind === 'tool_result'
          ? 'tool/result'
          : node.kind === 'assistant'
            ? 'assistant/message'
            : 'user/message'
    return {
      seq: node.seq,
      type,
      ...(node.pinned ? { pinned: true } : {}),
      tokensEstimate: nodeTokens(node, argsTokens),
    }
  })
}

function nodeTokens(node: SurfaceNode, argsTokens: ReadonlyMap<Seq, number>): number {
  const data = node.event.data as { content?: Array<{ text?: string }> } | null
  const text = (data?.content ?? []).reduce((sum, block) => sum + estimateTokens(block.text ?? ''), 0)
  return text + (node.kind === 'assistant' ? (argsTokens.get(node.seq) ?? 0) : 0)
}

function containsString(value: unknown, needle: string, depth = 0): boolean {
  if (depth > 32) return false
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some((child) => containsString(child, needle, depth + 1))
  return value && typeof value === 'object'
    ? Object.values(value).some((child) => containsString(child, needle, depth + 1))
    : false
}

/**
 * Resolves the plan to the span one replace masks: the main range and, for a split turn, the prefix
 * right after it. The span is judged as a whole, and each range again on its own, because each goes
 * to the model as its own message sequence.
 */
function summaryRange(
  plan: CompactionPlan,
  surface: readonly SurfaceNode[],
): { start: Seq; end: Seq; seqs: Seq[]; nodes: SurfaceNode[]; prefixNodes?: SurfaceNode[] } {
  const start = plan.previousSummarySeq ?? plan.summarizeRange[0]
  const keep = surface.findIndex((node) => node.seq === plan.keepFromSeq)
  const from = surface.findIndex((node) => node.seq === start)
  const to = surface.findIndex((node) => node.seq === plan.summarizeRange[1])
  if (keep < 0 || from < 0 || to < from || keep <= to)
    throw new CoreError('E_SURFACE_RANGE', 'compaction plan does not preserve keepFromSeq', {
      start,
      end: plan.summarizeRange[1],
      keepFromSeq: plan.keepFromSeq,
    })
  let spanTo = to
  if (plan.turnPrefixRange) {
    if (plan.prompts.prefix === undefined)
      throw new CoreError('E_ENVELOPE', 'turnPrefixRange requires a prefix prompt')
    const prefixFrom = surface.findIndex((node) => node.seq === plan.turnPrefixRange?.[0])
    spanTo = surface.findIndex((node) => node.seq === plan.turnPrefixRange?.[1])
    if (prefixFrom !== to + 1 || spanTo < prefixFrom || spanTo >= keep)
      throw new CoreError('E_SURFACE_RANGE', 'turnPrefixRange must bridge the main range and kept suffix')
  }
  const span = surface.slice(from, spanTo + 1)
  const end = span.at(-1)?.seq as Seq
  const seqs = span.map((node) => node.seq)
  validateReplace({ start, end }, seqs, surface, new Map(surface.map((node) => [node.seq, node.event])))
  if (!pairClosed(surface, from, to) || (spanTo > to && !pairClosed(surface, to + 1, spanTo)))
    throw new CoreError('E_SURFACE_RANGE', 'replace range splits a tool call from its result', { start, end })
  if (!Number.isSafeInteger(plan.maxTokens) || plan.maxTokens < 1)
    throw new CoreError('E_ENVELOPE', 'compaction maxTokens must be a positive integer')
  const nodes = surface.slice(from, to + 1)
  return spanTo === to
    ? { start, end, seqs, nodes }
    : { start, end, seqs, nodes, prefixNodes: span.slice(nodes.length) }
}

async function summarize(
  s: SessionImpl,
  plan: CompactionPlan,
  segment: { nodes: readonly SurfaceNode[]; instruction: string },
  calls: readonly ToolCallForSummary[],
  target: { route: string; model: string },
  // Set only by summarizeWithRetry() for the one length-cutoff retry: overrides whatever
  // preset.model.thinking.compaction says, so the retry actually spends less on reasoning.
  thinkingOverride?: ThinkingLevel,
): Promise<SummaryResult> {
  const t = s.turn
  if (!t) throw new CoreError('E_RELATION', 'compaction outside an active turn')
  const contract = Object.freeze({ ...(s.d.contractForModel?.(target) ?? s.d.contract) })
  const thinking = thinkingOverride ?? s.preset.model.thinking.compaction
  await s.ensureEnvelopeEpochs()
  let derived = deriveRequest({
    kind: 'summary',
    merged: { tools: [], sections: [], runtimeContext: {}, conflicts: [] },
    harnessEntries: [],
    surface: segment.nodes,
    disclosed: [],
    toolCalls: calls,
    model: {
      slot: 'compaction',
      ...target,
      ...(thinking === undefined ? {} : { thinking }),
    },
    contract,
    nonce: t.nonce,
    envelopeNonceFor: (nodeSeq) => s.envelopeNonceFor(nodeSeq),
    envelopeCache: s.envelopeCache,
    summaryPlan: { system: plan.prompts.system, instruction: segment.instruction },
  })
  derived = applyBeforeRequestPatches(derived, [
    { ext: 'core:compaction', patch: { maxTokens: plan.maxTokens } },
  ])
  const wire = toProviderRequest(derived.request, {
    sessionKey: s.key,
    derivedHash: derived.header.derived_hash,
  })
  const projected = await s.d.runtime.ledgerProjected({
    tokensEstimate: estimateTokens(segment.instruction),
    model: target.model,
  })
  const tree = await reserveTreeBudget(s, projected.credits, target, estimateTokens(segment.instruction))
  if (tree !== 'ok')
    return {
      text: '',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      creditSource: 'estimated',
      failed: true,
      failure: 'budget',
    }
  let text = ''
  let usage: Extract<InferenceEvent, { type: 'usage' }> | undefined
  let failure: SummaryFailure | undefined
  let cause: string | undefined
  const fail = (kind: SummaryFailure, why: string) => {
    failure ??= kind
    cause ??= why
  }
  try {
    for await (const event of s.d.provider.infer(wire, { signal: s.ac.signal, toolNames: [] })) {
      if (event.type === 'text_delta') text += event.delta
      else if (event.type === 'usage') usage = event
      // A reasoning model can spend the whole budget before (or while) writing: an empty summary
      // fails anyway, but a cut-off one would otherwise replace the history it was meant to keep.
      else if (event.type === 'done' && event.reason === 'length')
        fail('permanent', 'summary stopped at the max_tokens cap')
      else if (event.type === 'toolcall_end') fail('permanent', 'summary called a tool')
      else if (event.type === 'deviation') fail('permanent', 'summary deviated from the contract')
      else if (event.type === 'error') {
        // Only a closed-shape code travels on: it ends up in a ledger row and an assistant message.
        const code = /^[A-Z0-9_]{1,32}$/.test(event.code) ? event.code : 'UNKNOWN'
        fail(classify(event.code, event.retryable), `summary provider error ${code}`)
        break
      }
    }
  } catch (error) {
    // A throw is treated as transport trouble unless it names a code that says otherwise.
    const raw = (error as { code?: unknown } | null)?.code
    const code = typeof raw === 'string' && /^[A-Z0-9_]{1,32}$/.test(raw) ? raw : undefined
    fail(classify(code, true), code ? `summary provider error ${code}` : 'summary transport failed')
  }
  if (s.ac.signal.aborted) failure = 'cancelled'
  else if (text.length === 0) fail('permanent', 'summary was empty')
  const tokens = usage?.tokens ?? {
    input: 0,
    output: estimateTokens(text),
    cacheRead: 0,
    cacheWrite: 0,
  }
  await settleTreeSpend(s, usage?.credits, (s.lastSeq + 1) as Seq)
  return {
    text,
    tokens,
    ...(usage?.credits !== undefined ? { credits: usage.credits } : {}),
    creditSource: usage?.creditSource ?? 'estimated',
    ...(usage?.billing ? { billing: usage.billing } : {}),
    failed: failure !== undefined,
    ...(failure ? { failure } : {}),
    ...(cause ? { cause } : {}),
  }
}

// Levels at or below 'low' would not free up any more of the summary budget for text after
// reasoning than a 'low' retry already would, so a max_tokens-cap cutoff at one of these is not
// retried — it would just repeat the same outcome.
const LOW_OR_BELOW_THINKING: ReadonlySet<ThinkingLevel> = new Set(['off', 'minimal', 'low'])

/** Combines two real inference attempts' cost into one record — both consumed real budget, so
 * neither is dropped even though only the second attempt's text/outcome is kept. */
function mergeSummaryResults(first: SummaryResult, retry: SummaryResult): SummaryResult {
  const attempts = [first, retry]
  const tokens = attempts.reduce((sum, r) => addTokens(sum, r.tokens), zeroTokens())
  const credits = attempts.reduce<number | undefined>(
    (sum, r) => (r.credits === undefined ? sum : (sum ?? 0) + r.credits),
    undefined,
  )
  const creditSource = attempts.every((r) => r.creditSource === 'gateway') ? 'gateway' : 'estimated'
  const billings = attempts.flatMap((r) => (r.billing ? [r.billing] : []))
  const billing: Billing | undefined =
    billings.length === 0
      ? undefined
      : {
          usdMicros: billings.reduce((sum, value) => sum + value.usdMicros, 0),
          source: billings.every((value) => value.source === 'gateway') ? 'gateway' : 'estimated',
          subscription: billings.every((value) => value.subscription),
        }
  return {
    ...retry,
    tokens,
    ...(credits === undefined ? {} : { credits }),
    creditSource,
    ...(billing ? { billing } : {}),
  }
}

/**
 * Runs one summary request; if it fails specifically because it hit the max_tokens cap while
 * reasoning, retries exactly once at the lowest thinking level. Any other failure, a retry that
 * fails for a different reason, or a second cap hit is returned as-is — never a second retry, so a
 * model that genuinely cannot summarize this segment fails in one extra step instead of looping.
 */
async function summarizeWithRetry(
  s: SessionImpl,
  plan: CompactionPlan,
  segment: { nodes: readonly SurfaceNode[]; instruction: string },
  calls: readonly ToolCallForSummary[],
  target: { route: string; model: string },
): Promise<SummaryResult> {
  const first = await summarize(s, plan, segment, calls, target)
  if (first.cause !== 'summary stopped at the max_tokens cap') return first
  const configured = s.preset.model.thinking.compaction
  if (configured !== undefined && LOW_OR_BELOW_THINKING.has(configured)) return first
  const retry = await summarize(s, plan, segment, calls, target, 'low')
  return mergeSummaryResults(first, retry)
}

function failedPhase(phase: Extract<OpStatePhase, { kind: 'compaction' }>, message: string): OpStatePhase {
  return phase.reason === 'overflow'
    ? { kind: 'failure_drain', error: { code: 'OVERFLOW', message }, provenance: { kind: 'inference' } }
    : (phase.resumeAfter as OpStatePhase)
}

async function leaveWithoutEffect(s: SessionImpl, op: OpStateObj, message: string): Promise<StepOutcome> {
  if (op.phase.kind !== 'compaction') return { phase: 'checkpoint' }
  await s.transition(
    [s.ev('x/core/compaction-failed', { reason: message }, { ignorable: true })],
    withPhase(op, failedPhase(op.phase, message)),
  )
  return op.phase.reason === 'overflow' ? { phase: 'failure_drain' } : { phase: 'checkpoint' }
}

type CompactionPhase = Extract<OpStatePhase, { kind: 'compaction' }>

/** One planned compaction, as far as writing its replace needs to know. */
type Attempt = {
  phase: CompactionPhase
  plan: CompactionPlan
  replace: ReturnType<typeof summaryRange>
  calls: readonly ToolCallForSummary[]
  argsTokens: ReadonlyMap<Seq, number>
  tokensBefore: number
}

/** The model call a compaction made: its effect, still to be settled, and what it cost. */
type SummaryCall = { effect: ReturnType<SessionImpl['effects']['start']>; spend: CostLedger }

// Consecutive transient threshold failures before the elided compaction replaces another retry.
const MAX_TRANSIENT_FAILURES = 2

const spanTokens = (a: Attempt): number =>
  [...a.replace.nodes, ...(a.replace.prefixNodes ?? [])].reduce(
    (sum, node) => sum + nodeTokens(node, a.argsTokens),
    0,
  )

/**
 * Whether a failed summary is replaced by the elided compaction. A cancelled, budget-refused or
 * misconfigured one never is. A permanent failure always is. A transient one is during overflow, where waiting is not
 * an option; for a manual request the person asking decides; for a threshold compaction it is
 * retried at the next step unless it already failed that way, or the window is nearly full.
 */
function elides(
  s: SessionImpl,
  phase: CompactionPhase,
  failure: SummaryFailure,
  contextWindow: number,
): boolean {
  if (failure !== 'permanent' && failure !== 'retryable') return false
  if (failure === 'permanent' || phase.reason === 'overflow') return true
  if (phase.reason === 'requested') return false
  const runner = s.compaction as CompactionRunner
  return (
    runner.transientFailures + 1 >= MAX_TRANSIENT_FAILURES ||
    contextWindow - compactionTriggerTokens(s) < s.preset.compaction.reserveTokens / 2
  )
}

/**
 * Where a completed compaction resumes. A checkpoint resumes as already checked against the
 * threshold: until the next request reports its real size, the context count still reflects what
 * was just masked, and checking it again would compact or quote a second time on a stale number.
 */
function resumed(phase: CompactionPhase): OpStatePhase {
  const next = phase.resumeAfter as OpStatePhase
  return next.kind === 'checkpoint' ? { ...next, thresholdCheckedSeq: next.triggerSeq } : next
}

function beginEvent(
  s: SessionImpl,
  a: Attempt,
  extra: Record<string, unknown>,
  tail: Record<string, unknown> = {},
) {
  return s.ev(
    'x/core/compaction-begin',
    {
      ...extra,
      range: [a.replace.start, a.replace.end],
      tokensBefore: a.tokensBefore,
      details: a.plan.details,
      ...(a.plan.customInstructions ? { customInstructions: a.plan.customInstructions } : {}),
      ...tail,
    },
    { ignorable: true },
  )
}

function replaceEvent(s: SessionImpl, a: Attempt, text: string, origin: 'model' | 'system') {
  return s.ev(
    'assistant/message',
    { content: [{ type: 'text', text }], stopReason: 'end_turn' },
    {
      origin,
      surfaceOp: { op: 'replace', start: a.replace.start, end: a.replace.end },
      sourceEventSeqs: a.replace.seqs,
    },
  )
}

/** Writes one replace with its bracket in a single transaction, then tells the compact observer. */
async function commitReplace(
  s: SessionImpl,
  a: Attempt,
  events: EventInput[],
  replaceIndex: number,
): Promise<StepOutcome> {
  const current = s.op() as OpStateObj
  const seqs = await s.transition(events, withPhase(current, resumed(a.phase)))
  ;(s.compaction as CompactionRunner).transientFailures = 0
  const compactPayload: CompactPayload = {
    replaceSeq: seqs[replaceIndex] as Seq,
    range: [a.replace.start, a.replace.end],
    tokensBefore: a.tokensBefore,
    tokensAfter: contextTokens(s),
  }
  try {
    if (s.hooks.compact) await s.hooks.compact(compactPayload)
    else await (s.compaction as CompactionRunner).options.onCompact(compactPayload)
  } catch (error) {
    s.d.logger.warn('compact observer failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return { phase: 'checkpoint' }
}

async function settleFailed(
  s: SessionImpl,
  phase: CompactionPhase,
  call: SummaryCall,
  outcome: 'aborted' | 'error',
  message: string,
): Promise<StepOutcome> {
  const current = s.op() as OpStateObj
  await s.transition(
    [
      s.ev('cost/ledger', call.spend),
      call.effect.settle(outcome),
      s.ev(
        'x/core/compaction-failed',
        { effectId: call.effect.effectId, reason: message },
        { ignorable: true },
      ),
    ],
    withPhase(current, failedPhase(phase, message)),
  )
  return phase.reason === 'overflow' ? { phase: 'failure_drain' } : { phase: 'checkpoint' }
}

/**
 * Replaces the span with the elided record in place of a model summary: the failed call's spend and
 * error settlement, when there was a call, land in the same transaction. When even the elided record
 * is not smaller than the span, the failure it stood in for is recorded as before.
 */
async function elide(
  s: SessionImpl,
  a: Attempt,
  cause: string,
  failed: string,
  call?: SummaryCall,
): Promise<StepOutcome> {
  const shadowed = spanTokens(a)
  const nodes = [...a.replace.nodes, ...(a.replace.prefixNodes ?? [])]
  const text = elideSpan(nodes, a.calls, cause, Math.min(a.plan.maxTokens, Math.floor(shadowed / 2)))
  const size = estimateTokens(text)
  if (size >= shadowed) {
    const message = `${failed}; elided fallback not smaller (${size} >= ${shadowed} estimated tokens)`
    if (!call) return leaveWithoutEffect(s, s.op() as OpStateObj, message)
    return settleFailed(s, a.phase, call, 'error', message)
  }
  const id = call ? { effectId: call.effect.effectId } : {}
  const events: EventInput[] = [
    ...(call ? [s.ev('cost/ledger', call.spend), call.effect.settle('error')] : []),
    beginEvent(s, a, id, { mode: 'elided', cause }),
    replaceEvent(s, a, text, 'system'),
    s.ev('x/core/compaction-end', id, { ignorable: true }),
  ]
  return commitReplace(s, a, events, events.length - 2)
}

/** Executes one compaction attempt. It never closes the turn and writes at most one replace. */
export async function runCompaction(s: SessionImpl): Promise<StepOutcome> {
  const op = s.op()
  if (op?.phase.kind !== 'compaction') return { phase: 'checkpoint' }
  if (!s.compaction.runnable || !(s.compaction instanceof CompactionRunner))
    return leaveWithoutEffect(s, op, 'compaction runner unavailable')

  const phase = op.phase
  if (s.compaction.transientTurn !== op.meta.turn) {
    s.compaction.transientTurn = op.meta.turn
    s.compaction.transientFailures = 0
  }
  const surface = s.surface()
  const tokensBefore = contextTokens(s)
  const primary = resolveModel(s, 'primary')
  const contextWindow = contextWindowFor(s, primary.route, primary.model)
  const previous = surface.find((node) => node.kind === 'summary')?.seq
  const custom =
    phase.plan && typeof phase.plan === 'object' && !Array.isArray(phase.plan)
      ? (phase.plan as { customInstructions?: unknown }).customInstructions
      : undefined
  const calls: ToolCallForSummary[] = [...(await surfaceToolCalls(s))].map(
    ({ assistantSeq, toolUseId, name, args, ordinal }) => ({
      assistantSeq,
      toolUseId,
      name,
      args,
      ordinal,
    }),
  )
  const argsTokens = callArgsTokens(calls)
  const payload: BeforeCompactPayload & { toolCalls: Array<{ name: string; args: unknown }> } = {
    contextTokens: tokensBefore,
    contextWindow,
    reserveTokens: s.preset.compaction.reserveTokens,
    reason: phase.reason,
    ...(previous === undefined ? {} : { previousSummarySeq: previous }),
    ...(typeof custom === 'string' ? { customInstructions: custom } : {}),
    getSurface: () => hookSurface(surface, argsTokens),
    // The current hook contract chooses the range in this same call, so core cannot know which call
    // arguments are safe to disclose beforehand. Keep the unofficial base augmentation empty rather
    // than leaking retained-suffix paths; exact range filtering below still protects custom plans.
    toolCalls: [],
  }

  let plan: CompactionPlan | null
  try {
    const selected = s.hooks.beforeCompact
      ? await s.hooks.beforeCompact(payload)
      : ({ kind: 'unhandled' } as const)
    plan =
      selected.kind === 'handled'
        ? selected.plan
        : await s.compaction.options.plan(payload, {
            keepRecentTokens: s.preset.compaction.keepRecentTokens,
          })
  } catch (error) {
    return leaveWithoutEffect(s, op, error instanceof Error ? error.message : String(error))
  }
  if (!plan) {
    const cache = lastCacheHint(s)
    const stillOver =
      phase.reason === 'overflow' ||
      s.compaction.shouldCompact({
        contextTokens: compactionTriggerTokens(s),
        contextWindow,
        reserveTokens: s.preset.compaction.reserveTokens,
        ...(cache ? { cache } : {}),
      })
    if (stillOver) {
      const quoted = await quoteBudget(
        s,
        `context ${tokensBefore} tokens exceeds the ${contextWindow} token window and cannot be compacted`,
      )
      if (quoted !== 'ok') return { phase: 'terminal', reason: quoted.reason }
    }
    if (phase.reason === 'overflow')
      return leaveWithoutEffect(s, s.op() as OpStateObj, 'overflow cannot be compacted')
    const current = s.op() as OpStateObj
    await s.transition([], withPhase(current, phase.resumeAfter as OpStatePhase))
    return { phase: 'checkpoint' }
  }

  let replace: ReturnType<typeof summaryRange>
  try {
    replace = summaryRange(plan, surface)
  } catch (error) {
    return leaveWithoutEffect(s, op, error instanceof Error ? error.message : String(error))
  }
  const selectedPlan = plan
  const segmentCalls = calls.filter(
    (call) =>
      (call.assistantSeq >= selectedPlan.summarizeRange[0] &&
        call.assistantSeq <= selectedPlan.summarizeRange[1]) ||
      (selectedPlan.turnPrefixRange !== undefined &&
        call.assistantSeq >= selectedPlan.turnPrefixRange[0] &&
        call.assistantSeq <= selectedPlan.turnPrefixRange[1]),
  )
  // The planner sees the live surface before it chooses its cut. Narrow its path classification to
  // calls in the ranges it actually chose, so retained-suffix paths cannot leak into summary metadata.
  plan = {
    ...selectedPlan,
    details: {
      readFiles: selectedPlan.details.readFiles.filter((path) =>
        segmentCalls.some((call) => containsString(call.args, path)),
      ),
      modifiedFiles: selectedPlan.details.modifiedFiles.filter((path) =>
        segmentCalls.some((call) => containsString(call.args, path)),
      ),
    },
  }
  if (
    plan.previousSummarySeq !== undefined &&
    !surface.some((node) => node.kind === 'summary' && node.seq === plan.previousSummarySeq)
  )
    return leaveWithoutEffect(s, op, 'previousSummarySeq is not the current summary')

  const target = resolveModel(s, 'compaction')
  const window = contextWindowFor(s, target.route, target.model)
  const segments = [
    { nodes: replace.nodes, instruction: plan.prompts.history },
    ...(replace.prefixNodes
      ? [{ nodes: replace.prefixNodes, instruction: plan.prompts.prefix as string }]
      : []),
  ]
  const attempt: Attempt = { phase, plan, replace, calls, argsTokens, tokensBefore }
  // A summary request that cannot fit its own window would only spend a call to find that out.
  const fixed = plan.maxTokens + estimateTokens(plan.prompts.system)
  if (
    segments.some(
      (segment) =>
        segment.nodes.reduce((sum, node) => sum + nodeTokens(node, argsTokens), 0) +
          fixed +
          estimateTokens(segment.instruction) >
        window,
    )
  )
    return elide(s, attempt, 'preflight-overflow', 'summary request would not fit the compaction window')

  const effect = s.effects.start({ kind: 'compaction', replay: 'never', slot: 'compaction' })
  await s.transition(
    [effect.intent],
    withPhase(op, {
      ...phase,
      plan: structuredClone(plan) as never,
      effectIds: [effect.effectId],
    }),
  )

  const selected = plan
  const results = await Promise.all(
    segments.map((segment) => summarizeWithRetry(s, selected, segment, calls, target)),
  )
  const tokens = results.reduce((sum, result) => addTokens(sum, result.tokens), zeroTokens())
  const credits = results.reduce<number | undefined>(
    (sum, result) => (result.credits === undefined ? sum : (sum ?? 0) + result.credits),
    undefined,
  )
  const creditSource = results.every((result) => result.creditSource === 'gateway') ? 'gateway' : 'estimated'
  const billings = results.flatMap((result) => (result.billing ? [result.billing] : []))
  const billing =
    billings.length === 0
      ? undefined
      : {
          usdMicros: billings.reduce((sum, value) => sum + value.usdMicros, 0),
          source: billings.every((value) => value.source === 'gateway')
            ? ('gateway' as const)
            : ('estimated' as const),
          subscription: billings.every((value) => value.subscription),
        }
  const spend: CostLedger = {
    purpose: 'compaction',
    effectId: effect.effectId,
    tokens,
    ...(credits === undefined ? {} : { credits }),
    creditSource,
    model: target.model,
    ...(billing ? { billing } : {}),
    ...(s.ac.signal.aborted ? { interrupted: true } : {}),
  }
  const record = await s.d.runtime.ledgerRecord({
    ...spend,
    sessionKey: s.key,
    lane: s.lane,
    turn: op.meta.turn,
    step: op.step,
  })
  if (!record && s.turn) s.turn.ledgerFailed = true
  const call = { effect, spend }

  const failure = FAILURE_ORDER.find((kind) => results.some((result) => result.failure === kind))
  if (failure) {
    const cause = (results.find((result) => result.failure === failure) ?? results[0])?.cause
    const message = s.ac.signal.aborted
      ? 'compaction cancelled'
      : `summary request failed${cause ? `: ${cause}` : ''}`
    if (elides(s, phase, failure, contextWindow)) return elide(s, attempt, cause ?? failure, message, call)
    if (failure === 'retryable' && phase.reason === 'threshold') s.compaction.transientFailures++
    return settleFailed(s, phase, call, s.ac.signal.aborted ? 'aborted' : 'error', message)
  }

  const [mainResult, prefixResult] = results
  if (!mainResult) return leaveWithoutEffect(s, s.op() as OpStateObj, 'summary request produced no result')
  const summary = prefixResult ? `${mainResult.text}\n\n[turn prefix]\n${prefixResult.text}` : mainResult.text

  // A verbose/pathological model response could produce a "summary" larger than the content it is
  // replacing, defeating compaction and risking unbounded context growth. The model call already
  // spent real credits even though its output is unusable, so the spend is recorded either way.
  const shadowedTokens = spanTokens(attempt)
  const summaryTokens = estimateTokens(summary)
  if (summaryTokens >= shadowedTokens)
    return elide(
      s,
      attempt,
      'summary not smaller',
      `summary is not smaller than the replaced content (${summaryTokens} estimated tokens >= ${shadowedTokens} estimated tokens)`,
      call,
    )

  const events: EventInput[] = [
    beginEvent(s, attempt, { effectId: effect.effectId }),
    replaceEvent(s, attempt, summary, 'model'),
    s.ev('cost/ledger', spend),
    effect.settle('ok'),
    s.ev('x/core/compaction-end', { effectId: effect.effectId }, { ignorable: true }),
  ]
  return commitReplace(s, attempt, events, 1)
}
