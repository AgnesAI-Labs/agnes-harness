import type { ScheduleDb } from './catalog.js'
import type { ScheduleRun, ScheduleView } from './rules.js'
import type { openRunReceipts } from './run-receipts.js'

type RunSnapshot = Pick<ScheduleView, 'title' | 'prompt' | 'selector' | 'target'>

/** Durable occurrence insertion and idempotent recovery share the receipt's preallocated identity. */
export function createRunWriter(
  db: ScheduleDb,
  receipts: ReturnType<typeof openRunReceipts>,
  snapshotOf: (id: string) => RunSnapshot | undefined,
) {
  return (id: string, key: string, run: ScheduleRun, runId?: string) =>
    db.transaction(() => {
      if (runId) {
        const existing = db.get<{
          rid: number
          schedule_id: string
          session_key: string | null
          outcome: string
        }>(
          'SELECT r.rowid AS rid, r.schedule_id, r.session_key, r.outcome FROM schedule_run_receipts m JOIN schedule_runs r ON r.rowid = m.run_rowid WHERE m.id = ?',
          [runId],
        )
        if (existing) {
          if (existing.schedule_id !== id || existing.session_key !== (run.sessionKey ?? null))
            throw new Error('scheduled receipt identity conflict')
          if (run.reason === 'interrupted' && ['ran', 'delivered', 'failed'].includes(existing.outcome))
            return
          db.exec(
            'UPDATE schedule_runs SET outcome = ?, ended_at = ?, reason = ?, detail = ? WHERE rowid = ?',
            [run.outcome, run.endedAt ?? null, run.reason ?? null, run.detail ?? null, existing.rid],
          )
          return
        }
      }
      db.exec(
        `INSERT INTO schedule_runs (schedule_id, job_key, at, outcome, session_key, ended_at, seq, reason, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          key,
          run.at,
          run.outcome,
          run.sessionKey ?? null,
          run.endedAt ?? null,
          run.seq ?? null,
          run.reason ?? null,
          run.detail ?? null,
        ],
      )
      const rid = db.get<{ rid: number }>('SELECT last_insert_rowid() AS rid')?.rid
      const snapshot = snapshotOf(id)
      if (rid !== undefined && snapshot) receipts.add(rid, id, snapshot, runId)
    })
}
