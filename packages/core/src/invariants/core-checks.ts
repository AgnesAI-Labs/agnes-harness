import type { CostLedger } from '../reduce/shapes.js'
import type { LedgerState } from '../reduce/state.js'
import type { Event, Seq } from '../types.js'
import type { InvariantCheck, Violation } from './registry.js'

/** Rows whose `data` is a plain object, read the way the rest of core reads an untyped event body. */
const d = (e: Event) => e.data as Record<string, unknown> | null

/** Codes that mark a synthetic `tool/result` written to close a call nobody observed settling. */
const CLOSER_CODES = new Set(['TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN'])
const EXEC_TYPES = new Set(['request/header', 'request/sent', 'plan.items', 'assistant/message'])

/**
 * The core §13 first batch, computed in one pass over the batch. Every `InvariantCheck` below is a
 * thin filter over this shared walk rather than its own traversal: the ten rules read overlapping
 * state (which lane has an open turn, which tool calls are outstanding, ...), and one pass keeps that
 * bookkeeping in one place instead of ten. Each filtered check still satisfies its own contract in
 * isolation — called alone it reports only its own rule — so nothing here leaks across the `id`
 * boundary the registry dispatches on.
 *
 * Seeded from `state` rather than starting cold, so a check run incrementally after a single append
 * still sees the turn/step/tool-call bookkeeping a full replay would have built by that point. The
 * one exception is `aborted-after-cancel`: see where its stop requests are collected.
 */
function walk(events: readonly Event[], state: LedgerState): Violation[] {
  const out: Violation[] = []
  const openTurn = new Map(state.openTurn)
  const openStep = new Map(state.openStep)
  const toolCalls = new Map(state.toolCalls)
  const intentsSeen = new Set(state.pendingEffects.keys())
  const inferenceIntents = new Map<
    Seq,
    { effectId: string; lane: string; receiptSeq?: Seq; firstOutputSeq?: Seq }
  >()
  for (const effect of state.pendingEffects.values())
    if (effect.kind === 'inference')
      inferenceIntents.set(effect.intentSeq, {
        effectId: effect.effectId,
        lane: effect.lane,
        ...(effect.receiptSeq === undefined ? {} : { receiptSeq: effect.receiptSeq }),
        ...(effect.firstOutputSeq === undefined ? {} : { firstOutputSeq: effect.firstOutputSeq }),
      })
  // A stop request is recorded by the op-mark of the transition that makes it, and the fold does not
  // carry it: the program counter is not part of the fold. So `aborted-after-cancel` holds only over
  // a batch that replays the lane from its turn start. Run on a later batch alone, an aborted
  // settlement whose cancel came earlier reports falsely; callers must not run it that way.
  const cancelRequested = new Map<string, boolean>()
  // A compaction bracket is log-wide, not per-lane: it brackets a range of the one ledger the way
  // `surfaceOp: 'replace'` brackets a range of a surface, so only one may be open at a time.
  let openBracket: { lane: string; seq: Seq } | null = null
  let expectedSeq = state.lastSeq + 1

  for (const e of events) {
    const lane = e.lane ?? 'main'

    // Resyncs off the row's own seq after flagging a gap, so one missing row produces one violation
    // instead of every row after it reading as out of place too.
    if (e.seq !== expectedSeq)
      out.push({ rule: 'seq-monotonic', seq: e.seq, message: `expected seq ${expectedSeq}, got ${e.seq}` })
    expectedSeq = e.seq + 1

    if (e.type === 'turn/start') {
      if (openTurn.has(lane))
        out.push({
          rule: 'turn-open-unique',
          seq: e.seq,
          message: `turn/start on lane ${lane} while a turn is already open`,
        })
      openTurn.set(lane, { turn: Number(d(e)?.turn), startSeq: e.seq, trigger: String(d(e)?.trigger) })
      cancelRequested.set(lane, false)
    }
    if (e.type.startsWith('step/') && !openTurn.has(lane))
      out.push({
        rule: 'step-in-turn',
        seq: e.seq,
        message: `${e.type} on lane ${lane} outside an open turn`,
      })
    if (EXEC_TYPES.has(e.type) && !openTurn.has(lane))
      out.push({
        rule: 'exec-events-in-turn',
        seq: e.seq,
        message: `${e.type} on lane ${lane} outside an open turn`,
      })

    if (e.type === 'step/start')
      openStep.set(lane, { turn: Number(d(e)?.turn), step: Number(d(e)?.step), startSeq: e.seq })
    if (e.type === 'step/end') openStep.delete(lane)

    if (e.type === 'request/header') {
      const turn = openTurn.get(lane)
      if (turn) openTurn.set(lane, { ...turn, lastHeaderSeq: e.seq })
    }
    if (e.type === 'request/sent') {
      const sources = e.sourceEventSeqs ?? []
      const [headerSeq, intentSeq] = sources
      const intent = intentSeq === undefined ? undefined : inferenceIntents.get(intentSeq)
      const valid =
        sources.length === 2 &&
        headerSeq !== undefined &&
        intentSeq !== undefined &&
        headerSeq < intentSeq &&
        intentSeq < e.seq &&
        openTurn.get(lane)?.lastHeaderSeq === headerSeq &&
        openStep.has(lane) &&
        intent?.lane === lane &&
        intent.receiptSeq === undefined &&
        intent.firstOutputSeq === undefined
      if (!valid)
        out.push({
          rule: 'request-sent-causal',
          seq: e.seq,
          message: `request/sent on lane ${lane} lacks unique current header/inference sources`,
        })
      else intent.receiptSeq = e.seq
    }
    if (e.type === 'assistant/output') {
      const effectId = d(e)?.effectId
      for (const intent of inferenceIntents.values())
        if (intent.effectId === effectId && intent.lane === lane && intent.firstOutputSeq === undefined)
          intent.firstOutputSeq = e.seq
    }
    if (e.type === 'assistant/message') {
      for (const intent of inferenceIntents.values())
        if (intent.lane === lane && intent.firstOutputSeq === undefined) intent.firstOutputSeq = e.seq
    }

    if (e.type === 'tool/call') {
      const step = openStep.get(lane)
      toolCalls.set(String(d(e)?.toolUseId), {
        seq: e.seq,
        name: String(d(e)?.name),
        turn: step?.turn ?? -1,
        step: step?.step ?? -1,
        lane,
      })
    }
    if (e.type === 'tool/result') {
      const id = String(d(e)?.toolUseId)
      const call = toolCalls.get(id)
      const step = openStep.get(lane)
      const sameStep = !!call && !!step && call.turn === step.turn && call.step === step.step
      // A synthetic closer names the call it is closing; the code alone, pointing at nothing, is not
      // an exemption. A resumed turn writes the parked call's result in a new step, so it must both be
      // a resume turn and point back at the call it is finishing.
      const closer = CLOSER_CODES.has(String(d(e)?.code)) && (e.sourceEventSeqs?.length ?? 0) > 0
      const resume =
        openTurn.get(lane)?.trigger === 'approval-resume' && !!call && !!e.sourceEventSeqs?.includes(call.seq)
      if (!sameStep && !closer && !resume)
        out.push({
          rule: 'tool-result-paired',
          seq: e.seq,
          message: `tool/result ${id} on lane ${lane} has no matching tool/call in this step`,
        })
    }

    if (e.type === 'x/core/op-mark' && d(e)?.control === 'cancel_requested') cancelRequested.set(lane, true)

    if (e.type === 'effect/intent') {
      const effectId = String(d(e)?.effectId)
      intentsSeen.add(effectId)
      if (d(e)?.kind === 'inference') inferenceIntents.set(e.seq, { effectId, lane })
    }
    if (e.type === 'effect/settled') {
      const id = String(d(e)?.effectId)
      const outcome = d(e)?.outcome
      // An aborted settlement is exempt: cancellation can race ahead of the `effect/intent` write, so
      // an effect can abort before it ever got one on the ledger. Any other outcome reaching
      // `effect/settled` did run, and running without a recorded intent is the violation.
      if (outcome !== 'aborted' && !intentsSeen.has(id))
        out.push({
          rule: 'settled-has-intent',
          seq: e.seq,
          message: `effect/settled ${id} on lane ${lane} has no prior effect/intent`,
        })
      if (outcome === 'aborted' && !cancelRequested.get(lane))
        out.push({
          rule: 'aborted-after-cancel',
          seq: e.seq,
          message: `effect ${id} on lane ${lane} settled aborted without a prior cancel_requested`,
        })
      intentsSeen.delete(id)
      for (const [intentSeq, intent] of inferenceIntents)
        if (intent.effectId === id) inferenceIntents.delete(intentSeq)
    }

    if (e.type === 'x/core/compaction-begin') {
      if (openBracket)
        out.push({
          rule: 'replace-brackets',
          seq: e.seq,
          message: `compaction-begin while the bracket opened at ${openBracket.seq} is still open`,
        })
      openBracket = { lane, seq: e.seq }
    }
    if (e.type === 'x/core/compaction-end') {
      if (!openBracket)
        out.push({
          rule: 'replace-brackets',
          seq: e.seq,
          message: 'compaction-end with no matching compaction-begin',
        })
      openBracket = null
    }
    if (typeof e.surfaceOp === 'object') {
      const seqs = e.sourceEventSeqs ?? []
      if (seqs.length === 0 || seqs[0] !== e.surfaceOp.start || seqs[seqs.length - 1] !== e.surfaceOp.end)
        out.push({
          rule: 'replace-brackets',
          seq: e.seq,
          message: `replace sourceEventSeqs do not match its [${e.surfaceOp.start}, ${e.surfaceOp.end}] range`,
        })
    }

    if (e.type === 'cost/ledger') {
      const ledger = e.data as CostLedger
      if (!ledger.tokens || (ledger.credits === undefined && ledger.creditSource !== 'estimated'))
        out.push({
          rule: 'ledger-usage-present',
          seq: e.seq,
          message: 'cost/ledger row missing tokens, or credits omitted without creditSource "estimated"',
        })
    }

    if (e.type === 'turn/end') {
      openTurn.delete(lane)
      openStep.delete(lane)
    }
  }

  return out
}

const RULES = [
  'seq-monotonic',
  'turn-open-unique',
  'step-in-turn',
  'tool-result-paired',
  'exec-events-in-turn',
  'settled-has-intent',
  'aborted-after-cancel',
  'replace-brackets',
  'ledger-usage-present',
  'request-sent-causal',
] as const

/** core's own first-batch checks, one entry per rule in `walk`, each exposing only its own rule. */
export const CORE_CHECKS: InvariantCheck[] = RULES.map((rule) => ({
  id: rule,
  check: (events, state) => walk(events, state).filter((v) => v.rule === rule),
}))
