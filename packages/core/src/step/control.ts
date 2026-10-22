import { withPhase } from '@agnes/core-common/step/op-state'
import type { EventInput, Seq } from '@agnes/core-common/types'
import { settlesWithin } from '@agnes/core-effects/effects/wrap'
import type { Actor } from '@agnes/protocol'
import { persistChildLifecycleStop, revokeChildLifecycle } from '../child/lifecycle.js'
import { refusalNotes } from '../execution/turn/nested-note.js'
import { deferredEffectId } from './deferred.js'
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
  revokeChildLifecycle(s)
  s.decisions.revokeScope()
  try {
    await persistChildLifecycleStop(s)
    const op = s.op()
    // No open turn leaves nothing to mark, but the caller still asked for whatever is running to
    // stop, and a `run({ until: 'idle' })` sitting between two turns is running.
    if (!op) {
      s.ac.abort()
      await s.decisions.stop()
      return { seq: null, alreadyTerminal: true }
    }
    if (op.control.status === 'cancel_requested') {
      s.ac.abort()
      await s.decisions.stop()
      return { seq: s.opSeq(), alreadyTerminal: false }
    }
    const requestedAt = new Date(s.d.clock()).toISOString()
    const seqs = await s.transition([], (cur) =>
      cur ? withPhase(cur, cur.phase, { control: { status: 'cancel_requested', requestedAt, by } }) : null,
    )
    s.ac.abort('stopped')
    return { seq: seqs[seqs.length - 1] as Seq, alreadyTerminal: false }
  } finally {
    // A refused write must not leave the request undelivered. The phases end a cancelled turn off
    // the signal as well as off the row, so an unrecorded cancel still stops the session instead of
    // running on with a caller who believes it was stopped.
    s.ac.abort()
  }
}

/** Keep the owning writer alive while cancelled producers settle, with the existing time bound. */
export async function drainClosingWork(s: SessionImpl, work: ReadonlySet<Promise<unknown>>): Promise<void> {
  if (!(await settlesWithin(Promise.allSettled([...work]), s.d.closeDrainMs ?? 30_000)))
    s.d.logger.warn('session closed with work still in flight', {
      sessionKey: s.key,
      pending: work.size,
      drainMs: s.d.closeDrainMs ?? 30_000,
    })
}

export function cancelSessionRuntimes(s: SessionImpl, cancel: readonly (() => unknown)[]): void {
  // This is a cancellation request, not a drain: a tool may await the abort itself.
  void Promise.all(cancel.map((request) => Promise.resolve().then(request))).catch((error: unknown) => {
    void s.diag('invariant', { kind: 'loop-cancel-failed', message: String(error) }).catch(() => undefined)
  })
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
  const unstarted = new Set<string>()
  for (const c of op.phase.batch.calls) {
    if (c.status !== 'planned' && c.status !== 'awaiting_approval' && c.status !== 'approved') continue
    unstarted.add(c.toolUseId)
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
      // An approved approval continuation the stop caught before it started: nothing reads that.
      ...(await refusalNotes(s, c.toolUseId, 'CANCELLED')),
    )
  }
  const calls = op.phase.batch.calls.map((c) =>
    unstarted.has(c.toolUseId) ? { ...c, status: 'completed' as const } : c,
  )
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
  const reason = (await s.controls.ending())?.reason ?? 'aborted'
  await closeTurn(s, reason, error ? { error } : {})
  return { phase: 'terminal', reason }
}
