// Portions adapted from JevLoop (https://github.com/parkavenue9639/jevloop, 61e7994), Apache-2.0; modified.
import type { HistoryEntry, StepError } from './types.js'
import { fingerprint } from './util.js'

export const MAX_IDENTICAL_FAILURES = 3
export const MAX_STALE_OBSERVATIONS = 3

/**
 * Stage, operation/target anchor and stable error code. Prose, ids and timestamps stay out, so
 * nothing observable resets the counter.
 */
export function failureSignature(entry: HistoryEntry): string | null {
  const error = entry.error
  if (!error?.code) return null
  const anchor = entry.intentFp ?? fingerprint({ operation: entry.operation, target: entry.target })
  return `${error.stage}|${anchor}|${error.code}`
}

/**
 * Bounded termination for one turn: the same failure repeated, or observations that stop being
 * new. The step cap remains the final bound.
 */
export function checkNoProgress(
  turn: readonly HistoryEntry[],
): { code: 'NO_PROGRESS_LIMIT'; last: StepError | null } | null {
  let last: StepError | null = null
  for (const entry of turn) if (entry.error) last = entry.error
  const limit = { code: 'NO_PROGRESS_LIMIT', last } as const

  const counts = new Map<string, number>()
  for (const entry of turn) {
    const signature = failureSignature(entry)
    if (signature === null) continue
    const count = (counts.get(signature) ?? 0) + 1
    counts.set(signature, count)
    if (count >= MAX_IDENTICAL_FAILURES) return limit
  }

  const seen = new Set<string>()
  let stale = 0
  for (const entry of turn) {
    if (entry.observationFp && !seen.has(entry.observationFp)) {
      seen.add(entry.observationFp)
      stale = 0
    } else {
      stale += 1
      if (stale >= MAX_STALE_OBSERVATIONS) return limit
    }
  }
  return null
}
