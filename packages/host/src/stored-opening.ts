import { DatabaseSync } from 'node:sqlite'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { type Event, leanEvents, UIProjectionCell } from '@agnes/core'
import { UI_OPENING_MAX_NODES, UI_PROJECTION_DEFAULT_MAX_BYTES } from '@agnes/protocol'
import { rowToEventForRead } from './adapters/storage-sqlite.js'
import { EVENT_COLUMNS_LEAN } from './adapters/storage-sqlite-lean.js'

export type StoredOpeningReader = {
  opening(
    sessionKey: string,
    maxNodes: number,
  ): Promise<{ timeline: unknown; hasEarlier: boolean; lastSeq: number }>
  close(): void
}

const PAGE = 500

/**
 * Reads a session straight from sessions.db on its own read-only connection, lean and unverified, and
 * folds it into a bounded opening. It never takes the writer lease and never wakes a worker; the result
 * is labelled unverified because no integrity check ran.
 */
export function createStoredOpeningReader(o: { file: string }): StoredOpeningReader {
  const db = new DatabaseSync(o.file, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  const parentOf = db.prepare('SELECT parent_key, boundary_seq FROM sessions WHERE session_key = ?')
  const page = db.prepare(
    `SELECT ${EVENT_COLUMNS_LEAN} FROM events WHERE session_key = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ${PAGE}`,
  )
  /** The ledgers a session reads, oldest ancestor first, each with the last seq it contributes. */
  const chainOf = (key: string): Array<{ key: string; upto: number }> => {
    const chain = [{ key, upto: Number.MAX_SAFE_INTEGER }]
    for (let at = key; ; ) {
      const link = parentOf.get(at) as { parent_key: string | null; boundary_seq: number | null } | undefined
      if (!link?.parent_key) return chain.reverse()
      const upto = Math.min(link.boundary_seq ?? 0, chain.at(-1)?.upto ?? 0)
      at = link.parent_key
      chain.push({ key: at, upto })
    }
  }
  return {
    async opening(sessionKey, maxNodes) {
      const cell = new UIProjectionCell(sessionKey, 'main')
      let lastSeq = 0
      for (const segment of chainOf(sessionKey)) {
        for (;;) {
          const rows = page.all(segment.key, lastSeq, segment.upto) as unknown[]
          if (rows.length === 0) break
          const events: Event[] = rows.map(rowToEventForRead)
          // The SQL leaves non-ASCII attachment data whole; the JS rule finishes it, as scanLean does.
          cell.apply(leanEvents(events))
          lastSeq = (events.at(-1) as Event).seq
          // A page at a time, so a long ledger does not hold the daemon's event loop.
          await nextTurn()
        }
      }
      cell.sealReplay()
      const result = await cell.opening({
        maxNodes: Math.min(maxNodes, UI_OPENING_MAX_NODES),
        maxBytes: UI_PROJECTION_DEFAULT_MAX_BYTES,
      })
      return { timeline: result.timeline, hasEarlier: result.hasEarlier, lastSeq }
    },
    close: () => db.close(),
  }
}
