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

/** The stored session cannot be read as a history: its ancestry loops or runs deeper than any fork. */
export class StoredOpeningError extends Error {
  readonly code = 'STORED_OPENING_ANCESTRY'
  constructor(message: string) {
    super(message)
    this.name = 'StoredOpeningError'
  }
}

const PAGE_ROWS = 500
/** Stored bytes one page may read before the reader yields the event loop. */
const PAGE_BYTES = 8 * 1024 * 1024
/** Deeper than any real fork chain; a longer one is a damaged sessions table. */
const MAX_ANCESTRY = 64

type Folded = { cell: UIProjectionCell; lastSeq: number }

/** Options a test can set; the public factory takes only the file. */
export type StoredOpeningReaderOptions = {
  file: string
  pageBytes?: number
  /** Called with each page's rows as SQLite returned them, before the JS lean pass. */
  onPage?: (rows: readonly unknown[]) => void
}

/**
 * Reads a session straight from sessions.db on its own read-only connection, lean and unverified, and
 * folds it into a bounded opening. It never takes the writer lease and never wakes a worker; the result
 * is labelled unverified because no integrity check ran.
 */
export function createStoredOpeningReader(o: { file: string }): StoredOpeningReader {
  return openStoredOpeningReader({ file: o.file })
}

export function openStoredOpeningReader(o: StoredOpeningReaderOptions): StoredOpeningReader {
  const pageBytes = o.pageBytes ?? PAGE_BYTES
  const db = new DatabaseSync(o.file, { readOnly: true })
  db.exec('PRAGMA busy_timeout = 5000')
  const parentOf = db.prepare('SELECT parent_key, boundary_seq FROM sessions WHERE session_key = ?')
  // octet_length on a column reads the record header, not the value, so sizing a page is cheap.
  const sizes = db.prepare(
    `SELECT seq, octet_length(data) AS n FROM events WHERE session_key = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ${PAGE_ROWS}`,
  )
  const page = db.prepare(
    `SELECT ${EVENT_COLUMNS_LEAN} FROM events WHERE session_key = ? AND seq > ? AND seq <= ? ORDER BY seq`,
  )
  /** The ledgers a session reads, oldest ancestor first, each with the last seq it contributes. */
  const chainOf = (key: string): Array<{ key: string; upto: number }> => {
    const chain = [{ key, upto: Number.MAX_SAFE_INTEGER }]
    const seen = new Set([key])
    for (let at = key; ; ) {
      const link = parentOf.get(at) as { parent_key: string | null; boundary_seq: number | null } | undefined
      if (!link?.parent_key) return chain.reverse()
      if (seen.has(link.parent_key) || chain.length >= MAX_ANCESTRY)
        throw new StoredOpeningError('stored session ancestry loops or is too deep')
      seen.add(link.parent_key)
      const upto = Math.min(link.boundary_seq ?? 0, chain.at(-1)?.upto ?? 0)
      at = link.parent_key
      chain.push({ key: at, upto })
    }
  }
  /** The last seq of the next page after `after`: up to 500 rows, cut at `pageBytes`, at least one row. */
  const pageEnd = (key: string, after: number, upto: number): number | undefined => {
    const rows = sizes.all(key, after, upto) as Array<{ seq: number; n: number | null }>
    let bytes = 0
    let end: number | undefined
    for (const row of rows) {
      bytes += row.n ?? 0
      if (end !== undefined && bytes > pageBytes) break
      end = row.seq
    }
    return end
  }
  const fold = async (sessionKey: string): Promise<Folded> => {
    const cell = new UIProjectionCell(sessionKey, 'main')
    let lastSeq = 0
    for (const segment of chainOf(sessionKey)) {
      for (;;) {
        const end = pageEnd(segment.key, lastSeq, segment.upto)
        if (end === undefined) break
        const rows = page.all(segment.key, lastSeq, end) as unknown[]
        o.onPage?.(rows)
        const events: Event[] = rows.map(rowToEventForRead)
        // The SQL leaves non-ASCII attachment data whole; the JS rule finishes it, as scanLean does.
        cell.apply(leanEvents(events))
        lastSeq = end
        // A page at a time, so a long ledger does not hold the daemon's event loop.
        await nextTurn()
      }
    }
    cell.sealReplay()
    return { cell, lastSeq }
  }
  // Two clients waiting on the same slow session share one read of it.
  const inFlight = new Map<string, Promise<Folded>>()
  return {
    async opening(sessionKey, maxNodes) {
      let folding = inFlight.get(sessionKey)
      if (!folding) {
        folding = fold(sessionKey)
        inFlight.set(sessionKey, folding)
        const done = folding
        void done.then(
          () => inFlight.get(sessionKey) === done && inFlight.delete(sessionKey),
          () => inFlight.get(sessionKey) === done && inFlight.delete(sessionKey),
        )
      }
      const { cell, lastSeq } = await folding
      const result = await cell.opening({
        maxNodes: Math.min(maxNodes, UI_OPENING_MAX_NODES),
        maxBytes: UI_PROJECTION_DEFAULT_MAX_BYTES,
      })
      return { timeline: result.timeline, hasEarlier: result.hasEarlier, lastSeq }
    },
    close: () => db.close(),
  }
}
