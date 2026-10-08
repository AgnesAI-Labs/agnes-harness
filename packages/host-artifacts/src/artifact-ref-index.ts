import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { ARTIFACT_REF_EXTRACTOR_VERSION, extractArtifactRefs } from './artifact-ledger-refs.js'
import {
  beginImmediateWithBackoff,
  MUTATION_LOCK_TIMEOUT_MS,
  openPrivateArtifactDatabase,
} from './private-artifact-store.js'

export const ARTIFACT_REF_INDEX_FILE = 'computer-use-ref-index.db'
const SCHEMA_VERSION = '1'
const MiB = 1024 * 1024
/** One unit of unlocked catch-up: a short ledger read transaction plus one index write transaction. */
export const REF_INDEX_CHUNK = Object.freeze({ rows: 500, bytes: 4 * MiB })
/** Work allowed while the screenshot mutation lock or the ledger write lock is held. */
export const REF_INDEX_LOCKED_BUDGET = Object.freeze({ rows: 2000, bytes: 8 * MiB })
/**
 * Longest wait for the index while the ledger write lock is held. Ledger writers give up after
 * 5 s of busy waiting, so the verification must hand the lock back well before that.
 */
export const REF_INDEX_LOCKED_WAIT_MS = 1_000

const SCHEMA = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE session_cursor (session_key TEXT PRIMARY KEY, last_seq INTEGER NOT NULL,
     anchor_id TEXT NOT NULL, anchor_digest TEXT, last_ts_ms INTEGER NOT NULL,
     open_lanes TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE artifact_ref (sha256 TEXT NOT NULL, session_key TEXT NOT NULL,
     source TEXT NOT NULL CHECK (source IN ('ledger','request-media')),
     last_seq INTEGER NOT NULL, last_ts_ms INTEGER NOT NULL, last_tool_image_seq INTEGER,
     PRIMARY KEY (sha256, session_key, source)) WITHOUT ROWID`,
  'CREATE INDEX artifact_ref_session ON artifact_ref(session_key, last_tool_image_seq)',
]

type Budget = { rows: number; bytes: number }
type MetaRow = Readonly<{ key: string; value: string }>
type Cursor = Readonly<{
  last_seq: number
  anchor_id: string
  anchor_digest: string | null
  open_lanes: string
  last_ts_ms?: number
}>
type LedgerRow = Readonly<{
  seq: number
  id: string
  ts: string
  type: string
  lane: Uint8Array | string
  origin: string
  trust: string
  data: string
  integrity_digest: string | null
}>
export type IndexedRoots = Readonly<{ ledger: ReadonlySet<string>; requestMedia: ReadonlySet<string> }>

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>()
/** Per-connection prepared statements: catch-up and locked verification run them per session. */
export function cached(database: DatabaseSync, sql: string): StatementSync {
  const byText = statements.get(database) ?? new Map<string, StatementSync>()
  statements.set(database, byText)
  const statement = byText.get(sql) ?? database.prepare(sql)
  byText.set(sql, statement)
  return statement
}

/** Runs a synchronous index operation inside one non-blocking, cross-process write transaction. */
export async function withIndexTransaction<T>(
  index: DatabaseSync,
  operation: () => T,
  waitMs = MUTATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  await beginImmediateWithBackoff(index, waitMs, 'Computer Use artifact reference index is busy')
  try {
    const result = operation()
    index.exec('COMMIT')
    return result
  } catch (error) {
    try {
      index.exec('ROLLBACK')
    } catch {
      // Preserve the index operation failure.
    }
    throw error
  }
}

/**
 * Opens the Host-private reference index: a disposable cache derived from the ledger. A failed
 * integrity check fails the round closed; it is never rebuilt in place or replaced by path.
 */
export async function openArtifactRefIndex(dataDir: string): Promise<DatabaseSync> {
  const index = openPrivateArtifactDatabase(
    dataDir,
    ARTIFACT_REF_INDEX_FILE,
    'Computer Use artifact reference index',
  )
  try {
    // A rebuildable cache: WAL with NORMAL sync keeps each chunk commit off a synchronous fsync.
    // A crash may lose the newest commits, and a cursor always commits with its references, so the
    // only consequence is re-indexing those rows.
    index.exec('PRAGMA journal_mode = WAL')
    index.exec('PRAGMA synchronous = NORMAL')
    const check = index.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>
    if (check.length !== 1 || Object.values(check[0] ?? {})[0] !== 'ok')
      throw new Error(
        `Computer Use artifact reference index failed its integrity check; it is a disposable cache, delete ${ARTIFACT_REF_INDEX_FILE} and the next collection rebuilds it`,
      )
    await withIndexTransaction(index, () => {
      const hasMeta = index
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get()
      const meta = hasMeta ? (index.prepare('SELECT key, value FROM meta').all() as MetaRow[]) : []
      const value = (key: string) => meta.find((row) => row.key === key)?.value
      if (
        value('schema_version') === SCHEMA_VERSION &&
        value('extractor_version') === ARTIFACT_REF_EXTRACTOR_VERSION
      )
        return
      for (const table of ['artifact_ref', 'session_cursor', 'meta'])
        index.exec(`DROP TABLE IF EXISTS ${table}`)
      for (const statement of SCHEMA) index.exec(statement)
      index
        .prepare("INSERT INTO meta VALUES ('schema_version', ?), ('extractor_version', ?)")
        .run(SCHEMA_VERSION, ARTIFACT_REF_EXTRACTOR_VERSION)
    })
    return index
  } catch (error) {
    index.close()
    throw error
  }
}

type IndexedCursor = Cursor & Readonly<{ session_key: string }>
type SessionState = Readonly<{ lastSeq: number; cursor?: IndexedCursor; anchorHolds?: boolean }>

const LIVE_SESSIONS = `WITH RECURSIVE live(key) AS (
    SELECT MIN(session_key) FROM events
    UNION ALL SELECT (SELECT MIN(session_key) FROM events WHERE session_key > live.key) FROM live
    WHERE live.key IS NOT NULL)
  SELECT last.session_key, last.seq AS last_seq, last.id, last.integrity_digest
  FROM live JOIN events AS last ON last.session_key = live.key
    AND last.seq = (SELECT MAX(seq) FROM events WHERE session_key = live.key)`
const CURSOR_ANCHORS = `SELECT json_extract(cursor.value, '$[0]') AS session_key, anchor.id, anchor.integrity_digest
  FROM json_each(?) AS cursor LEFT JOIN events AS anchor
  ON anchor.session_key = json_extract(cursor.value, '$[0]') AND anchor.seq = json_extract(cursor.value, '$[1]')`

/** Same id, and the same integrity digest whenever both sides carry one. */
function sameAnchor(
  anchor: Readonly<{ id: string | null; integrity_digest: string | null }> | undefined,
  cursor: Cursor,
): boolean {
  if (!anchor || anchor.id !== cursor.anchor_id) return false
  return anchor.integrity_digest === null || cursor.anchor_digest === null
    ? true
    : anchor.integrity_digest === cursor.anchor_digest
}

/**
 * Every live session with its last seq and, when indexed, whether its anchor still holds: two
 * queries in total (primary-key skips plus one batched anchor join), inside the caller's ledger
 * read or write transaction.
 */
function sessionStates(
  ledger: DatabaseSync,
  cursors: ReadonlyMap<string, IndexedCursor>,
): Map<string, SessionState> {
  type Anchor = { session_key: string; id: string | null; integrity_digest: string | null }
  const live = cached(ledger, LIVE_SESSIONS).all() as Array<Anchor & { last_seq: number }>
  // A caught-up session's anchor is its last row, already read above; only the others need a lookup.
  const behind = live.flatMap(({ session_key: key, last_seq: lastSeq }) => {
    const cursor = cursors.get(key)
    return cursor && cursor.last_seq !== lastSeq ? [[key, cursor.last_seq]] : []
  })
  const anchors = new Map(
    ((behind.length === 0 ? [] : cached(ledger, CURSOR_ANCHORS).all(JSON.stringify(behind))) as Anchor[]).map(
      (row) => [row.session_key, row],
    ),
  )
  const states = new Map<string, SessionState>()
  for (const row of live) {
    const cursor = cursors.get(row.session_key)
    const anchor = cursor?.last_seq === row.last_seq ? row : anchors.get(row.session_key)
    states.set(
      row.session_key,
      cursor
        ? { lastSeq: row.last_seq, cursor, anchorHolds: sameAnchor(anchor, cursor) }
        : { lastSeq: row.last_seq },
    )
  }
  return states
}

function readCursors(index: DatabaseSync): Map<string, IndexedCursor> {
  const rows = cached(
    index,
    'SELECT session_key, last_seq, anchor_id, anchor_digest, open_lanes, last_ts_ms FROM session_cursor',
  ).all() as IndexedCursor[]
  return new Map(rows.map((row) => [row.session_key, row]))
}

/** A CU screenshot `tool/result` row: its seq and the image digests it carries. */
export type ToolImageNode = Readonly<{ seq: number; digests: readonly string[] }>
/** What a live session looks like for retention: its newest event time and unindexed image rows. */
export type SessionActivity = Readonly<{ lastTsMs: number; toolImages: readonly ToolImageNode[] }>

/** Newest indexed event time per indexed session, as of the index's last catch-up. */
export async function readIndexedActivity(index: DatabaseSync): Promise<Map<string, SessionActivity>> {
  const cursors = await withIndexTransaction(index, () => readCursors(index))
  return new Map(
    [...cursors].map(([key, cursor]) => [key, { lastTsMs: cursor.last_ts_ms ?? 0, toolImages: [] }]),
  )
}

function readCursor(index: DatabaseSync, sessionKey: string): Cursor | undefined {
  return cached(
    index,
    'SELECT last_seq, anchor_id, anchor_digest, open_lanes FROM session_cursor WHERE session_key = ?',
  ).get(sessionKey) as Cursor | undefined
}

function anchorHolds(ledger: DatabaseSync, sessionKey: string, cursor: Cursor): boolean {
  const anchor = cached(
    ledger,
    'SELECT id, integrity_digest FROM events WHERE session_key = ? AND seq = ?',
  ).get(sessionKey, cursor.last_seq) as { id: string; integrity_digest: string | null } | undefined
  return sameAnchor(anchor, cursor)
}

function resetSession(index: DatabaseSync, sessionKey: string): void {
  cached(index, 'DELETE FROM artifact_ref WHERE session_key = ?').run(sessionKey)
  cached(index, 'DELETE FROM session_cursor WHERE session_key = ?').run(sessionKey)
}

/** Rows after `afterSeq`, stopping before the row or byte limit is exceeded (at least one row). */
function readRows(ledger: DatabaseSync, sessionKey: string, afterSeq: number, limit: Budget): LedgerRow[] {
  const statement = cached(
    ledger,
    `SELECT seq, id, ts, type, lane, origin, trust, data, integrity_digest FROM events
     WHERE session_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
  )
  const rows: LedgerRow[] = []
  let bytes = 0
  for (const row of statement.iterate(sessionKey, afterSeq, Math.max(1, limit.rows)) as Iterable<LedgerRow>) {
    if (rows.length > 0 && bytes + row.data.length > limit.bytes) break
    bytes += row.data.length
    rows.push(row)
  }
  return rows
}

export const laneText = (lane: Uint8Array | string) =>
  typeof lane === 'string' ? lane : new TextDecoder().decode(lane)
/** Event time in ms; an unparseable timestamp counts as the epoch, i.e. long ago. */
export const tsMs = (ts: string) => {
  const value = Date.parse(ts)
  return Number.isFinite(value) ? value : 0
}

type ChunkResult = Readonly<{
  status: 'caught-up' | 'progress' | 'reset'
  rows: number
  bytes: number
  error?: unknown
}>

/**
 * Advances one session by one chunk. The anchor check and the incremental read share a single
 * ledger read snapshot, so a session discarded and recreated under the same key since the last
 * chunk is detected before any of its rows are trusted.
 */
function advanceChunk(
  ledger: DatabaseSync,
  index: DatabaseSync,
  sessionKey: string,
  limit: Budget,
): ChunkResult {
  const cursor = readCursor(index, sessionKey)
  let rows: LedgerRow[]
  ledger.exec('BEGIN')
  try {
    if (cursor && !anchorHolds(ledger, sessionKey, cursor)) {
      ledger.exec('COMMIT')
      resetSession(index, sessionKey)
      return { status: 'reset', rows: 0, bytes: 0 }
    }
    rows = readRows(ledger, sessionKey, cursor?.last_seq ?? 0, limit)
    ledger.exec('COMMIT')
  } catch (error) {
    try {
      ledger.exec('ROLLBACK')
    } catch {
      // Preserve the ledger read failure.
    }
    throw error
  }
  if (rows.length === 0) return { status: 'caught-up', rows: 0, bytes: 0 }
  const upsert = cached(
    index,
    `INSERT INTO artifact_ref (sha256, session_key, source, last_seq, last_ts_ms, last_tool_image_seq)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (sha256, session_key, source) DO UPDATE SET
     last_seq = excluded.last_seq, last_ts_ms = excluded.last_ts_ms,
     last_tool_image_seq = COALESCE(excluded.last_tool_image_seq, artifact_ref.last_tool_image_seq)`,
  )
  const lanes = new Set<string>(JSON.parse(cursor?.open_lanes ?? '[]') as string[])
  let applied: LedgerRow | undefined
  let bytes = 0
  let error: unknown
  for (const row of rows) {
    let refs: ReturnType<typeof extractArtifactRefs>
    try {
      refs = extractArtifactRefs({ ...row, lane: laneText(row.lane) })
    } catch (caught) {
      error = caught
      break
    }
    const ts = tsMs(row.ts)
    for (const sha256 of refs.ledger)
      upsert.run(sha256, sessionKey, 'ledger', row.seq, ts, refs.toolImage.has(sha256) ? row.seq : null)
    for (const sha256 of refs.requestMedia) upsert.run(sha256, sessionKey, 'request-media', row.seq, ts, null)
    if (refs.turn?.kind === 'start') lanes.add(refs.turn.lane)
    if (refs.turn?.kind === 'end') lanes.delete(refs.turn.lane)
    applied = row
    bytes += row.data.length
  }
  if (applied)
    cached(
      index,
      `INSERT INTO session_cursor (session_key, last_seq, anchor_id, anchor_digest, last_ts_ms, open_lanes)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (session_key) DO UPDATE SET last_seq = excluded.last_seq,
         anchor_id = excluded.anchor_id, anchor_digest = excluded.anchor_digest,
         last_ts_ms = excluded.last_ts_ms, open_lanes = excluded.open_lanes`,
    ).run(
      sessionKey,
      applied.seq,
      applied.id,
      applied.integrity_digest,
      tsMs(applied.ts),
      JSON.stringify([...lanes].sort()),
    )
  const count = applied ? rows.indexOf(applied) + 1 : 0
  return { status: 'progress', rows: count, bytes, ...(error === undefined ? {} : { error }) }
}

/**
 * Drops index state for sessions that no longer exist in the ledger, then returns the live
 * sessions that still need a chunk: no cursor yet, a broken anchor, or rows after the cursor.
 */
async function sessionsNeedingWork(ledger: DatabaseSync, index: DatabaseSync): Promise<string[]> {
  const cursors = await withIndexTransaction(index, () => readCursors(index))
  let states: Map<string, SessionState>
  ledger.exec('BEGIN')
  try {
    states = sessionStates(ledger, cursors)
  } finally {
    ledger.exec('COMMIT')
  }
  const gone = [...cursors.keys()].filter((key) => !states.has(key))
  if (gone.length > 0)
    await withIndexTransaction(index, () => {
      const exists = cached(ledger, 'SELECT 1 FROM events WHERE session_key = ? LIMIT 1')
      for (const key of gone) if (!exists.get(key)) resetSession(index, key)
    })
  return [...states].flatMap(([key, state]) =>
    !state.cursor || !state.anchorHolds || state.lastSeq !== state.cursor.last_seq ? [key] : [],
  )
}

/**
 * Unlocked catch-up (including the first backfill): chunk by chunk, yielding to the event loop
 * after every committed chunk and stopping at a chunk boundary once `signal` aborts.
 */
export async function catchUpArtifactRefIndex(
  input: Readonly<{ ledger: DatabaseSync; index: DatabaseSync; signal: AbortSignal }>,
): Promise<'complete' | 'aborted'> {
  for (const sessionKey of await sessionsNeedingWork(input.ledger, input.index))
    for (;;) {
      if (input.signal.aborted) return 'aborted'
      const chunk = await withIndexTransaction(input.index, () =>
        advanceChunk(input.ledger, input.index, sessionKey, REF_INDEX_CHUNK),
      )
      if (chunk.error !== undefined) throw chunk.error
      await yieldToLoop()
      if (chunk.status === 'caught-up') break
    }
  return input.signal.aborted ? 'aborted' : 'complete'
}

/** Catch-up under the screenshot mutation lock: bounded and without yielding; false when over budget. */
export async function catchUpArtifactRefIndexWithinBudget(
  input: Readonly<{ ledger: DatabaseSync; index: DatabaseSync }>,
): Promise<boolean> {
  const remaining = { ...REF_INDEX_LOCKED_BUDGET }
  for (const sessionKey of await sessionsNeedingWork(input.ledger, input.index))
    for (;;) {
      if (remaining.rows < 1 || remaining.bytes < 1) return false
      const limit = { rows: Math.min(REF_INDEX_CHUNK.rows, remaining.rows), bytes: remaining.bytes }
      const chunk = await withIndexTransaction(input.index, () =>
        advanceChunk(input.ledger, input.index, sessionKey, limit),
      )
      if (chunk.error !== undefined) throw chunk.error
      if (chunk.status === 'caught-up') break
      remaining.rows -= chunk.rows
      remaining.bytes -= chunk.bytes
    }
  return true
}

function candidateRefs(
  index: DatabaseSync,
  candidates: ReadonlySet<string>,
): Array<{ sha256: string; session_key: string; source: string }> {
  if (candidates.size === 0) return []
  return cached(
    index,
    'SELECT sha256, session_key, source FROM artifact_ref WHERE sha256 IN (SELECT value FROM json_each(?))',
  ).all(JSON.stringify([...candidates])) as Array<{ sha256: string; session_key: string; source: string }>
}

/** Indexed ledger and request-media roots among `candidates`, read in one index transaction. */
export async function readIndexedRoots(
  index: DatabaseSync,
  candidates: ReadonlySet<string>,
): Promise<IndexedRoots> {
  return withIndexTransaction(index, () => {
    const ledger = new Set<string>()
    const requestMedia = new Set<string>()
    for (const row of candidateRefs(index, candidates))
      (row.source === 'ledger' ? ledger : requestMedia).add(row.sha256)
    return { ledger, requestMedia }
  })
}

/**
 * Recomputes the candidates' roots while the caller holds the ledger write lock on `ledger`:
 * every live session's indexed prefix is proven unchanged by its anchor and every row after it
 * is extracted on the spot, so the result covers the whole ledger. Returns undefined when that
 * proof would exceed the locked budget or an anchor no longer holds; the caller aborts the batch.
 */
export async function verifyRootsUnderLedgerLock(
  input: Readonly<{
    ledger: DatabaseSync
    index: DatabaseSync
    candidates: ReadonlySet<string>
    /** What is left of the locked phase's index-wait budget. */
    waitMs?: number
  }>,
): Promise<(IndexedRoots & Readonly<{ activity: ReadonlyMap<string, SessionActivity> }>) | undefined> {
  const { ledger: database, index, candidates } = input
  const snapshot = await withIndexTransaction(
    index,
    () => ({ cursors: readCursors(index), indexed: candidateRefs(index, candidates) }),
    input.waitMs ?? REF_INDEX_LOCKED_WAIT_MS,
  )
  const ledger = new Set<string>()
  const requestMedia = new Set<string>()
  const states = sessionStates(database, snapshot.cursors)
  const remaining = { ...REF_INDEX_LOCKED_BUDGET }
  const activity = new Map<string, SessionActivity>()
  for (const [sessionKey, state] of states) {
    if (state.cursor && !state.anchorHolds) return undefined
    const afterSeq = state.cursor?.last_seq ?? 0
    const seen = { lastTsMs: state.cursor?.last_ts_ms ?? 0, toolImages: [] as ToolImageNode[] }
    activity.set(sessionKey, seen)
    if (state.lastSeq <= afterSeq) continue
    const rows = readRows(database, sessionKey, afterSeq, {
      rows: remaining.rows + 1,
      bytes: Number.MAX_SAFE_INTEGER,
    })
    for (const row of rows) {
      remaining.rows -= 1
      remaining.bytes -= row.data.length
      if (remaining.rows < 0 || remaining.bytes < 0) return undefined
      const refs = extractArtifactRefs({ ...row, lane: laneText(row.lane) })
      for (const sha256 of refs.ledger) if (candidates.has(sha256)) ledger.add(sha256)
      for (const sha256 of refs.requestMedia) if (candidates.has(sha256)) requestMedia.add(sha256)
      seen.lastTsMs = Math.max(seen.lastTsMs, tsMs(row.ts))
      if (refs.toolImage.size > 0) seen.toolImages.push({ seq: row.seq, digests: [...refs.toolImage] })
    }
  }
  for (const row of snapshot.indexed) {
    if (!states.has(row.session_key)) continue
    ;(row.source === 'ledger' ? ledger : requestMedia).add(row.sha256)
  }
  return { ledger, requestMedia, activity }
}
