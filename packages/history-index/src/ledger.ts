import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HistoryIndexError } from './errors.js'
import { eventBody, extractText } from './text.js'

const TITLE_EVENT = 'x/host/session-title'

export type LedgerSession = {
  parentId: string | null
  createdAt: string
  /** The ledger's append watermark: the seq of the session's last event, when the ledger records one. */
  head?: number
}

export type LedgerEvent = {
  sessionId: string
  seq: number
  /** The ledger's event id: the index checks it to tell an appended session from a rewritten one. */
  id: string | null
  ts: string
  type: string
  text: string
  body: string
  truncated: boolean
  sources: number[]
  /** The generated session title a trusted title event carries. */
  title?: string
}

export type SideTables = {
  workspaces: Map<string, WorkspaceRow>
  principals: Map<string, string>
  titles: Map<string, string>
}

/** One read transaction over the ledger, so every answer comes from the same commit. */
export type LedgerReader = {
  sessions: ReadonlyMap<string, LedgerSession>
  /**
   * Sessions with an event stored after `rowid`, and the highest rowid now. Only a session without a
   * ledger row depends on this to be found; the ledger writes that row with the session's first event.
   */
  appended(rowid: number): { keys: string[]; rowid: number }
  tail(sessionId: string): number | undefined
  idAt(sessionId: string, seq: number): string | null | undefined
  events(sessionId: string, after: number, limit: number): LedgerEvent[]
  /**
   * Whether the newest commit, read outside this snapshot, still holds the session up to `seq` with event
   * `id` there. Asked before the index drops what another process indexed from a later snapshot.
   */
  holds(sessionId: string, seq: number, id: string | null): boolean
  close(): void
}

type WorkspaceRow = { cwd: string; title?: string }
type EventRow = {
  seq: number
  id: string | null
  ts: string | number
  type: string
  origin: string
  trust: string
  source_event_seqs: string | null
  data: string
}

function stampFile(path: string): string {
  try {
    const stat = statSync(path)
    return `${path}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return `${path}:missing`
  }
}

/**
 * Every commit changes a database file or its WAL. The -shm file is left out: a reader writes its read
 * mark there, so the sync's own read would make the next call look changed.
 */
export function sourceStamp(dataDir: string): string {
  const parts = ['sessions.db', 'sessions.db-wal'].map((name) => stampFile(join(dataDir, name)))
  const tables = join(dataDir, 'tables')
  if (existsSync(tables)) {
    for (const name of readdirSync(tables).sort()) {
      if (name.endsWith('.db') || name.endsWith('.db-wal')) parts.push(stampFile(join(tables, name)))
    }
  }
  return parts.join('|')
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
    name: string
  }>
  return new Set(rows.map((row) => row.name))
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function generatedTitle(data: unknown, origin: string, trust: string): string | undefined {
  if (origin !== 'system' || trust !== 'trusted' || data === null || typeof data !== 'object')
    return undefined
  const record = data as { status?: unknown; title?: unknown }
  if (record.status !== 'generated' || typeof record.title !== 'string') return undefined
  const title = record.title.trim()
  return title ? title.slice(0, 256) : undefined
}

function sourcesOf(raw: string | null): number[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 1,
    )
  } catch {
    return []
  }
}

/** Daemon side tables: workspace, owner and user title per session. */
export function readSideTables(dataDir: string): SideTables {
  const workspaces = new Map<string, WorkspaceRow>()
  const principals = new Map<string, string>()
  const titles = new Map<string, string>()
  const dir = join(dataDir, 'tables')
  if (!existsSync(dir)) return { workspaces, principals, titles }
  try {
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.db')) continue
      const db = new DatabaseSync(join(dir, name), { readOnly: true })
      try {
        db.exec('PRAGMA query_only = ON')
        const tables = tableNames(db)
        if (tables.has('session_workspaces')) readWorkspaces(db, workspaces)
        if (tables.has('session_principal_ownership')) readPrincipals(db, principals)
        if (tables.has('session_preferences')) readTitles(db, titles)
      } finally {
        db.close()
      }
    }
  } catch (error) {
    if (error instanceof HistoryIndexError) throw error
    throw new HistoryIndexError('LEDGER')
  }
  return { workspaces, principals, titles }
}

function readWorkspaces(db: DatabaseSync, into: Map<string, WorkspaceRow>): void {
  const columns = columnNames(db, 'session_workspaces')
  if (!columns.has('session_key') || !columns.has('cwd')) throw new HistoryIndexError('LEDGER')
  const sql = columns.has('title')
    ? `SELECT session_key, cwd, title FROM session_workspaces`
    : `SELECT session_key, cwd, NULL AS title FROM session_workspaces`
  const rows = db.prepare(sql).all() as Array<{ session_key: string; cwd: string; title: string | null }>
  for (const row of rows) {
    if (!row.session_key || row.session_key.includes('\u0000') || !row.cwd || row.cwd.includes('\u0000'))
      continue
    const next: WorkspaceRow = { cwd: row.cwd }
    if (typeof row.title === 'string' && row.title.trim()) next.title = row.title.trim().slice(0, 256)
    const current = into.get(row.session_key)
    if (current && (current.cwd !== next.cwd || current.title !== next.title))
      throw new HistoryIndexError('LEDGER')
    into.set(row.session_key, next)
  }
}

function readPrincipals(db: DatabaseSync, into: Map<string, string>): void {
  const rows = db.prepare(`SELECT session_id, principal_id FROM session_principal_ownership`).all() as Array<{
    session_id: string
    principal_id: string
  }>
  for (const row of rows) {
    if (!row.session_id || !row.principal_id) continue
    if (row.session_id.includes('\u0000') || row.principal_id.includes('\u0000')) continue
    const current = into.get(row.session_id)
    if (current !== undefined && current !== row.principal_id) throw new HistoryIndexError('LEDGER')
    into.set(row.session_id, row.principal_id)
  }
}

function readTitles(db: DatabaseSync, into: Map<string, string>): void {
  const rows = db
    .prepare('SELECT session_key, title FROM session_preferences WHERE title IS NOT NULL')
    .all() as Array<{ session_key: string; title: string }>
  for (const row of rows) {
    if (typeof row.title !== 'string' || !row.title.trim()) continue
    const previous = into.get(row.session_key)
    if (previous && previous !== row.title) throw new HistoryIndexError('LEDGER')
    into.set(row.session_key, row.title)
  }
}

function toEvent(sessionId: string, row: EventRow): LedgerEvent {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch {
    data = undefined
  }
  const packed = eventBody(typeof row.data === 'string' ? row.data : '')
  const title = row.type === TITLE_EVENT ? generatedTitle(data, row.origin, row.trust) : undefined
  return {
    sessionId,
    seq: row.seq,
    id: row.id ?? null,
    ts: String(row.ts),
    type: row.type,
    text: data === undefined ? '' : extractText(data),
    body: packed.body,
    truncated: packed.truncated,
    sources: sourcesOf(row.source_event_seqs),
    ...(title ? { title } : {}),
  }
}

function readSessions(db: DatabaseSync, tables: Set<string>): Map<string, LedgerSession> {
  const sessions = new Map<string, LedgerSession>()
  if (!tables.has('sessions')) return sessions
  const columns = columnNames(db, 'sessions')
  const head =
    columns.has('head_version') && columns.has('head_seq')
      ? 'head_version, head_seq'
      : 'NULL AS head_version, NULL AS head_seq'
  const rows = db
    .prepare(`SELECT session_key, parent_key, created_at, ${head} FROM sessions`)
    .all() as Array<{
    session_key: string
    parent_key: string | null
    created_at: string
    head_version: number | null
    head_seq: number | null
  }>
  for (const row of rows) {
    const parent = row.parent_key && row.parent_key !== row.session_key ? row.parent_key : null
    const watermark =
      row.head_version === 1 && Number.isSafeInteger(row.head_seq) ? { head: row.head_seq as number } : {}
    sessions.set(row.session_key, { parentId: parent, createdAt: String(row.created_at ?? ''), ...watermark })
  }
  return sessions
}

/** Autocommit reads on a second connection, so each sees the newest commit. */
function newestReader(path: string, id: string) {
  let db: DatabaseSync | undefined
  return {
    holds(sessionId: string, seq: number, expected: string | null): boolean {
      db ??= new DatabaseSync(path, { readOnly: true })
      if (seq <= 0)
        return db.prepare('SELECT 1 FROM events WHERE session_key = ? LIMIT 1').get(sessionId) !== undefined
      const row = db
        .prepare(`SELECT ${id} FROM events WHERE session_key = ? AND seq = ?`)
        .get(sessionId, seq) as { id: string | null } | undefined
      return row !== undefined && (row.id ?? null) === expected
    },
    close: () => db?.close(),
  }
}

function appendedSince(db: DatabaseSync, rowid: number): { keys: string[]; rowid: number } {
  let top: number
  try {
    top = Number(
      (db.prepare('SELECT MAX(rowid) AS top FROM events').get() as { top: number | null }).top ?? 0,
    )
  } catch {
    // An events table without rowids has nothing to range over; every session is a candidate.
    const rows = db.prepare('SELECT DISTINCT session_key FROM events').all() as Array<{ session_key: string }>
    return { keys: rows.map((row) => row.session_key), rowid: 0 }
  }
  // A top below the mark means rows were removed and rowids can be handed out again.
  const rows = db
    .prepare('SELECT DISTINCT session_key FROM events WHERE rowid > ?')
    .all(top < rowid ? 0 : rowid) as Array<{ session_key: string }>
  return { keys: rows.map((row) => row.session_key), rowid: top }
}

/** Open the ledger read-only, never migrated. Undefined when the data directory has no ledger yet. */
export function openLedger(dataDir: string): LedgerReader | undefined {
  const path = join(dataDir, 'sessions.db')
  if (!existsSync(path)) return undefined
  const guard = <T>(read: () => T): T => {
    try {
      return read()
    } catch (error) {
      if (error instanceof HistoryIndexError) throw error
      throw new HistoryIndexError('LEDGER')
    }
  }
  const db = guard(() => new DatabaseSync(path, { readOnly: true }))
  try {
    return guard(() => {
      db.exec('PRAGMA query_only = ON')
      db.exec('BEGIN')
      const tables = tableNames(db)
      if (!tables.has('events')) throw new HistoryIndexError('LEDGER')
      const id = columnNames(db, 'events').has('id') ? 'id' : 'NULL AS id'
      const tail = db.prepare('SELECT MAX(seq) AS tail FROM events WHERE session_key = ?')
      const at = db.prepare(`SELECT ${id} FROM events WHERE session_key = ? AND seq = ?`)
      const rows = db.prepare(
        `SELECT seq, ${id}, ts, type, origin, trust, source_event_seqs, data FROM events
         WHERE session_key = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      const newest = newestReader(path, id)
      return {
        sessions: readSessions(db, tables),
        appended: (rowid) => guard(() => appendedSince(db, rowid)),
        tail: (sessionId) =>
          guard(() => {
            const value = (tail.get(sessionId) as { tail: number | null } | undefined)?.tail
            return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
          }),
        idAt: (sessionId, seq) =>
          guard(() => {
            const row = at.get(sessionId, seq) as { id: string | null } | undefined
            return row ? (row.id ?? null) : undefined
          }),
        events: (sessionId, after, limit) =>
          guard(() =>
            (rows.all(sessionId, after, limit) as EventRow[])
              .filter((row) => Number.isSafeInteger(row.seq))
              .map((row) => toEvent(sessionId, row)),
          ),
        holds: (sessionId, seq, expected) => guard(() => newest.holds(sessionId, seq, expected)),
        close: () => {
          newest.close()
          db.close()
        },
      }
    })
  } catch (error) {
    db.close()
    throw error
  }
}
