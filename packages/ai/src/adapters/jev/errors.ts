import type { AiErrorCode } from '@agnes/protocol'

/** How one HTTP status from a decision endpoint is handled. Only 429 and 529 are retried. */
export type StatusAction = { kind: 'fail'; code: AiErrorCode } | { kind: 'retry' }

export function statusAction(status: number): StatusAction {
  if (status === 401 || status === 403) return { kind: 'fail', code: 'AUTH' }
  // The vendor's validation failure: the request this package built was wrong, which is a contract
  // problem to report, not a condition to retry.
  if (status === 422) return { kind: 'fail', code: 'CONTRACT_MISMATCH' }
  if (status === 429 || status === 529) return { kind: 'retry' }
  return { kind: 'fail', code: 'TRANSPORT' }
}

export const BACKOFF_BASE_MS = 100

/**
 * The wait before the next attempt. A retry-after in seconds or as an HTTP date is honoured; one that
 * is negative, unreadable or already past says nothing usable, so the exponential backoff applies.
 * A date must contain a letter: Date.parse reads a bare "-1" as a year.
 */
export function retryDelayMs(header: string | null, attempt: number, now: number): number {
  const backoff = BACKOFF_BASE_MS * 2 ** attempt
  if (header === null) return backoff
  const value = header.trim()
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000)
  if (/[A-Za-z]/.test(value)) {
    const at = Date.parse(value)
    if (Number.isFinite(at) && at >= now) return at - now
  }
  return backoff
}
