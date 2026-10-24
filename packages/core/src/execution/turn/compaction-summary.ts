import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type Seq } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { pairClosed, validateReplace } from '@agnes/core-ledger/project/surface'
import type { CostLedger, TokenCounts } from '@agnes/core-ledger/reduce/shapes'
import type { HookPayloadMap, HookReturnMap } from '@agnes/extension-api'
import type { Billing, InferenceEvent, ThinkingLevel } from '@agnes/protocol'
import { childReceiptNarrative } from '../../child/receipts.js'
import { reserveTreeBudgetHandle, settleTreeSpendHandle } from '../../child/runtime-budget.js'
import { deriveRequest, requestMemoryRevision } from '../../request/derive.js'
import type { RequestBody as MintedRequestBody } from '../../request/mint.js'
import { toProviderRequest } from '../../request/to-provider.js'
import { applyBeforeRequestPatches } from '../../request/transforms.js'
import { resolvedModelRecord } from '../../step/model-tools.js'
import type { SessionImpl } from '../../step/session.js'
import { assembleRequestPrefix, boundWireInputTokens, estimateTokens, resolveModel } from './inference.js'

export type CompactionPlan = Exclude<HookReturnMap['before_compact'], null>
export type BeforeCompactPayload = HookPayloadMap['before_compact']
export type CompactPayload = HookPayloadMap['compact']

export const SUMMARY_NO_TOOLS_PREAMBLE =
  'Summarize the conversation only. Do not call any tool, emit a tool invocation, or delegate work. Return only the requested summary text.'
export type Prefix = Pick<MintedRequestBody, 'sections' | 'tools' | 'model' | 'samplingParams'> & {
  memoryRevision?: string
}
export type SummarySegment = {
  narrowNodes?: readonly SurfaceNode[]
  nodes: readonly SurfaceNode[]
  instruction: string
  wide: boolean
  quote?: { node: SurfaceNode; text: string }
  quoteEstimate?: string
}

/**
 * Why a summary is unusable. `permanent` is an answer of the wrong shape that a retry would repeat:
 * cut off, empty, calling a tool, deviating, or over its window. `retryable` is a transient provider
 * or transport failure. `config` is a compaction route that cannot work as set up (credentials,
 * model, adapter, contract, or a final error nobody classified), and `budget` includes an exhausted
 * quota: neither may be hidden behind a lossy fallback.
 */
export type SummaryFailure = 'cancelled' | 'budget' | 'config' | 'permanent' | 'retryable'
/** When two segments fail differently, the first class listed here decides. */
export const FAILURE_ORDER: readonly SummaryFailure[] = [
  'cancelled',
  'budget',
  'config',
  'permanent',
  'retryable',
]

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

export type SummaryResult = {
  text: string
  tokens: TokenCounts
  credits?: number
  creditSource: CostLedger['creditSource']
  billing?: Billing
  failed: boolean
  reservationRefused?: boolean
  failure?: SummaryFailure
  /** Why `failed`, when known; lands in `x/core/compaction-failed.reason`. */
  cause?: string
}

// Matches DeriveInput['toolCalls']'s per-item shape exactly (not a narrower projection of it): summary generation
// passes this array straight into deriveRequest as toolCalls, since a summary now replays real
// tool_result nodes and derive re-attaches each one's originating call the same way an ordinary
// turn's derivation does. toolUseId and ordinal exist for that re-attachment, not for anything read
// in this file directly.
export type ToolCallForSummary = {
  assistantSeq: Seq
  toolUseId: string
  name: string
  args: unknown
  ordinal: number
}

export const zeroTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
/** Each assistant message's call arguments, estimated as the model sees them: they are sent too. */
export function callArgsTokens(calls: readonly ToolCallForSummary[]): Map<Seq, number> {
  const out = new Map<Seq, number>()
  for (const call of calls)
    out.set(call.assistantSeq, (out.get(call.assistantSeq) ?? 0) + estimateTokens(canonicalJson(call.args)))
  return out
}

export function hookSurface(
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
      ...(node.kind === 'user'
        ? { messageKind: (node.event.data as import('@agnes/protocol').UserMessage).kind ?? 'prompt' }
        : {}),
      ...(node.pinned ? { pinned: true } : {}),
      tokensEstimate: nodeTokens(node, argsTokens),
    }
  })
}

export function nodeTokens(node: SurfaceNode, argsTokens: ReadonlyMap<Seq, number>): number {
  const data = node.event.data as { content?: Array<{ text?: string }> } | null
  const text = (data?.content ?? []).reduce((sum, block) => sum + estimateTokens(block.text ?? ''), 0)
  return text + (node.kind === 'assistant' ? (argsTokens.get(node.seq) ?? 0) : 0)
}

export function containsString(value: unknown, needle: string, depth = 0): boolean {
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
export function summaryRange(
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

export async function primaryPrefix(s: SessionImpl): Promise<Prefix> {
  const t = s.turn
  const op = s.op()
  if (!t || !op) throw new CoreError('E_RELATION', 'compaction outside an active turn')
  if (t.lastPrefix) return t.lastPrefix
  // A recovery may compact before this process sends a primary request. Build its sections and
  // disclosure without invoking a per-request patch hook for a request that is never sent.
  const ctx = s.operationContext()
  const { merged, disclosed, memoryRevision } = await assembleRequestPrefix(s, ctx, op.meta.triggerSeq)
  const target = resolveModel(s, 'primary')
  const out = deriveRequest({
    ...(memoryRevision === undefined ? {} : { memoryRevision }),
    kind: 'turn',
    merged,
    harnessEntries: [...s.state.registers.harnessEntries.values()].map((entry) => entry.value),
    surface: [],
    disclosed,
    model: {
      slot: 'primary',
      ...target,
      ...(s.preset.model.thinking.primary === undefined ? {} : { thinking: s.preset.model.thinking.primary }),
    },
    contract: s.d.contractForModel?.(target) ?? s.d.contract,
    nonce: t.nonce,
    envelopeNonceFor: (nodeSeq) => s.envelopeNonceFor(nodeSeq),
    envelopeCache: s.envelopeCache,
  })
  const revision = requestMemoryRevision(out.request)
  return {
    ...(revision === undefined ? {} : { memoryRevision: revision }),
    sections: out.request.sections,
    tools: out.request.tools,
    model: out.request.model,
    ...(out.request.samplingParams ? { samplingParams: out.request.samplingParams } : {}),
  }
}

export async function summaryRequest(
  s: SessionImpl,
  plan: CompactionPlan,
  segment: SummarySegment,
  calls: readonly ToolCallForSummary[],
  target: { route: string; model: string },
  prefix: Prefix,
  thinkingOverride?: ThinkingLevel,
) {
  const t = s.turn
  if (!t) throw new CoreError('E_RELATION', 'compaction outside an active turn')
  const thinking =
    thinkingOverride ??
    s.preset.model.thinking.compaction ??
    (prefix.samplingParams?.thinking as ThinkingLevel | undefined)
  const receipts = await childReceiptNarrative(s)
  const system = [plan.prompts.system, receipts].filter(Boolean).join('\n\n')
  const instruction = segment.wide
    ? `${SUMMARY_NO_TOOLS_PREAMBLE}\n\n${system}\n\n${segment.instruction}`
    : segment.instruction
  let derived = deriveRequest({
    kind: 'summary',
    inlineImages: {
      model: resolvedModelRecord(s.d.provider, target),
      canRead: false,
    },
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
    contract: Object.freeze({ ...(s.d.contractForModel?.(target) ?? s.d.contract) }),
    nonce: t.nonce,
    envelopeNonceFor: (nodeSeq) => s.envelopeNonceFor(nodeSeq),
    envelopeCache: s.envelopeCache,
    ...(segment.wide
      ? {
          mintedPrefix: prefix,
          ...(prefix.memoryRevision === undefined ? {} : { memoryRevision: prefix.memoryRevision }),
        }
      : {}),
    summaryPlan: {
      ...(segment.wide ? {} : { system }),
      instruction,
      ...(segment.quote ? { quote: segment.quote } : {}),
    },
  })
  derived = applyBeforeRequestPatches(derived, [
    { ext: 'core:compaction', patch: { maxTokens: plan.maxTokens } },
  ])
  const wire = toProviderRequest(derived.request, {
    sessionKey: s.key,
    derivedHash: derived.header.derived_hash,
  })
  return { derived, wire }
}

export function summaryInputTokens(wire: Awaited<ReturnType<typeof summaryRequest>>['wire']): number {
  return (
    boundWireInputTokens(wire) ??
    estimateTokens(canonicalJson({ system: wire.system, tools: wire.tools, messages: wire.messages }))
  )
}

async function summarize(
  s: SessionImpl,
  plan: CompactionPlan,
  segment: SummarySegment,
  calls: readonly ToolCallForSummary[],
  target: { route: string; model: string },
  prefix: Prefix,
  // Only the length-cutoff retry overrides the configured thinking level.
  thinkingOverride?: ThinkingLevel,
  signal = s.ac.signal,
): Promise<SummaryResult> {
  const { wire } = await summaryRequest(s, plan, segment, calls, target, prefix, thinkingOverride)
  const inputTokens = summaryInputTokens(wire)
  const projected = await s.d.runtime.billingProjected({
    tokensEstimate: inputTokens + plan.maxTokens,
    model: target.model,
  })
  const effect = s.effects.start({ kind: 'compaction', replay: 'never', slot: 'compaction' })
  const op = s.op()
  if (!op || op.phase.kind !== 'compaction') throw new CoreError('E_RELATION', 'summary outside compaction')
  await s.transition([effect.intent], (current) => {
    if (!current || current.phase.kind !== 'compaction')
      throw new CoreError('E_RELATION', 'summary outside compaction')
    return withPhase(current, {
      ...current.phase,
      effectIds: [...(current.phase.effectIds ?? []), effect.effectId],
    })
  })
  const tree = await reserveTreeBudgetHandle(
    s,
    projected.credits,
    target,
    {
      effectId: effect.effectId,
      requestHash: sha256Hex(canonicalJson(wire)),
    },
    inputTokens + plan.maxTokens,
  )
  if (tree.status === 'blocked' || tree.status === 'terminal') {
    await s.append([effect.settle('error')])
    return {
      text: '',
      tokens: zeroTokens(),
      creditSource: 'estimated',
      failed: true,
      failure: 'budget',
      reservationRefused: true,
    }
  }
  if (signal.aborted) {
    if (tree.status === 'reserved') {
      const { releaseTreeReservationHandle } = await import('../../child/runtime-budget.js')
      await releaseTreeReservationHandle(s, tree.handle)
    }
    await s.append([effect.settle('aborted')])
    return { text: '', tokens: zeroTokens(), creditSource: 'estimated', failed: true, failure: 'cancelled' }
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
    for await (const event of s.d.provider.infer(wire, {
      signal,
      retry: false,
      toolNames: segment.wide ? prefix.tools.map((tool) => tool.name) : [],
    })) {
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
  if (signal.aborted) failure = 'cancelled'
  else if (text.length === 0) fail('permanent', 'summary was empty')
  const tokens = usage?.tokens ?? {
    input: 0,
    output: estimateTokens(text),
    cacheRead: 0,
    cacheWrite: 0,
  }
  const spend: CostLedger = {
    purpose: 'compaction',
    effectId: effect.effectId,
    model: target.model,
    tokens,
    creditSource: usage?.creditSource ?? 'estimated',
    ...(usage?.credits === undefined ? {} : { credits: usage.credits }),
    ...(usage?.billing ? { billing: usage.billing } : {}),
    ...(signal.aborted ? { interrupted: true } : {}),
  }
  const recorded = await s.d.runtime.billingRecord({
    ...spend,
    sessionKey: s.key,
    lane: s.lane,
    turn: op.meta.turn,
    step: op.step,
  })
  if (!recorded && s.turn) s.turn.ledgerFailed = true
  const receipt = await s.append([
    s.ev('cost/ledger', spend),
    effect.settle(signal.aborted ? 'aborted' : failure ? 'error' : 'ok'),
  ])
  if (tree.status === 'reserved')
    await settleTreeSpendHandle(
      s,
      tree.handle,
      usage?.credits,
      receipt.firstSeq,
      usage?.credits === undefined ? 'unknown' : (usage.creditSource ?? 'estimated'),
    )
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

/**
 * Runs one summary request; if it fails specifically because it hit the max_tokens cap while
 * reasoning, retries exactly once at the lowest thinking level. Any other failure, a retry that
 * fails for a different reason, or a second cap hit is returned as-is — never a second retry, so a
 * model that genuinely cannot summarize this segment fails in one extra step instead of looping.
 */
export async function summarizeWithRetry(
  s: SessionImpl,
  plan: CompactionPlan,
  segment: SummarySegment,
  calls: readonly ToolCallForSummary[],
  target: { route: string; model: string },
  prefix: Prefix,
  signal = s.ac.signal,
): Promise<SummaryResult> {
  const first = await summarize(s, plan, segment, calls, target, prefix, undefined, signal)
  if (signal.aborted || first.failure === 'cancelled') return first
  if (segment.wide && first.cause === 'summary called a tool') {
    const nodes =
      segment.narrowNodes ??
      segment.nodes.filter((node) => node.seq >= plan.summarizeRange[0] && node.seq <= plan.summarizeRange[1])
    return summarize(s, plan, { ...segment, nodes, wide: false }, calls, target, prefix, undefined, signal)
  }
  if (first.cause !== 'summary stopped at the max_tokens cap') return first
  const configured = s.preset.model.thinking.compaction
  if (configured !== undefined && LOW_OR_BELOW_THINKING.has(configured)) return first
  return summarize(s, plan, segment, calls, target, prefix, 'low', signal)
}
