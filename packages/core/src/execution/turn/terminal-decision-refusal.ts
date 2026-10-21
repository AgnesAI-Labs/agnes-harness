import { approvalRefusal } from '@agnes/core-effects/effects/approval-answer'
import type { DecisionSnapshot } from '@agnes/extension-api'
import { ROLE_APPROVAL_REFUSAL } from '../../child/roles.js'

/** A backend refusal remains distinct from a human answer and from an expired request. */
export function terminalDecisionRefusal(snapshot: DecisionSnapshot, timeoutMs: number) {
  if (snapshot.result?.code === 'delegated-approval-refused')
    return { code: 'DELEGATED_APPROVAL_REFUSED', text: ROLE_APPROVAL_REFUSAL }
  if (snapshot.result?.reason === 'unavailable' && snapshot.result.code === 'unattended-refused')
    return {
      code: 'UNATTENDED_APPROVAL_REFUSED',
      text: 'unattended-refused: nobody answered; this task is configured to refuse approval-dependent steps',
    }
  const reason =
    snapshot.invalidation?.code ?? (snapshot.result?.reason === 'stopped' ? 'stopped' : 'deadline')
  return approvalRefusal(
    reason === 'stopped' ? 'cancelled' : 'unavailable',
    reason === 'stopped' ? 'stopped' : 'deadline',
    timeoutMs,
  )
}
