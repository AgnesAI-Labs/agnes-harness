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

export const UNAVAILABLE_MESSAGE = 'Selected operation is no longer available.'
export function duplicateMessage(op: string): string {
  return `${op} repeated twice with the same arguments and observation; refusing a third execution without new information.`
}
export type GuardRefusal = { code: 'UNAVAILABLE' | 'DUPLICATE_NO_PROGRESS'; message: string }

/** A step's calls may only name tools that are still offered this turn. */
export function checkAvailable(names: readonly string[], toolNames: readonly string[]): GuardRefusal | null {
  const offered = new Set(toolNames)
  return names.every((name) => offered.has(name))
    ? null
    : { code: 'UNAVAILABLE', message: UNAVAILABLE_MESSAGE }
}

/**
 * Whether the world may differ after this entry ran, whatever the call was. Deliberately counts
 * any dispatched UNKNOWN effect (even a read) as a change, which is broader than fileActivity in
 * workspace.ts, so an unclear outcome never lets a stale repeat count stand.
 */
function changedWorld(entry: HistoryEntry): boolean {
  return (
    !!entry.changed_files?.length ||
    entry.files_may_have_changed === true ||
    (entry.dispatched && entry.disposition === 'UNKNOWN')
  )
}

/**
 * Refuse a third execution of the same intent when its last two runs observed the same thing.
 * `turn` is this turn's history; the window starts after the last change made by another intent,
 * and only dispatched runs count.
 */
export function checkDuplicate(
  turn: readonly HistoryEntry[],
  intentFp: string,
  op: string,
): GuardRefusal | null {
  let start = 0
  for (let i = turn.length - 1; i >= 0; i--) {
    const entry = turn[i]
    if (entry !== undefined && entry.intentFp !== intentFp && changedWorld(entry)) {
      start = i + 1
      break
    }
  }
  const runs = turn.slice(start).filter((entry) => entry.dispatched && entry.intentFp === intentFp)
  const [prev, last] = runs.slice(-2)
  if (prev === undefined || last === undefined || prev.observationFp !== last.observationFp) return null
  return { code: 'DUPLICATE_NO_PROGRESS', message: duplicateMessage(op) }
}
