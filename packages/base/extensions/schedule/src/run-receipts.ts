import type {
  EventEnvelope,
  ScheduleHistoryEntry,
  SchedulesHistoryParams,
  SchedulesHistoryResult,
} from '@agnes/protocol'
import type { ScheduleDb } from './catalog.js'
import type { ScheduleView } from './rules.js'

const terminal = "('ran', 'failed', 'delivered')"

type ReceiptRow = {
  id: string
  schedule_id: string
  title: string
  at: number
  outcome: ScheduleHistoryEntry['outcome']
  session_key: string | null
  ended_at: number | null
  reason: string | null
  detail: string | null
  snapshot: string | null
  summary: string | null
  is_read: number
}

/** Presentation facts belong to the schedule store, shared by all clients and surviving restart. */
export function openRunReceipts(db: ScheduleDb) {
  const entry = (row: ReceiptRow): ScheduleHistoryEntry => ({
    id: row.id,
    scheduleId: row.schedule_id,
    title: row.snapshot ? (JSON.parse(row.snapshot) as { title: string }).title : row.title,
    at: row.at,
    outcome: row.outcome,
    read: row.is_read === 1,
    ...(row.snapshot ? { snapshot: JSON.parse(row.snapshot) } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.detail ? { detail: row.detail } : {}),
  })

  return {
    add(
      rid: number,
      scheduleId: string,
      snapshot: Pick<ScheduleView, 'title' | 'prompt' | 'selector' | 'target'>,
    ) {
      db.exec(
        "INSERT INTO schedule_run_receipts (run_rowid, id, snapshot, schedule_id) VALUES (?, 'run_' || lower(hex(randomblob(16))), ?, ?)",
        [rid, JSON.stringify(snapshot), scheduleId],
      )
    },
    summary(rid: number, event: EventEnvelope) {
      if (event.type !== 'assistant/message') return
      const data = event.data as { stopReason?: string; content?: { type: string; text?: string }[] }
      if (!['end_turn', 'refusal', 'max_tokens'].includes(data.stopReason ?? '')) return
      const summary = (data.content ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('\n')
        .trim()
        .slice(0, 4000)
      db.exec('UPDATE schedule_run_receipts SET summary = ? WHERE run_rowid = ?', [summary || null, rid])
    },
    page(query: SchedulesHistoryParams): SchedulesHistoryResult {
      const limit = Math.max(1, Math.min(query.limit ?? 20, 100))
      let before = Number.MAX_SAFE_INTEGER
      if (query.before) {
        const cursor = db.get<{ run_rowid: number }>(
          'SELECT m.run_rowid FROM schedule_run_receipts m JOIN schedule_runs r ON r.rowid = m.run_rowid WHERE m.id = ? AND (? IS NULL OR r.schedule_id = ?)',
          [query.before, query.id ?? null, query.id ?? null],
        )
        if (!cursor) return { runs: [], cursorInvalid: true }
        before = cursor.run_rowid
      }
      const ordinal = query.unreadOnly ? 'm.run_rowid' : 'r.rowid'
      const where = [ordinal + ' < ?']
      const params: unknown[] = [before]
      if (query.id) {
        where.push('r.schedule_id = ?')
        params.push(query.id)
        if (query.unreadOnly) {
          where.push('m.schedule_id = ?')
          params.push(query.id)
        }
      }
      if (query.resultsOnly) where.push('r.outcome IN ' + terminal)
      if (query.unreadOnly) where.push('m.is_read = 0')
      // Read matching receipt index entries before looking up run details.
      const from = query.unreadOnly
        ? `FROM schedule_run_receipts m INDEXED BY ${query.id ? 'schedule_receipts_task_unread' : 'schedule_receipts_unread'} CROSS JOIN schedule_runs r ON r.rowid = m.run_rowid `
        : 'FROM schedule_runs r JOIN schedule_run_receipts m ON m.run_rowid = r.rowid '
      const rows = db.all<ReceiptRow>(
        'SELECT r.*, m.id, m.snapshot, m.summary, m.is_read, s.title ' +
          from +
          'JOIN schedules s ON s.id = r.schedule_id ' +
          'WHERE ' +
          where.join(' AND ') +
          ' ORDER BY ' +
          ordinal +
          ' DESC LIMIT ?',
        [...params, limit + 1],
      )
      const nextCursor = rows.length > limit ? rows[limit - 1]?.id : undefined
      return {
        runs: rows.slice(0, limit).map(entry),
        ...(nextCursor ? { nextCursor } : {}),
      }
    },
    mark(scheduleId: string, runId: string, read: boolean) {
      const row = db.get<{ run_rowid: number }>(
        'SELECT m.run_rowid FROM schedule_run_receipts m JOIN schedule_runs r ON r.rowid = m.run_rowid ' +
          'WHERE m.id = ? AND r.schedule_id = ? AND r.outcome IN ' +
          terminal,
        [runId, scheduleId],
      )
      if (!row) return { updated: false }
      db.exec('UPDATE schedule_run_receipts SET is_read = ? WHERE run_rowid = ?', [
        read ? 1 : 0,
        row.run_rowid,
      ])
      return { updated: true }
    },
  }
}
