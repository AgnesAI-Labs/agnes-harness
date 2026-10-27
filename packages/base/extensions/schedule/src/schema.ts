import type { ScheduleDb } from './catalog.js'

/** Match the client's locale-independent Unicode lowercase operation. */
export const scheduleSearchText = (title: string, prompt: string): string =>
  `${title}\n${prompt}`.toLowerCase()

// Owner connections refuse PRAGMA. Their own sqlite_master is the supported schema source.
function hasColumn(db: ScheduleDb, table: string, column: string): boolean {
  const sql =
    db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", [table])
      ?.sql ?? ''
  return new RegExp(`\\b${column}\\b`, 'i').test(sql)
}

export function ensureScheduleSchema(db: ScheduleDb): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    search_text TEXT NOT NULL DEFAULT '',
    selector TEXT NOT NULL,
    status TEXT NOT NULL,
    job_key TEXT,
    revision INTEGER NOT NULL,
    next_run_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    target TEXT,
    origin TEXT
  )`)
    db.exec('CREATE INDEX IF NOT EXISTS schedules_session ON schedules (session_key, status)')
    db.exec(
      "CREATE INDEX IF NOT EXISTS schedules_next_run ON schedules (next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL",
    )
    db.exec(`CREATE TABLE IF NOT EXISTS schedule_runs (
    schedule_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    at INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    session_key TEXT,
    ended_at INTEGER,
    seq INTEGER,
    reason TEXT,
    detail TEXT,
    progress TEXT
  )`)
    db.exec('CREATE INDEX IF NOT EXISTS schedule_runs_schedule ON schedule_runs (schedule_id, at)')
    db.exec('CREATE INDEX IF NOT EXISTS schedule_runs_session ON schedule_runs (session_key, at)')

    if (!hasColumn(db, 'schedules', 'search_text')) {
      db.exec("ALTER TABLE schedules ADD COLUMN search_text TEXT NOT NULL DEFAULT ''")
      for (const row of db.all<{ id: string; title: string; prompt: string }>(
        'SELECT id, title, prompt FROM schedules',
      )) {
        db.exec('UPDATE schedules SET search_text = ? WHERE id = ?', [
          scheduleSearchText(row.title, row.prompt),
          row.id,
        ])
      }
    }
    db.exec(
      'CREATE TABLE IF NOT EXISTS schedule_run_receipts (' +
        'run_rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, snapshot TEXT, summary TEXT, is_read INTEGER NOT NULL DEFAULT 0, schedule_id TEXT NOT NULL)',
    )
    // SQLite includes rowid in an ordinary index: this supports task + descending cursor seeks.
    db.exec(
      'CREATE INDEX IF NOT EXISTS schedule_runs_open_progress ON schedule_runs (session_key) WHERE progress IS NOT NULL AND ended_at IS NULL',
    )
    db.exec(
      "CREATE INDEX IF NOT EXISTS schedule_runs_open_job ON schedule_runs (schedule_id) WHERE outcome IN ('running', 'waiting_approval', 'needs_attention')",
    )
    db.exec(
      "CREATE INDEX IF NOT EXISTS schedule_runs_previous ON schedule_runs (schedule_id, at) WHERE session_key IS NOT NULL AND (reason IS NULL OR reason != 'approval_pending_previous_run')",
    )
    db.exec('CREATE INDEX IF NOT EXISTS schedule_runs_task ON schedule_runs (schedule_id)')
    db.exec(
      'CREATE INDEX IF NOT EXISTS schedule_receipts_unread ON schedule_run_receipts (is_read, run_rowid DESC)',
    )
    if (!hasColumn(db, 'schedule_run_receipts', 'schedule_id')) {
      db.exec('ALTER TABLE schedule_run_receipts ADD COLUMN schedule_id TEXT')
      db.exec(
        'UPDATE schedule_run_receipts SET schedule_id = (SELECT r.schedule_id FROM schedule_runs r WHERE r.rowid = run_rowid)',
      )
    }
    db.exec(
      'CREATE INDEX IF NOT EXISTS schedule_receipts_task_unread ON schedule_run_receipts (schedule_id, is_read, run_rowid DESC)',
    )
    // Historical rows get identities, but never a made-up instruction or settings snapshot.
    db.exec(
      "INSERT INTO schedule_run_receipts (run_rowid, id, schedule_id) SELECT rowid, 'run_' || lower(hex(randomblob(16))), r.schedule_id FROM schedule_runs r " +
        'WHERE r.rowid > COALESCE((SELECT max(run_rowid) FROM schedule_run_receipts), 0)',
    )
  })
}
