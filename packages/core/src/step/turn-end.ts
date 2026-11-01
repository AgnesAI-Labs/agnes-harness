import { CoreError } from '@agnes/core-common/types'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import { disposeReview, isReviewCode } from '../execution/turn/review-budget.js'
import { readReviewState } from '../execution/turn/review-state.js'
import { settleSideCalls, sideCallInFlight } from '../loop/side-call-receipts.js'
import { inboxEvent } from './inbox.js'
import type { SessionImpl, TurnEndReason } from './session.js'

/** Atomically commit the original turn's ending, with user control authoritative under its writer. */
export async function commitTurnEnd(
  s: SessionImpl,
  reason: TurnEndReason,
  extra: NonNullable<Parameters<SessionImpl['endTurn']>[1]>,
) {
  const expected = s.opSeq()
  const closingTurn = s.op()?.meta
  const turnNumber = closingTurn?.turn ?? 0
  let error = extra.error
  if (!extra.sideCallsDrained && sideCallInFlight(s)) await settleSideCalls(s, expected)
  // Serialize completion with pause admission; whichever fact commits first wins.
  const seqs = await s.locked(async () => {
    if (reason === 'completed' && (await s.controls.paused()))
      throw new CoreError('E_LANE_BUSY', 'Turn completion is paused', { reason: 'CONTROL_PAUSED' })
    const reviewEnd =
      (reason === 'blocked' || reason === 'parked') &&
      ['active', 'invalid'].includes((await readReviewState(s, turnNumber)).kind)
    const controlEnd =
      reason === 'aborted' || reason === 'interrupted' || reviewEnd ? await s.controls.ending() : null
    const reviewCancelled =
      reviewEnd &&
      (controlEnd !== null || s.ac.signal.aborted || s.op()?.control.status === 'cancel_requested')
    if (
      reviewCancelled &&
      (s.op()?.meta.turn !== closingTurn?.turn || s.op()?.meta.triggerSeq !== closingTurn?.triggerSeq)
    )
      throw new CoreError('E_CAS', 'Cancelled review turn was replaced')
    if (controlEnd) reason = controlEnd.reason
    else if (reviewCancelled) reason = 'aborted'
    if (reviewCancelled && error && isReviewCode(error.code)) error = undefined
    const last = extra.lastAssistantSeq ?? s.op()?.latestAssistantSeq ?? null
    const events = extra.events
    const end = s.ev('turn/end', {
      reason,
      lastAssistantSeq: last,
      ...(error ? { error } : {}),
    })
    const seq = s.lastSeq + 1
    const rows = (() => {
      const inbox = s.latest('inbox') as Inbox | undefined
      // A steer arriving after the final boundary remains pending for the next turn.
      const carry =
        reason === 'completed' && inbox?.items.some((item) => item.target === 'next-step')
          ? [
              inboxEvent(s.lane, s.d.actor, {
                items: inbox.items.map((item) =>
                  item.target === 'next-step' ? { ...item, target: 'next-turn' as const } : item,
                ),
              }),
            ]
          : []
      return [
        ...(typeof events === 'function' ? events(seq) : (events ?? [])),
        ...carry,
        ...(controlEnd ? [controlEnd.event] : []),
        end,
      ]
    })()
    const result = await s.d.log.append(rows, {
      expectedRegisterSeq: {
        register: 'op.state',
        key: s.lane,
        seq: reviewCancelled ? s.opSeq() : expected,
      },
      opState: { lane: s.lane, data: null },
    })
    s.turn = null
    disposeReview(s)
    return result.seqs
  })
  return { seqs, reason, error, turnNumber }
}
