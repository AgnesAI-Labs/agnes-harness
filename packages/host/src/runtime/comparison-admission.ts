import type { DatabaseSync } from 'node:sqlite'
import type { ComparisonRecord, Side } from '@agnes/runtime-comparison'
import { ComparisonJournalError } from './comparison-journal-types.js'

export interface ComparisonAdmission {
  principal: string
  id: string
  side: Side
  sessionId: string
  blocked: boolean
  retirement: string
}
export type ComparisonSessionKeys = (principal: string, id: string) => Record<Side, string>

/** Permanent reservations survive lane preparation failures and record retirement/tombstones. */
export function createComparisonAdmission(db: DatabaseSync, sessionKeys?: ComparisonSessionKeys) {
  db.exec(`CREATE TABLE IF NOT EXISTS comparison_session_admission (
    session_id TEXT PRIMARY KEY, principal TEXT NOT NULL, id TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('left','right')), blocked INTEGER NOT NULL CHECK(blocked IN (0,1)),
    retirement TEXT NOT NULL, UNIQUE(principal,id,side))`)
  const get = db.prepare('SELECT * FROM comparison_session_admission WHERE session_id=?')
  const bindings = db.prepare('SELECT * FROM comparison_session_admission WHERE principal=? AND id=?')
  const insert = db.prepare(`INSERT INTO comparison_session_admission
    (session_id,principal,id,side,blocked,retirement) VALUES(?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      blocked=MAX(comparison_session_admission.blocked,excluded.blocked),
      retirement=CASE WHEN comparison_session_admission.blocked=1 AND excluded.blocked=0
        THEN comparison_session_admission.retirement ELSE excluded.retirement END`)
  const decode = (row: unknown): ComparisonAdmission | undefined => {
    if (!row) return undefined
    const r = row as {
      session_id: string
      principal: string
      id: string
      side: Side
      blocked: number
      retirement: string
    }
    return {
      sessionId: r.session_id,
      principal: r.principal,
      id: r.id,
      side: r.side,
      blocked: r.blocked !== 0,
      retirement: r.retirement,
    }
  }
  return {
    sessionIds(): string[] {
      return db
        .prepare('SELECT session_id FROM comparison_session_admission')
        .all()
        .map((row) => String(row.session_id))
    },
    get(sessionId: string) {
      return decode(get.get(sessionId))
    },
    bindings(principal: string, id: string): Partial<Record<Side, string>> {
      return Object.fromEntries(
        bindings.all(principal, id).map((row) => {
          const r = decode(row) as ComparisonAdmission
          return [r.side, r.sessionId]
        }),
      )
    },
    record(principal: string, record: ComparisonRecord): void {
      const keys = sessionKeys?.(principal, record.id)
      const retirement = record.retirement === undefined ? 'full' : (record.retirement?.state ?? 'unknown')
      for (const side of ['left', 'right'] as const) {
        const lane = record.lanes?.[side]
        const sessionId = keys?.[side] ?? lane?.sessionId
        if (!sessionId) continue
        const old = decode(get.get(sessionId))
        if (
          (lane && lane.sessionId !== sessionId) ||
          (old && (old.principal !== principal || old.id !== record.id || old.side !== side))
        )
          throw new ComparisonJournalError(
            'JOURNAL_BINDING_MISMATCH',
            'Comparison session reservation conflicts',
          )
        insert.run(sessionId, principal, record.id, side, retirement === 'full' ? 0 : 1, retirement)
      }
      // Existing reservations remain fenced even when a removed tombstone no longer has lanes.
      if (retirement !== 'full')
        db.prepare(
          'UPDATE comparison_session_admission SET blocked=1,retirement=? WHERE principal=? AND id=?',
        ).run(retirement, principal, record.id)
    },
    assert(sessionId: string): void {
      const row = decode(get.get(sessionId))
      if (row?.blocked)
        throw new ComparisonJournalError(
          'COMPARISON_RETIRED',
          'Comparison no longer admits session mutations',
        )
    },
  }
}
