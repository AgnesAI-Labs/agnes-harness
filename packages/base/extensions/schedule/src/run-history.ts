import type { ScheduleDb } from './catalog.js'
import type { ScheduleRun, ScheduleRunOutcome } from './rules.js'
import type { RunProgress } from './run-progress.js'

/** Keep an expired predecessor visible on the next occurrence, including after it succeeds. */
export const previousApprovalExpired = (db: ScheduleDb, scheduleId: string): boolean =>
  db.get<{ reason: string }>(
    `SELECT reason FROM schedule_runs INDEXED BY schedule_runs_previous WHERE schedule_id = ? AND session_key IS NOT NULL
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

type RunRow = {
  at: number
  outcome: ScheduleRunOutcome
  session_key: string | null
  ended_at: number | null
  seq: number | null
  reason: string | null
  detail: string | null
}

export const recentRuns = (db: ScheduleDb, id: string): ScheduleRun[] =>
  db
    .all<RunRow>(
      `SELECT at, outcome, session_key, ended_at, seq, reason, detail FROM (
           SELECT *, rowid AS rid FROM schedule_runs
           WHERE rowid IN (
             SELECT rowid FROM (SELECT rowid FROM schedule_runs INDEXED BY schedule_runs_open_job WHERE schedule_id = ?
               AND outcome IN ('running', 'waiting_approval', 'needs_attention') ORDER BY rowid DESC LIMIT 20)
             UNION ALL SELECT rowid FROM (SELECT rowid FROM schedule_runs INDEXED BY schedule_runs_task WHERE schedule_id = ? ORDER BY rowid DESC LIMIT 20)
           ) ORDER BY CASE WHEN outcome IN ('running', 'waiting_approval', 'needs_attention') THEN 0 ELSE 1 END, rowid DESC LIMIT 20
         ) ORDER BY rid ASC`,
      [id, id],
    )
    .map((row) => ({
      at: row.at,
      outcome: row.outcome,
      ...(['failed', 'waiting_approval', 'needs_attention'].includes(row.outcome) ||
      row.reason === 'previous_approval_expired'
        ? { needsAttention: true }
        : {}),
      ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.seq === null ? {} : { seq: row.seq }),
      ...(row.reason === null ? {} : { reason: row.reason }),
      ...(row.detail === null ? {} : { detail: row.detail }),
    }))
