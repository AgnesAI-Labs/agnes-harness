import { type SurfaceCache, validateReplace } from '../project/surface.js'
import { reduce } from '../reduce/reducer.js'
import type { LedgerState } from '../reduce/state.js'
import type { StateTracker } from '../reduce/tracker.js'
import { CoreError, type Event, type PreparedEvent, type Seq } from '../types.js'

/** Rows that only make sense inside an open turn on their lane. */
const IN_TURN = new Set([
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'request/header',
  'request/sent',
  'effect/intent',
  'effect/settled',
  'assistant/message',
  'assistant/output',
  'plan.items',
  'verifier/signal',
  'repair/decision',
  'format/deviation',
])

/** Codes that mark a synthetic result written to close a call whose outcome nobody observed. */
const CLOSER_CODES = new Set(['TOOL_NOT_STARTED', 'TOOL_OUTCOME_UNKNOWN'])

/** A row on its way to storage still has no seq; one already stored has. Both are checkable. */
type CheckedEvent = PreparedEvent & { seq?: Seq | undefined }

/**
 * Checks a batch against the state it will be appended to. The batch is simulated in order, so a row
 * may rely on one earlier in the same batch, and a rejection stops the whole batch before anything is
 * written. Rows are numbered from the state under check when storage has not numbered them yet.
 */
export function checkRelations(
  batch: readonly CheckedEvent[],
  start: LedgerState,
  surfaces?: Map<string, SurfaceCache>,
): void {
  let s = start
  for (const e of batch) {
    const lane = e.lane ?? 'main'
    const d = e.data as Record<string, unknown> | null
    // A row storage has not numbered yet is given the number it would be committed at, so both the
    // simulation and the rejection detail name a row the caller can find in the batch it handed in.
    const seq = e.seq ?? s.lastSeq + 1
    const turn = s.openTurn.get(lane)
    if (e.type === 'turn/start' && turn)
      throw new CoreError('E_LANE_BUSY', 'turn already open', { lane, seq })
    if (IN_TURN.has(e.type) && !turn)
      throw new CoreError('E_RELATION', `${e.type} outside an open turn`, { lane, seq })
    if (e.type === 'step/start') {
      if (s.openStep.has(lane)) throw new CoreError('E_RELATION', 'step already open', { lane, seq })
      // The expected number comes from the last step opened, not from the open-step map: that map is
      // empty once step/end has closed the step, and reading it would number every second step of a
      // turn back to 1.
      const expected = (s.lastStep.get(lane) ?? 0) + 1
      if (Number(d?.step) !== expected)
        throw new CoreError('E_RELATION', `step ${String(d?.step)} ≠ expected ${expected}`, { lane, seq })
    }
    if (e.type === 'tool/result') {
      const id = String(d?.toolUseId)
      const call = s.toolCalls.get(id)
      const step = s.openStep.get(lane)
      const sameStep = !!call && !!step && call.turn === step.turn && call.step === step.step
      // A synthetic closer names the call it is closing; the code alone, pointing at nothing, is not
      // an exemption.
      const closer = CLOSER_CODES.has(String(d?.code)) && !!e.sourceEventSeqs?.length
      // A resumed turn writes the parked call's result in a new step, so it must both be a resume
      // turn and point at the call it is finishing.
      const resume = turn?.trigger === 'approval-resume' && !!call && !!e.sourceEventSeqs?.includes(call.seq)
      if (!sameStep && !closer && !resume)
        throw new CoreError('E_RELATION', `tool/result ${id} without prior tool/call in this step`, {
          lane,
          seq,
        })
    }
    if (e.type === 'request/sent') {
      const sources = e.sourceEventSeqs ?? []
      const [headerSeq, intentSeq] = sources
      const pending = [...s.pendingEffects.values()].find(
        (effect) => effect.intentSeq === intentSeq && effect.kind === 'inference' && effect.lane === lane,
      )
      if (
        sources.length !== 2 ||
        headerSeq === undefined ||
        intentSeq === undefined ||
        !(headerSeq < intentSeq && intentSeq < seq) ||
        turn?.lastHeaderSeq !== headerSeq
      )
        throw new CoreError('E_RELATION', 'request/sent must source the current header then intent', {
          lane,
          seq,
        })
      if (!s.openStep.has(lane))
        throw new CoreError('E_RELATION', 'request/sent outside an open step', { lane, seq })
      if (!pending)
        throw new CoreError('E_RELATION', 'request/sent without pending inference intent', { lane, seq })
      if (pending.receiptSeq !== undefined)
        throw new CoreError('E_RELATION', 'duplicate request/sent for inference effect', { lane, seq })
      if (pending.firstOutputSeq !== undefined)
        throw new CoreError('E_RELATION', 'request/sent after model output', { lane, seq })
    }
    if (e.type === 'assistant/output') {
      const effectId = typeof d?.effectId === 'string' ? d.effectId : ''
      const pending = s.pendingEffects.get(effectId)
      if (pending?.kind !== 'inference' || pending.lane !== lane)
        throw new CoreError('E_RELATION', 'assistant/output without pending inference on its lane', {
          lane,
          seq,
        })
      // Checked against committed state, so a started row still queued behind an earlier commit is
      // not required here: the writer admits started, progress and interrupted in that order.
      if (
        d?.state === 'started' &&
        (pending.receiptSeq === undefined || pending.firstOutputSeq !== undefined)
      )
        throw new CoreError('E_RELATION', 'assistant/output started before the receipt or twice', {
          lane,
          seq,
        })
      if (d?.state !== 'started' && pending.interruptedSeq !== undefined)
        throw new CoreError('E_RELATION', 'assistant/output after the stream was recorded as cut', {
          lane,
          seq,
        })
    }
    if (e.type === 'turn/end' && s.openStep.has(lane))
      throw new CoreError('E_RELATION', 'turn/end with open step', { lane, seq })
    if (typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') {
      const cache = surfaces?.get(lane)
      // Without a cache there is no surface to judge the range against, and a replace that is not
      // judged is one that can drop rows the model still needs, so it is refused rather than waved
      // through. The range is judged against the committed surface only: rows earlier in this batch
      // have no seq yet, so none of them can be named as a boundary.
      if (!cache)
        throw new CoreError('E_SURFACE_RANGE', `no surface cache for lane ${lane} to validate a replace`, {
          lane,
          seq,
        })
      validateReplace(e.surfaceOp, e.sourceEventSeqs ?? [], cache.nodes(), cache.eventsById())
    }
    s = reduce(s, { ...e, seq } as Event)
  }
  // Checked once at the end rather than per row, because a batch legitimately opens a turn and writes
  // its op.state as two rows. A lane with one and not the other cannot be resumed: either the ledger
  // says a turn is running with no program counter, or a counter survives the turn it belonged to.
  for (const lane of new Set([...s.openTurn.keys(), ...s.registers.opState.keys()])) {
    const hasTurn = s.openTurn.has(lane)
    const hasOp = s.registers.opState.has(lane)
    if (hasTurn !== hasOp)
      throw new CoreError(
        'E_RELATION',
        `lane ${lane}: open turn (${hasTurn}) must match op.state presence (${hasOp})`,
        { lane },
      )
  }
}

export function makeRelationCheck(
  tracker: StateTracker,
  surfaces?: Map<string, SurfaceCache>,
): (events: readonly CheckedEvent[]) => void {
  return (events) => checkRelations(events, tracker.state, surfaces)
}
