import type { ComparisonRecord } from '@agnes/runtime-comparison'
import { ComparisonJournalError } from './comparison-journal-types.js'

const stages = ['full', 'releasing', 'released', 'removing', 'removed'] as const

/** A permanent admission fence and its readable coordinator state must never disagree. */
export function assertComparisonRetirement(
  previous: ComparisonRecord | undefined,
  next: ComparisonRecord,
): void {
  const before = previous?.retirement
  const after = next.retirement
  const from = stages.indexOf(before?.state ?? 'full')
  const to = stages.indexOf(after?.state ?? 'full')
  const invalidEpoch = (value: NonNullable<ComparisonRecord['retirement']> | undefined) =>
    value !== undefined && (!Number.isSafeInteger(value.epoch) || value.epoch < 0)
  if (
    from < 0 ||
    to < 0 ||
    invalidEpoch(before) ||
    invalidEpoch(after) ||
    to < from ||
    to > from + 1 ||
    (from > 0 && before?.epoch !== after?.epoch) ||
    (from === 0 && to > 0 && after?.epoch !== next.revision)
  )
    throw new ComparisonJournalError(
      'JOURNAL_RETIREMENT_CONFLICT',
      'Invalid comparison retirement transition',
    )
}
