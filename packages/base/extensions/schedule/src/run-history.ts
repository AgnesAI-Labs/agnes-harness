import type { ScheduleDb } from './catalog.js'
import type { RunProgress } from './run-progress.js'

/** Keep an expired predecessor visible on the next occurrence, including after it succeeds. */
export const previousApprovalExpired = (db: ScheduleDb, scheduleId: string): boolean =>
  db.get<{ reason: string }>(
    `SELECT reason FROM schedule_runs WHERE schedule_id = ? AND session_key IS NOT NULL
     AND (reason IS NULL OR reason != 'approval_pending_previous_run')
     ORDER BY at DESC, rowid DESC LIMIT 1`,
    [scheduleId],
  )?.reason === 'approval_expired'

export function saveRunProgress(db: ScheduleDb, now: number, rid: number, state: RunProgress) {
  db.exec(
    `UPDATE schedule_runs SET progress = ?, outcome = ?,
     reason = COALESCE(?, CASE WHEN reason = 'previous_approval_expired' THEN reason END),
     ended_at = ? WHERE rowid = ?`,
    [
      JSON.stringify(state),
      state.outcome,
      state.reason ?? (state.needsAttention ? 'needs_attention' : null),
      ['ran', 'failed'].includes(state.outcome) ? now : null,
      rid,
    ],
  )
}
