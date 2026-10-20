import type { UITurn } from '@agnes/protocol'

/** Verification is a terminal qualification of an answer, not an execution failure. */
export function turnVerificationStatus(turn: UITurn | undefined) {
  if (!turn || turn.error) return undefined
  const verification = turn.verification
  if (
    !(
      (verification === 'blocked' && turn.status === 'failed' && turn.reason === 'blocked') ||
      ((verification === 'unavailable' || verification === 'unverified') &&
        turn.status === 'completed' &&
        turn.reason === 'completed')
    )
  )
    return undefined
  return {
    verification,
    labelKey:
      verification === 'unavailable' ? 'turn.status.verificationUnavailable' : 'turn.status.notVerified',
  }
}
