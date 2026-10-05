import type * as W from '@agnes/protocol/runtime'

export type AttemptFact = Readonly<{
  number: number
  state: 'allocated' | 'dispatching' | 'running' | 'unknown' | 'settled'
}>

export type RecoveryInput = Readonly<{
  action: W.ActionState
  attempt: AttemptFact | null
  /** The ready, visibility-gated result exists. */
  viewReady: boolean
  /** A raw receipt is stored but the visible result is not ready (Hook transform pending). */
  rawReceipt: boolean
  retry: W.RetryPolicy
  /** What the owner declared for the whole call. */
  semantics: 'idempotent' | 'receipt-query' | 'non-idempotent'
  /** Evidence from a completed lookup, or null when none was performed. */
  lookup: 'not-found-safe' | 'not-found-unsafe' | 'unknown' | null
}>

export type RecoveryStep =
  | 'none'
  | 'dispatch'
  | 'resume-allocated'
  | 'finish-view'
  | 'redeliver'
  | 'lookup'
  | 'retry-same-identity'
  | 'mark-unknown'

/** Crash recovery table. Fails closed like the legacy tool classifier: only an attempt that never left the process
 * (`allocated`, no mark_running committed) may be dispatched again; every other position needs evidence. */
export function recoveryStep(input: RecoveryInput): RecoveryStep {
  const { action, attempt } = input
  if (action === 'settled') return input.viewReady ? 'redeliver' : input.rawReceipt ? 'finish-view' : 'none'
  if (input.rawReceipt && !input.viewReady) return 'finish-view'
  if (attempt === null) return action === 'prepared' || action === 'authorized' ? 'dispatch' : 'mark-unknown'
  if (attempt.state === 'settled') return input.viewReady ? 'redeliver' : 'finish-view'
  if (attempt.state === 'allocated') return 'resume-allocated'
  // dispatching, running or unknown: bytes may have left the process.
  if (input.lookup === null) return input.semantics === 'non-idempotent' ? 'mark-unknown' : 'lookup'
  if (
    input.lookup === 'not-found-safe' &&
    (input.retry.mode === 'idempotent' || input.retry.mode === 'reconcile_first') &&
    attempt.number < input.retry.maxAttempts
  )
    return 'retry-same-identity'
  return 'mark-unknown'
}
