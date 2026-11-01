import { withPhase } from '@agnes/core-common/step/op-state'
import { CoreError, type Seq } from '@agnes/core-common/types'
import { validateAgainst } from '@agnes/protocol'
import { TurnEnd } from '@agnes/protocol/gen/session-v1'
import { releaseTreeReservation } from '../../child/runtime-budget.js'
import { sessionIdentity } from '../../loop/scope.js'
import { closeTurn, finishAborted } from '../../step/control.js'
import type { SessionImpl, StepOutcome } from '../../step/session.js'
import { resumeSession } from './resume.js'
import { drainReviewWork, reviewStop, reviewStopEvents } from './review-budget.js'
import { notStartedResults } from './unknown-outcome.js'

/** Unknown effects and decisions retain reconciliation; only a settled stop becomes blocked. */
type Target = { turn: number; triggerSeq: Seq; startSeq: Seq }
const closings = new WeakMap<object, { target: Target; work: Promise<StepOutcome> }>()
const matches = (s: SessionImpl, target: Target) =>
  s.op()?.meta.turn === target.turn &&
  s.op()?.meta.triggerSeq === target.triggerSeq &&
  s.state.openTurn.get(s.lane)?.startSeq === target.startSeq
function assertTarget(s: SessionImpl, target: Target): void {
  if (!matches(s, target)) throw new CoreError('E_CAS', 'Completion review turn was replaced')
}
export function finishReview(s: SessionImpl, stop = reviewStop(s), drain = false): Promise<StepOutcome> {
  const identity = sessionIdentity(s)
  const previous = closings.get(identity)
  const meta = s.op()?.meta
  if (
    previous &&
    (!meta || (previous.target.turn === meta.turn && previous.target.triggerSeq === meta.triggerSeq))
  )
    return previous.work
  const startSeq = s.state.openTurn.get(s.lane)?.startSeq
  if (!meta || startSeq === undefined) throw new CoreError('E_RELATION', 'Completion review has no open turn')
  const target = { turn: meta.turn, triggerSeq: meta.triggerSeq, startSeq }
  const work = finishReviewBody(s, stop, drain, target).catch((error) => {
    if (matches(s, target)) throw error
    return terminalOutcome(s, target)
  })
  closings.set(identity, { target, work })
  return work
}

async function finishReviewBody(
  s: SessionImpl,
  stop: ReturnType<typeof reviewStop>,
  drain: boolean,
  target: Target,
): Promise<StepOutcome> {
  if (s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested')
    return finishAborted(s, () => assertTarget(s, target))
  if (!stop) throw new Error('Completion review closer requires its internal stop')
  if (drain) {
    await drainReviewWork(s)
    await s.waitForReviewReceipts()
  }
  assertTarget(s, target)
  if (s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested')
    return finishAborted(s, () => assertTarget(s, target))
  if (s.pendingEffects().length) await resumeSession(s)
  if (!s.op()) return terminalOutcome(s, target)
  assertTarget(s, target)
  await releaseTreeReservation(s)
  const op = s.op()
  if (!op) return terminalOutcome(s, target)
  assertTarget(s, target)
  const calls = op.phase.kind === 'tools' ? op.phase.batch.calls : []
  const pending = calls.filter((call) => ['planned', 'approved', 'awaiting_approval'].includes(call.status))
  if (pending.length)
    await s.transition(
      notStartedResults(
        s,
        pending,
        (name) => `${name} was not run: additional completion review is incomplete.`,
      ),
      (cur) => {
        assertTarget(s, target)
        return cur?.phase.kind === 'tools'
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
          : cur
      },
    )
  const uncertain =
    s.pendingEffects().length > 0 ||
    [...s.state.registers.decisionStates.values()].some(
      ({ value }) =>
        value.request.lane === s.lane && !value.consumption && !value.invalidation && !value.result,
    )
  const reason = uncertain ? 'parked' : 'blocked'
  await closeTurn(s, reason, {
    events: () => {
      assertTarget(s, target)
      return reviewStopEvents(s)
    },
    ...(uncertain ? {} : { error: { code: stop.code, message: stop.message } }),
  })
  return terminalOutcome(s, target)
}

async function terminalOutcome(s: SessionImpl, target: Target): Promise<StepOutcome> {
  const [end] = await s.d.log.scan({
    type: ['turn/start', 'turn/end'],
    lane: s.lane,
    fromSeq: target.startSeq + 1,
    order: 'asc',
    limit: 1,
  })
  if (end?.type !== 'turn/end' || !validateAgainst(TurnEnd, end.data).ok)
    throw new CoreError('E_RELATION', 'Completion review closed without a terminal fact')
  return { phase: 'terminal', reason: (end.data as TurnEnd).reason }
}
