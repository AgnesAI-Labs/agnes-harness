import { canonicalJson } from '@agnes/core-common/request/hash'
import { type OpStateObj, type OpStatePhase, withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import type { CompactionInput, CompactionModelPort, CompactionOutput } from '@agnes/extension-api'
import { childReceiptNarrative } from '../../child/receipts.js'
import { HookBlockedError } from '../../hooks/block.js'
import { sanitize, wrapUntrusted } from '../../request/derive.js'
import { quoteBudget } from '../../step/calibrate.js'
import { elideSpan } from '../../step/compaction-elide.js'
import { CompactionRunner } from '../../step/compaction-runner.js'
import type { SessionImpl, StepOutcome } from '../../step/session.js'
import {
  compactionSettingsFor,
  compactionTriggerTokens,
  contextBudgetError,
  contextTokens,
  contextWindowFor,
  fixedPrefixTokens,
  lastCacheHint,
  nearlyFull,
} from './gate.js'
import { estimateTokens, resolveModel, surfaceToolCalls } from './inference.js'

export { CompactionRunner } from '../../step/compaction-runner.js'
export type { BeforeCompactPayload, CompactionPlan, CompactPayload } from './compaction-summary.js'

import {
  type BeforeCompactPayload,
  type CompactionPlan,
  type CompactPayload,
  callArgsTokens,
  containsString,
  FAILURE_ORDER,
  hookSurface,
  nodeTokens,
  type Prefix,
  primaryPrefix,
  SUMMARY_NO_TOOLS_PREAMBLE,
  type SummaryFailure,
  type SummarySegment,
  summarizeWithRetry,
  summaryInputTokens,
  summaryRange,
  summaryRequest,
  type ToolCallForSummary,
} from './compaction-summary.js'

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

/** The orchestration effect brackets replacement; each model attempt settles its own cost. */
type SummaryCall = { effect: ReturnType<SessionImpl['effects']['start']> }

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
  reserveTokens: number,
): boolean {
  if (failure !== 'permanent' && failure !== 'retryable') return false
  if (failure === 'permanent' || phase.reason === 'overflow') return true
  if (phase.reason === 'requested') return false
  const runner = s.compaction as CompactionRunner
  return runner.transientFailures + 1 >= MAX_TRANSIENT_FAILURES || nearlyFull(s, contextWindow, reserveTokens)
}

/**
 * The context a compaction leaves behind, from the reading it started at: the masked span goes, the
 * summary comes. It anchors the context reading until the next request measures it, so it must not
 * be the usage of the summary request, which carried a different conversation.
 */
function tokensAfter(a: Attempt, text: string): number {
  const summary = estimateTokens(text)
  return Math.max(summary, a.tokensBefore - spanTokens(a) + summary)
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
  const runner = s.compaction as CompactionRunner
  runner.transientFailures = 0
  runner.unavailableFailures = 0
  runner.suspendedThrough = 0
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
  // When set, the turn stops on this error instead of resuming.
  stop?: { code: string; message: string },
): Promise<StepOutcome> {
  const current = s.op() as OpStateObj
  await s.transition(
    [
      call.effect.settle(outcome),
      s.ev(
        'x/core/compaction-failed',
        { effectId: call.effect.effectId, reason: message },
        { ignorable: true },
      ),
    ],
    withPhase(
      current,
      stop
        ? { kind: 'failure_drain', error: stop, provenance: { kind: 'inference' } }
        : failedPhase(phase, message),
    ),
  )
  return stop || phase.reason === 'overflow' ? { phase: 'failure_drain' } : { phase: 'checkpoint' }
}

/**
 * Replaces the span with an elided record and settles the orchestration effect atomically.
 * Each attempted model request has already recorded its own spend and settlement. When even the elided record
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
    ...(call ? [call.effect.settle('error')] : []),
    beginEvent(s, a, id, { mode: 'elided', cause }),
    replaceEvent(s, a, text, 'system'),
    s.ev('x/core/compaction-end', { ...id, tokensAfter: tokensAfter(a, text) }, { ignorable: true }),
  ]
  return commitReplace(s, a, events, events.length - 2)
}

/** Convert an independent replacement into the existing validated transaction vocabulary. */
function rangePlan(range: readonly [number, number], surface: readonly SurfaceNode[]): CompactionPlan {
  const end = surface.findIndex((node) => node.seq === range[1])
  const kept = surface[end + 1]
  if (end < 0 || !kept) throw new CoreError('E_SURFACE_RANGE', 'compaction must retain a conversation suffix')
  return {
    summarizeRange: [range[0], range[1]],
    keepFromSeq: kept.seq,
    prompts: { system: '', history: '' },
    maxTokens: 1,
    details: { readFiles: [], modifiedFiles: [] },
  }
}

/** Model access for independent engines shares safe derivation, tree budget and durable spend. */
function engineModel(
  s: SessionImpl,
  surface: readonly SurfaceNode[],
  calls: readonly ToolCallForSummary[],
  prefix: Prefix,
  signal: AbortSignal,
): CompactionModelPort {
  return {
    async summarize(request, requestSignal) {
      const callSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal
      callSignal.throwIfAborted()
      const plan = {
        ...rangePlan(request.range, surface),
        prompts: { system: request.system, history: request.instruction },
        maxTokens: request.maxTokens,
      }
      const replace = summaryRange(plan, surface)
      const target = resolveModel(s, 'compaction')
      const record = s.d.provider
        .models()
        .find((record) => record.route === target.route && record.id === target.model)
      if (record?.maxTokens && record.maxTokens > 0)
        plan.maxTokens = Math.min(plan.maxTokens, record.maxTokens)
      const selectedCalls = calls.filter((call) => replace.seqs.includes(call.assistantSeq))
      const segment: SummarySegment = { nodes: replace.nodes, instruction: request.instruction, wide: false }
      const { wire } = await summaryRequest(s, plan, segment, selectedCalls, target, prefix)
      if (
        summaryInputTokens(wire) + plan.maxTokens >
        contextWindowFor(s, target.route, target.model, 'compaction')
      )
        throw new CoreError('E_ENVELOPE', 'engine summary request exceeds the compaction model window')
      const effect = s.effects.start({ kind: 'compaction', replay: 'never', slot: 'compaction' })
      const current = s.op() as OpStateObj
      if (current.phase.kind !== 'compaction')
        throw new CoreError('E_RELATION', 'engine model call outside compaction')
      await s.transition(
        [effect.intent],
        withPhase(current, {
          ...current.phase,
          effectIds: [...(current.phase.effectIds ?? []), effect.effectId],
        }),
      )
      let settled = false
      try {
        const result = await summarizeWithRetry(s, plan, segment, selectedCalls, target, prefix, callSignal)
        const recorded = !s.turn?.ledgerFailed
        await s.d.log.append([effect.settle(callSignal.aborted ? 'aborted' : result.failed ? 'error' : 'ok')])
        settled = true
        callSignal.throwIfAborted()
        if (!recorded) throw new CoreError('E_ENVELOPE', 'engine summary usage could not be recorded')
        if (result.reservationRefused) {
          await s.endTurn('budget')
          throw new CoreError('E_BUDGET', 'engine summary budget refused')
        }
        if (result.failed) throw new CoreError('E_ENVELOPE', result.cause ?? 'engine summary request failed')
        return result.text
      } finally {
        if (!settled) await s.d.log.append([effect.settle(callSignal.aborted ? 'aborted' : 'error')])
      }
    },
  }
}

/** Executes one compaction attempt and writes at most one replace. */
export async function runCompaction(s: SessionImpl, signal = s.ac.signal): Promise<StepOutcome> {
  signal = AbortSignal.any([signal, s.ac.signal])
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
  // The fixed prefix is needed before planning: the tail a plan keeps has to leave room for it.
  await s.ensureEnvelopeEpochs()
  let currentPrefix: Prefix
  try {
    // Even an empty plan must check the fixed prompt cost before quoting a budget exception.
    // When a primary request already ran, this just returns its saved prefix.
    currentPrefix = await primaryPrefix(s)
  } catch (error) {
    if (!(error instanceof HookBlockedError)) throw error
    await s.endTurn('blocked', { error: { code: 'HOOK_BLOCKED', message: error.reason } })
    return { phase: 'terminal', reason: 'blocked' }
  }
  const fixedInstructions = {
    system: currentPrefix.sections.map((section) => section.text).join('\n\n'),
    tools: currentPrefix.tools,
  }
  const contextError = contextBudgetError(s, 'primary', fixedInstructions)
  if (contextError) {
    await s.endTurn('budget', { error: contextError })
    return { phase: 'terminal', reason: 'budget' }
  }
  const { reserveTokens, keepRecentTokens } = compactionSettingsFor(
    s,
    contextWindow,
    fixedPrefixTokens(fixedInstructions),
  )
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
    reserveTokens,
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
    const starts = await scanAll((query) => s.d.log.scan(query), {
      type: 'turn/start',
      lane: s.lane,
      toSeq: s.lastSeq,
    })
    const boundaries = starts.map((event) => ({
      seq: surface.some((node) => node.seq === event.seq - 1 && node.kind === 'user')
        ? event.seq - 1
        : event.seq,
      turn: (event.data as { turn: number }).turn,
    }))
    const input: CompactionInput = {
      conversation: surface.map((node) => ({
        seq: node.seq,
        kind: node.kind,
        turn:
          node.kind === 'summary' ? 0 : (boundaries.findLast((start) => start.seq <= node.seq)?.turn ?? 0),
        pinned: node.pinned,
        tokensEstimate: nodeTokens(node, argsTokens),
        data: structuredClone(node.event.data),
      })),
      system: fixedInstructions.system,
      budget: { contextTokens: tokensBefore, contextWindow, reserveTokens, keepRecentTokens },
      beforeCompact: payload,
    }
    const output: CompactionOutput | null =
      selected.kind === 'handled'
        ? selected.plan && { kind: 'plan', plan: selected.plan }
        : await s.compaction.compact(input, {
            signal,
            model: engineModel(s, surface, calls, currentPrefix, signal),
          })
    signal.throwIfAborted()
    if (output?.kind === 'replacement') {
      if (
        typeof output.text !== 'string' ||
        !output.text.trim() ||
        !['summary', 'elision'].includes(output.mode)
      )
        throw new CoreError('E_ENVELOPE', 'engine replacement must contain text and a valid mode')
      const replacementPlan = rangePlan(output.range, surface)
      const replacement = summaryRange(replacementPlan, surface)
      const attempt: Attempt = {
        phase,
        plan: replacementPlan,
        replace: replacement,
        calls,
        argsTokens,
        tokensBefore,
      }
      if (estimateTokens(output.text) >= spanTokens(attempt))
        throw new CoreError('E_ENVELOPE', 'engine replacement is not smaller than the replaced context')
      const events = [
        beginEvent(s, attempt, {}, { mode: output.mode === 'elision' ? 'elided' : 'summary' }),
        replaceEvent(s, attempt, output.text, output.mode === 'elision' ? 'system' : 'model'),
        s.ev(
          'x/core/compaction-end',
          { tokensAfter: tokensAfter(attempt, output.text) },
          { ignorable: true },
        ),
      ]
      return commitReplace(s, attempt, events, 1)
    }
    if (output && output.kind !== 'plan')
      throw new CoreError('E_ENVELOPE', 'invalid compaction engine output')
    plan = output?.plan ?? null
  } catch (error) {
    if (!s.op() && error instanceof CoreError && error.code === 'E_BUDGET')
      return { phase: 'terminal', reason: 'budget' }
    return leaveWithoutEffect(s, s.op() as OpStateObj, error instanceof Error ? error.message : String(error))
  }
  if (!plan) {
    const cache = lastCacheHint(s)
    const triggerTokens = compactionTriggerTokens(s)
    const stillOver =
      phase.reason === 'overflow' ||
      s.compaction.shouldCompact({
        contextTokens: triggerTokens,
        contextWindow,
        reserveTokens,
        ...(cache ? { cache } : {}),
      })
    if (stillOver) {
      const quoted = await quoteBudget(
        s,
        `${
          phase.reason === 'overflow'
            ? 'Provider rejected the request as too large'
            : `context ${triggerTokens} tokens reached the ${contextWindow - reserveTokens}-token compaction threshold (${contextWindow}-token session budget, ${reserveTokens} reserved)`
        }; no earlier messages can be safely compacted. Increase the context budget or reset it to automatic.`,
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
    return leaveWithoutEffect(s, s.op() as OpStateObj, error instanceof Error ? error.message : String(error))
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
    !surface.some((node) => node.kind === 'summary' && node.seq === selectedPlan.previousSummarySeq)
  )
    return leaveWithoutEffect(s, op, 'previousSummarySeq is not the current summary')

  const target = resolveModel(s, 'compaction')
  const window = contextWindowFor(s, target.route, target.model, 'compaction')
  const outputCap = s.d.provider
    .models()
    .find((record) => record.route === target.route && record.id === target.model)?.maxTokens
  if (outputCap && outputCap > 0) plan = { ...plan, maxTokens: Math.min(plan.maxTokens, outputCap) }
  const from = surface.findIndex((node) => node.seq === replace.start)
  const primaryTarget = resolveModel(s, 'primary')
  const turn = s.turn
  if (!turn) throw new CoreError('E_RELATION', 'compaction outside an active turn')
  const prefix: Prefix =
    from === 0 && primaryTarget.route === target.route && primaryTarget.model === target.model
      ? currentPrefix
      : (turn.lastPrefix ?? {
          sections: [],
          tools: [],
          model: { slot: 'primary', ...primaryTarget },
          ...(s.preset.model.thinking.primary === undefined
            ? {}
            : { samplingParams: { thinking: s.preset.model.thinking.primary } }),
        })
  const to = surface.findIndex((node) => node.seq === replace.nodes.at(-1)?.seq)
  const spanTo = surface.findIndex((node) => node.seq === replace.end)
  const trigger = plan.turnPrefixRange
    ? surface.find((node) => node.seq === plan.turnPrefixRange?.[0])
    : undefined
  const triggerText =
    (trigger?.event.data as { content?: Array<{ text?: string }> } | undefined)?.content
      ?.map((part) => part.text ?? '')
      .join('\n') ?? ''
  const quoteText = [...triggerText].slice(0, 200).join('')
  const triggerQuote = trigger
    ? trigger.event.trust === 'untrusted'
      ? wrapUntrusted(trigger, s.envelopeNonceFor(trigger.seq) ?? turn.nonce, quoteText, -1)
      : sanitize(quoteText)
    : ''
  const candidates = [
    { nodes: replace.nodes, wideNodes: surface.slice(0, to + 1), instruction: plan.prompts.history },
    ...(replace.prefixNodes
      ? [
          {
            nodes: replace.prefixNodes,
            wideNodes: surface.slice(0, spanTo + 1),
            instruction: `${plan.prompts.prefix as string}\nOnly summarize the trailing in-progress turn opened by this request:`,
            ...(trigger
              ? { quote: { node: trigger, text: quoteText }, quoteEstimate: ` 「${triggerQuote}」` }
              : {}),
          },
        ]
      : []),
  ]
  const segments: SummarySegment[] = []
  const receipts = await childReceiptNarrative(s)
  const system = [plan.prompts.system, receipts].filter(Boolean).join('\n\n')
  const fitsWindow = (segment: SummarySegment): boolean => {
    const prefixTokens = segment.wide
      ? prefix.sections.reduce((sum, section) => sum + estimateTokens(section.text), 0) +
        estimateTokens(canonicalJson(prefix.tools))
      : estimateTokens(system)
    const instruction = segment.wide
      ? `${SUMMARY_NO_TOOLS_PREAMBLE}\n\n${system}\n\n${segment.instruction}`
      : segment.instruction
    return (
      plan.maxTokens +
        prefixTokens +
        estimateTokens(instruction + (segment.quoteEstimate ?? '')) +
        segment.nodes.reduce((sum, node) => sum + nodeTokens(node, argsTokens), 0) <=
      window
    )
  }
  for (const candidate of candidates) {
    const wide: SummarySegment = {
      nodes: candidate.wideNodes,
      narrowNodes: candidate.nodes,
      instruction: candidate.instruction,
      wide: true,
      ...('quote' in candidate ? { quote: candidate.quote, quoteEstimate: candidate.quoteEstimate } : {}),
    }
    const useWide =
      from === 0 &&
      prefix.model.model === target.model &&
      prefix.model.route === target.route &&
      fitsWindow(wide)
    const selected: SummarySegment = useWide
      ? wide
      : {
          nodes: candidate.nodes,
          instruction: candidate.instruction,
          wide: false,
          ...('quote' in candidate ? { quote: candidate.quote, quoteEstimate: candidate.quoteEstimate } : {}),
        }
    if (!fitsWindow(selected))
      return elide(
        s,
        { phase, plan, replace, calls, argsTokens, tokensBefore },
        'preflight-overflow',
        'summary request would not fit the compaction window',
      )
    segments.push(selected)
  }
  const attempt: Attempt = { phase, plan, replace, calls, argsTokens, tokensBefore }

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
  const attempts = await Promise.allSettled(
    segments.map((segment) => summarizeWithRetry(s, selected, segment, calls, target, prefix, signal)),
  )
  const rejected = attempts.find((attempt) => attempt.status === 'rejected')
  if (rejected?.status === 'rejected') {
    await s.append([effect.settle(signal.aborted ? 'aborted' : 'error')])
    throw rejected.reason
  }
  const results = attempts.flatMap((attempt) => (attempt.status === 'fulfilled' ? [attempt.value] : []))
  const call = { effect }
  if (!signal.aborted && results.some((result) => result.reservationRefused)) {
    await s.append([effect.settle('error')])
    await s.endTurn('budget')
    return { phase: 'terminal', reason: 'budget' }
  }

  const failure = signal.aborted
    ? 'cancelled'
    : FAILURE_ORDER.find((kind) => results.some((result) => result.failure === kind))
  if (failure) {
    const cause = (results.find((result) => result.failure === failure) ?? results[0])?.cause
    const message = signal.aborted
      ? 'compaction cancelled'
      : `summary request failed${cause ? `: ${cause}` : ''}`
    if (elides(s, phase, failure, contextWindow, reserveTokens))
      return elide(s, attempt, cause ?? failure, message, call)
    if (failure === 'retryable' && phase.reason === 'threshold') s.compaction.transientFailures++
    const unavailable = (failure === 'config' || failure === 'budget') && phase.reason === 'threshold'
    // A route that cannot work will not start working by the next turn: retry it ever more rarely.
    // Once the window is nearly full it is retried every turn, and a request about to be sent stops
    // with the reason instead of growing into an overflow.
    if (unavailable) s.compaction.suspend(op.meta.turn)
    const next = phase.resumeAfter as OpStatePhase
    const stop =
      unavailable &&
      next.kind === 'checkpoint' &&
      next.continuation === 'need_assistant' &&
      nearlyFull(s, contextWindow, reserveTokens)
        ? {
            code: 'COMPACTION_UNAVAILABLE',
            message: `${message}; the context window is nearly full, so the turn stopped. Fix the compaction model or its credentials, or raise or reset the context budget.`,
          }
        : undefined
    return settleFailed(s, phase, call, signal.aborted ? 'aborted' : 'error', message, stop)
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
    effect.settle('ok'),
    s.ev(
      'x/core/compaction-end',
      { effectId: effect.effectId, tokensAfter: tokensAfter(attempt, summary) },
      { ignorable: true },
    ),
  ]
  return commitReplace(s, attempt, events, 1)
}
