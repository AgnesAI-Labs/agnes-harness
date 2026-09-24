import type { Actor } from '@agnes/protocol'
import type { EventInput, Seq } from '../types.js'
import { deferredEffectId } from './deferred.js'
import { withPhase } from './op-state.js'
import type { SessionImpl, StepOutcome, TurnEndReason } from './session.js'

export type AbortResult = { seq: Seq | null; alreadyTerminal: boolean }

/**
 * Cancellation is recorded before it is delivered. The signal is in-memory and dies with the
 * process, so the row is the only thing a later reader — the next `step()`, or a fresh process —
 * has to go on: a turn marked cancelled is ended from the row no matter which controller is
 * current. Pulling the signal first would leave a window in which the work has stopped and nothing
 * on the ledger says anyone asked it to.
 */
export async function abortSession(s: SessionImpl, by: Actor): Promise<AbortResult> {
  const op = s.op()
  // No open turn leaves nothing to mark, but the caller still asked for whatever is running to
  // stop, and a `run({ until: 'idle' })` sitting between two turns is running.
  if (!op) {
    s.ac.abort()
    return { seq: null, alreadyTerminal: true }
  }
  if (op.control.status === 'cancel_requested') {
    s.ac.abort()
    return { seq: s.opSeq(), alreadyTerminal: false }
  }
  const requestedAt = new Date(s.d.clock()).toISOString()
  try {
    const seqs = await s.transition(
      [],
      withPhase(op, op.phase, { control: { status: 'cancel_requested', requestedAt, by } }),
    )
    return { seq: seqs[seqs.length - 1] as Seq, alreadyTerminal: false }
  } finally {
    // A refused write must not leave the request undelivered. The phases end a cancelled turn off
    // the signal as well as off the row, so an unrecorded cancel still stops the session instead of
    // running on with a caller who believes it was stopped.
    s.ac.abort()
  }
}

/**
 * Answers the calls the cancellation stopped from starting. Such a call has a `tool/call` on the
 * ledger and no `tool/result`, which the next request would show the model as an outstanding
 * question; a synthesized result closes it and names who cancelled it. Calls that did start are
 * left alone: their side effect may already have landed, and inventing a result for one would tell
 * the model something happened that did not.
 */
export async function drainAborted(s: SessionImpl): Promise<void> {
  const op = s.op()
  if (op?.phase.kind === 'deferred') {
    const events: EventInput[] = []
    for (const job of op.phase.jobs) {
      const effectId = deferredEffectId(job.jobId, job.toolUseId)
      if (s.state.pendingEffects.has(effectId))
        events.push(s.ev('effect/settled', { effectId, outcome: 'unknown' }))
      const callSeq = s.state.toolCalls.get(job.toolUseId)?.seq
      events.push(
        s.ev(
          'tool/result',
          {
            toolUseId: job.toolUseId,
            content: [
              {
                type: 'text',
                text: `job ${job.jobId} was still running when the turn was cancelled; its outcome is unknown`,
              },
            ],
            isError: true,
            code: 'TOOL_OUTCOME_UNKNOWN',
            enforcement: s.d.runtime.enforcement(),
            authz: { decisionId: 'n/a' },
          },
          callSeq === undefined ? {} : { sourceEventSeqs: [callSeq] },
        ),
      )
    }
    if (events.length > 0) await s.transition(events, op)
    return
  }
  if (op?.phase.kind !== 'tools') return
  const by = op.control.status === 'cancel_requested' ? op.control.by : s.d.actor
  const events: EventInput[] = []
  const calls = op.phase.batch.calls.map((c) => {
    if (c.status !== 'planned' && c.status !== 'awaiting_approval' && c.status !== 'approved') return c
    events.push(
      s.ev(
        'tool/result',
        {
          toolUseId: c.toolUseId,
          content: [{ type: 'text', text: 'cancelled before start' }],
          isError: true,
          code: 'CANCELLED',
          partial: false,
          cancelledBy: by,
          enforcement: s.d.runtime.enforcement(),
          authz: { decisionId: 'n/a' },
        },
        { sourceEventSeqs: [c.argsSeq] },
      ),
    )
    return { ...c, status: 'completed' as const }
  })
  if (events.length)
    await s.transition(events, withPhase(op, { ...op.phase, batch: { ...op.phase.batch, calls } }))
}

/**
 * Ends the turn and, when one is open, the step it is inside. `turn/end` beside an open step is
 * refused by the relation check, so a closer that writes only `turn/end` throws in precisely the
 * situations a closer exists for, and the turn is left open — the state it was there to prevent.
 */
export function closeTurn(
  s: SessionImpl,
  reason: TurnEndReason,
  extra: { error?: { code: string; message: string }; events?: EventInput[] } = {},
): Promise<Seq> {
  const step = s.state.openStep.get(s.lane)
  const events = [...(extra.events ?? [])]
  if (step) events.push(s.ev('step/end', { turn: step.turn, step: step.step }))
  return s.endTurn(reason, { ...extra, events })
}

/**
 * The one exit every cancelled phase takes. It is reached from `step()` when the counter already
 * carries the cancellation and from the tools phase when the signal cut the batch, and both need
 * the same two things: the unstarted calls answered, and a terminal row the next reader can act on.
 * A drained failure carries its error forward, so a turn cut off mid-inference still says on the
 * ledger what stopped it.
 */
export async function finishAborted(s: SessionImpl): Promise<StepOutcome> {
  await drainAborted(s)
  const op = s.op()
  if (!op) return { phase: 'terminal', reason: 'aborted' }
  const error = op.phase.kind === 'failure_drain' ? op.phase.error : undefined
  await closeTurn(s, 'aborted', error ? { error } : {})
  return { phase: 'terminal', reason: 'aborted' }
}
