import { withPhase } from '@agnes/core-common/step/op-state'
import { releaseTreeReservation } from '../../child/runtime-budget.js'
import { sessionIdentity } from '../../loop/scope.js'
import { closeTurn, finishAborted } from '../../step/control.js'
import type { SessionImpl, StepOutcome } from '../../step/session.js'
import { resumeSession } from './resume.js'
import { drainReviewWork, reviewStop, reviewStopEvents } from './review-budget.js'
import { notStartedResults } from './unknown-outcome.js'

/** Unknown effects and decisions retain reconciliation; only a settled stop becomes blocked. */
const closings = new WeakMap<object, { turn: number | undefined; work: Promise<StepOutcome> }>()
export function finishReview(s: SessionImpl, stop = reviewStop(s), drain = false): Promise<StepOutcome> {
  const identity = sessionIdentity(s)
  const previous = closings.get(identity)
  const turn = s.op()?.meta.turn
  if (previous && (previous.turn === turn || turn === undefined)) return previous.work
  const work = finishReviewBody(s, stop, drain)
  closings.set(identity, { turn, work })
  return work
}

async function finishReviewBody(
  s: SessionImpl,
  stop: ReturnType<typeof reviewStop>,
  drain: boolean,
): Promise<StepOutcome> {
  if (s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested') return finishAborted(s)
  if (!stop) throw new Error('Completion review closer requires its internal stop')
  if (drain) {
    await drainReviewWork(s)
    await s.waitForReviewReceipts()
  }
  if (s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested') return finishAborted(s)
  if (s.pendingEffects().length) await resumeSession(s)
  await releaseTreeReservation(s)
  const op = s.op()
  if (!op) {
    const [end] = await s.d.log.scan({ type: 'turn/end', lane: s.lane, order: 'desc', limit: 1 })
    const reason =
      (end?.data as { reason?: 'blocked' | 'parked' | 'aborted' | 'interrupted' } | undefined)?.reason ??
      'blocked'
    return { phase: 'terminal', reason }
  }
  const calls = op.phase.kind === 'tools' ? op.phase.batch.calls : []
  const pending = calls.filter((call) => ['planned', 'approved', 'awaiting_approval'].includes(call.status))
  if (pending.length)
    await s.transition(
      notStartedResults(
        s,
        pending,
        (name) => `${name} was not run: additional completion review is incomplete.`,
      ),
      (cur) =>
        cur?.phase.kind === 'tools'
          ? withPhase(cur, {
              ...cur.phase,
              batch: {
                ...cur.phase.batch,
                calls: cur.phase.batch.calls.map((call) =>
                  pending.some((p) => p.toolUseId === call.toolUseId)
                    ? { ...call, status: 'completed' as const }
                    : call,
                ),
              },
            })
          : cur,
    )
  const uncertain =
    s.pendingEffects().length > 0 ||
    [...s.state.registers.decisionStates.values()].some(
      ({ value }) =>
        value.request.lane === s.lane && !value.consumption && !value.invalidation && !value.result,
    )
  const reason = uncertain ? 'parked' : 'blocked'
  await closeTurn(s, reason, {
    events: reviewStopEvents(s),
    ...(uncertain ? {} : { error: { code: stop.code, message: stop.message } }),
  })
  return { phase: 'terminal', reason }
}
