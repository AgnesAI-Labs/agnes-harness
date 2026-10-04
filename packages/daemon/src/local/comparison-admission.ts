import { rpcError } from '@agnes/protocol'

/** A synchronous SQL read for every admission, including already-open handles and queued work. */
export function comparisonAdmissionGuard(storage: {
  assertSessionAdmitted(sessionId: string): void
}): (sessionId: string) => void {
  return (sessionId) => {
    try {
      storage.assertSessionAdmitted(sessionId)
    } catch {
      throw rpcError('SEMANTIC_REJECTED', { code: 'COMPARISON_ADMISSION_BLOCKED', sessionId })
    }
  }
}
