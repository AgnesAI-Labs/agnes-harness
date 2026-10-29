import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HistoryIndexError } from './errors.js'
import { sourceStamp } from './ledger.js'
import { syncLedger, TITLE_SEQ } from './sync.js'
import {
  decodeCursor,
  encodeCursor,
  ftsPhrase,
  HISTORY_FETCH_CAP,
  HISTORY_PAGE_MAX,
  type HistoryCursor,
  likeContains,
} from './text.js'

const APPLICATION_ID = 0x41474858
// v4 keeps each session's indexed tail, so a search adds only what the ledger appended. Older versions
// are dropped and indexed again on first use.
const SCHEMA_VERSION = 4

export type HistoryAccess =
  | { kind: 'caller'; self: string; workspace: string; principal: string }
  | { kind: 'local'; principal: string }

export type HistoryItem = {
  sessionId: string
  title: string
  workspace: string
  snippet: string
  ts: string
  seq?: number
  type?: string
}

export type HistoryPage = {
  items: HistoryItem[]
  next?: string
  truncated: boolean
  generation: number
}

export type HistoryQuery = {
  workspaceMatch?: 'exact' | 'contains'
  access: HistoryAccess
  kind: 'search' | 'list'
  query: string
  title: string
  workspace: string
  sessionId: string
  omitSelf: boolean
  beforeSeq?: number
  cursor?: string
  limit?: number
}

export type StoredSession = {
  sessionId: string
  title: string
  workspace: string
  createdAt: string
}

export type StoredEvent = {
  sessionId: string
  seq: number
  ts: string
  type: string
  text: string
  body: string
  truncated: boolean
  sources: number[]
}

export type LineageNode = { kind: 'session'; session: StoredSession } | { kind: 'unavailable' }

export type SessionTrace = {
  session: StoredSession | undefined
  ancestors: LineageNode[]
  descendants: LineageNode[]
  truncated: boolean
}

export type EventTrace = {
  event: StoredEvent
  sources: Array<{ kind: 'event'; event: StoredEvent } | { kind: 'unavailable' }>
  citedBy: StoredEvent[]
}

type HitRow = {
  sessionId: string
  seq: number
  ts: string
  type: string
  text: string
  snippet: string
  title: string
  workspace: string
}

function tighten(path: string): void {
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows rejects POSIX modes; the directory is still private to the user profile.
  }
  for (const suffix of ['-wal', '-shm']) {
    const side = `${path}${suffix}`
    if (!existsSync(side)) continue
    try {
      chmodSync(side, 0o600)
    } catch {
      // Same as the main file.
    }
  }
}

function pragmaNumber(db: DatabaseSync, name: 'application_id' | 'user_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, number> | undefined
  const value = row?.[name]
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return 20
  if (!Number.isSafeInteger(value) || value < 1 || value > HISTORY_PAGE_MAX)
    throw new HistoryIndexError('INVALID_REQUEST')
  return value
}

export function openHistoryIndex(indexPath: string): HistoryIndex {
  if (basename(indexPath) === 'sessions.db') throw new HistoryIndexError('INDEX')
  const dir = dirname(indexPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows rejects POSIX modes.
  }
  const ledger = join(dir, 'sessions.db')
  if (existsSync(ledger) && existsSync(indexPath) && realpathSync(ledger) === realpathSync(indexPath))
    throw new HistoryIndexError('INDEX')
  const db = new DatabaseSync(indexPath)
  try {
    tighten(indexPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 2000')
    db.exec('PRAGMA journal_size_limit = 4194304')
    const applicationId = pragmaNumber(db, 'application_id')
    const version = pragmaNumber(db, 'user_version')
    const tables = db.prepare(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'`).get() as {
      n: number
    }
    if (applicationId !== APPLICATION_ID && (applicationId !== 0 || tables.n > 0))
      throw new HistoryIndexError('INDEX')
    if (applicationId === APPLICATION_ID && version !== SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS docs_fts')
      db.exec('DROP TABLE IF EXISTS docs')
      db.exec('DROP TABLE IF EXISTS readers')
      db.exec('DROP TABLE IF EXISTS sessions')
      db.exec('DROP TABLE IF EXISTS meta')
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      workspace TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      parent_id TEXT,
      principal TEXT,
      indexed_seq INTEGER NOT NULL DEFAULT 0,
      indexed_id TEXT,
      first_ts TEXT,
      generated_title TEXT,
      prompt TEXT
    )`)
    db.exec('CREATE INDEX IF NOT EXISTS sessions_workspace ON sessions(workspace)')
    db.exec('CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id, session_id)')
    db.exec(`CREATE TABLE IF NOT EXISTS docs (
      rowid INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      body TEXT NOT NULL,
      sources TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, seq)
    )`)
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      text,
      content = 'docs',
      content_rowid = 'rowid',
      tokenize = 'unicode61'
    )`)
    return new HistoryIndex(db, indexPath)
  } catch (error) {
    db.close()
    if (error instanceof HistoryIndexError) throw error
    throw new HistoryIndexError('INDEX')
  }
}

export class HistoryIndex {
  private closed = false

  constructor(
    private readonly db: DatabaseSync,
    private readonly path: string,
  ) {}

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  generation(): number {
    this.live()
    return Number(this.meta('generation') ?? '0')
  }

  stamp(): string {
    this.live()
    return this.meta('source_stamp') ?? ''
  }

  principals(): string[] {
    this.live()
    const rows = this.db
      .prepare(`SELECT DISTINCT principal FROM sessions WHERE principal IS NOT NULL ORDER BY principal`)
      .all() as Array<{ principal: string }>
    return rows.map((row) => row.principal)
  }

  principalOf(sessionId: string): string {
    this.live()
    const row = this.db.prepare(`SELECT principal FROM sessions WHERE session_id = ?`).get(sessionId) as
      | { principal: string | null }
      | undefined
    return row?.principal ?? ''
  }

  /**
   * Bring the index up to the ledger and side tables in `dataDir`, reading only what was appended
   * since the last sync. Nothing is read while no source file has changed.
   */
  sync(dataDir: string): { generation: number; synced: boolean } {
    this.live()
    const stamp = sourceStamp(dataDir)
    if (this.stamp() === stamp && this.generation() > 0)
      return { generation: this.generation(), synced: false }
    syncLedger(this.db, dataDir, stamp)
    tighten(this.path)
    return { generation: this.generation(), synced: true }
  }

  canRead(sessionId: string, access: HistoryAccess): boolean {
    this.live()
    const visible = visibility(access)
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM sessions s WHERE s.session_id = ? AND ${visible.sql} LIMIT 1`)
      .get(sessionId, ...visible.params) as { ok: number } | undefined
    return row?.ok === 1
  }

  query(request: HistoryQuery): HistoryPage {
    this.live()
    const limit = pageLimit(request.limit)
    const filters = cursorFilters(request)
    let offset = 0
    if (request.cursor) {
      const cursor = decodeCursor(request.cursor)
      if (!cursor) throw new HistoryIndexError('INVALID_CURSOR')
      if (!cursorMatches(cursor, this.generation(), filters, limit))
        throw new HistoryIndexError('STALE_CURSOR')
      offset = cursor.o
    }
    if (request.kind === 'list') return this.list(request, limit, offset)
    return this.search(request, limit, offset)
  }

  /** Bounded recent excerpt. Authorization is rechecked even when the requested id was a search hit. */
  referenceExcerpt(
    access: HistoryAccess,
    sessionId: string,
  ): { title: string; text: string; truncated: boolean } {
    this.live()
    this.requireSession(access, sessionId)
    const session = this.session(sessionId)
    if (!session) throw new HistoryIndexError('NOT_FOUND')
    const rows = this.db
      .prepare(
        `SELECT seq, type, text, truncated FROM docs WHERE session_id = ? AND seq >= 1 AND type IN ('user/message', 'assistant/message') ORDER BY seq DESC LIMIT 25`,
      )
      .all(sessionId) as Array<{ seq: number; type: string; text: string; truncated: number }>
    const retained = rows.slice(0, 24).reverse()
    return {
      title: session.title || sessionId,
      text: retained.map((row) => `#${row.seq} ${row.type}\n${row.text}`).join('\n\n'),
      truncated: rows.length > 24 || retained.some((row) => row.truncated !== 0),
    }
  }

  readEvent(
    access: HistoryAccess,
    sessionId: string,
    seq: number,
    before: number,
    after: number,
  ): { event: StoredEvent; before: StoredEvent[]; after: StoredEvent[] } {
    this.live()
    this.requireSession(access, sessionId)
    const event = this.event(sessionId, seq)
    if (!event) throw new HistoryIndexError('NOT_FOUND')
    return {
      event,
      before: this.neighbors(sessionId, seq, before, 'before'),
      after: this.neighbors(sessionId, seq, after, 'after'),
    }
  }

  traceSession(access: HistoryAccess, sessionId: string): SessionTrace {
    this.live()
    if (access.kind === 'caller' && sessionId === access.self) {
      // The caller may inspect its own row even when the index has not recorded it yet.
    } else this.requireSession(access, sessionId)
    const session = this.session(sessionId)
    const ancestors: LineageNode[] = []
    let parentId = session ? this.parentId(session.sessionId) : null
    const seen = new Set<string>([sessionId])
    while (parentId && ancestors.length < 32) {
      if (seen.has(parentId) || !this.canRead(parentId, access)) {
        ancestors.push({ kind: 'unavailable' })
        break
      }
      const parent = this.session(parentId)
      if (!parent) {
        ancestors.push({ kind: 'unavailable' })
        break
      }
      seen.add(parentId)
      ancestors.push({ kind: 'session', session: parent })
      parentId = this.parentId(parent.sessionId)
    }
    const descendants: LineageNode[] = []
    const queue = [sessionId]
    let truncated = false
    while (queue.length > 0 && descendants.length < 64) {
      const current = queue.shift()
      if (!current) break
      for (const childId of this.childIds(current)) {
        if (seen.has(childId)) continue
        if (!this.canRead(childId, access)) {
          descendants.push({ kind: 'unavailable' })
          continue
        }
        const child = this.session(childId)
        if (!child) {
          descendants.push({ kind: 'unavailable' })
          continue
        }
        seen.add(childId)
        descendants.push({ kind: 'session', session: child })
        if (descendants.length >= 64) {
          truncated = true
          break
        }
        queue.push(childId)
      }
    }
    if (queue.length > 0) truncated = true
    return { session, ancestors, descendants, truncated }
  }

  traceEvent(access: HistoryAccess, sessionId: string, seq: number): EventTrace {
    this.live()
    this.requireSession(access, sessionId)
    const event = this.event(sessionId, seq)
    if (!event) throw new HistoryIndexError('NOT_FOUND')
    const sources = event.sources.map((sourceSeq) => {
      const source = this.event(sessionId, sourceSeq)
      return source ? { kind: 'event' as const, event: source } : { kind: 'unavailable' as const }
    })
    const citedBy = this.events(sessionId)
      .filter((item) => item.sources.includes(seq))
      .slice(0, 20)
    return { event, sources, citedBy }
  }

  private search(request: HistoryQuery, limit: number, offset: number): HistoryPage {
    const phrase = ftsPhrase(request.query)
    if (!phrase || request.query.trim().length > 256) throw new HistoryIndexError('INVALID_QUERY')
    const visible = visibility(request.access)
    const minSeq = request.sessionId ? 1 : TITLE_SEQ
    const params: Array<string | number> = [phrase, minSeq, ...visible.params]
    let sql = `SELECT e.session_id AS sessionId, e.seq AS seq, e.ts AS ts, e.type AS type, e.text AS text,
      snippet(docs_fts, 0, '[', ']', '…', 12) AS snippet,
      s.title AS title, s.workspace AS workspace
      FROM docs_fts
      JOIN docs e ON e.rowid = docs_fts.rowid
      JOIN sessions s ON s.session_id = e.session_id
      WHERE docs_fts MATCH ? AND e.seq >= ? AND ${visible.sql}`
    sql += this.filters(request, params)
    if (request.beforeSeq !== undefined && request.access.kind === 'caller') {
      sql += ' AND NOT (e.session_id = ? AND e.seq >= ?)'
      params.push(request.access.self, request.beforeSeq)
    }
    sql += ' ORDER BY bm25(docs_fts), length(e.text), e.ts, e.session_id, e.seq LIMIT ?'
    params.push(HISTORY_FETCH_CAP + 1)
    let rows: HitRow[]
    try {
      rows = this.db.prepare(sql).all(...params) as HitRow[]
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      if (/fts5|malformed MATCH/i.test(message)) throw new HistoryIndexError('INVALID_QUERY')
      throw new HistoryIndexError('FAILED')
    }
    let truncated = rows.length > HISTORY_FETCH_CAP
    // unicode61 treats a CJK title as one token. Also match literal title substrings, through
    // the same visibility and request filters; event text keeps its existing phrase semantics.
    if (!request.sessionId) {
      const titleParams: Array<string | number> = [likeContains(request.query.trim()), ...visible.params]
      let titleSql = `SELECT s.session_id AS sessionId, ${TITLE_SEQ} AS seq, s.created_at AS ts,
        'x/history/title' AS type, s.title AS text, s.title AS snippet,
        s.title AS title, s.workspace AS workspace FROM sessions s
        WHERE s.title LIKE ? ESCAPE '\\' AND ${visible.sql}`
      titleSql += this.filters(request, titleParams)
      titleSql += ' ORDER BY s.created_at, s.session_id LIMIT ?'
      titleParams.push(HISTORY_FETCH_CAP + 1)
      const titles = this.db.prepare(titleSql).all(...titleParams) as HitRow[]
      truncated ||= titles.length > HISTORY_FETCH_CAP
      rows = groupSessions([...titles, ...rows])
    }
    truncated ||= rows.length > HISTORY_FETCH_CAP
    const capped = truncated ? rows.slice(0, HISTORY_FETCH_CAP) : rows
    const grouped = request.sessionId ? capped : groupSessions(capped)
    return this.page(request, grouped.map(toItem), limit, offset, truncated)
  }

  private list(request: HistoryQuery, limit: number, offset: number): HistoryPage {
    if (request.title.length > 256 || request.workspace.length > 4096 || request.query.length > 256)
      throw new HistoryIndexError('INVALID_REQUEST')
    const visible = visibility(request.access)
    const params: Array<string | number> = [...visible.params]
    let sql = `SELECT session_id AS sessionId, title, workspace, created_at AS ts
      FROM sessions s WHERE ${visible.sql}`
    sql += this.filters(request, params)
    sql += ' ORDER BY created_at, session_id LIMIT ? OFFSET ?'
    params.push(limit + 1, offset)
    const rows = this.db.prepare(sql).all(...params) as Array<{
      sessionId: string
      title: string
      workspace: string
      ts: string
    }>
    const more = rows.length > limit
    const items = (more ? rows.slice(0, limit) : rows).map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      workspace: row.workspace,
      snippet: row.title,
      ts: row.ts,
    }))
    const generation = this.generation()
    const next = more
      ? encodeCursor({ ...cursorFilters(request), g: generation, o: offset + items.length, n: limit })
      : undefined
    return { items, ...(next ? { next } : {}), truncated: false, generation }
  }

  private filters(request: HistoryQuery, params: Array<string | number>): string {
    let sql = ''
    if (request.workspace) {
      // Local administration exposes a path-contains filter; caller tools keep exact workspace selection.
      sql +=
        request.access.kind === 'local' && request.workspaceMatch === 'contains'
          ? ' AND instr(lower(s.workspace), lower(?)) > 0'
          : ' AND s.workspace = ?'
      params.push(request.workspace)
    }
    if (request.title) {
      sql += ` AND s.title LIKE ? ESCAPE '\\'`
      params.push(likeContains(request.title))
    }
    if (request.sessionId) {
      sql += ' AND s.session_id = ?'
      params.push(request.sessionId)
    }
    if (request.omitSelf && request.access.kind === 'caller') {
      sql += ' AND s.session_id <> ?'
      params.push(request.access.self)
    }
    return sql
  }

  private page(
    request: HistoryQuery,
    items: HistoryItem[],
    limit: number,
    offset: number,
    truncated: boolean,
  ): HistoryPage {
    const slice = items.slice(offset, offset + limit)
    const more = offset + limit < items.length
    const generation = this.generation()
    const next = more
      ? encodeCursor({ ...cursorFilters(request), g: generation, o: offset + slice.length, n: limit })
      : undefined
    return { items: slice, ...(next ? { next } : {}), truncated, generation }
  }

  private requireSession(access: HistoryAccess, sessionId: string): void {
    if (this.canRead(sessionId, access)) return
    if (access.kind === 'caller' && sessionId === access.self) throw new HistoryIndexError('NOT_FOUND')
    throw new HistoryIndexError('DENIED')
  }

  private session(sessionId: string): StoredSession | undefined {
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, title, workspace, created_at AS createdAt FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as StoredSession | undefined
    return row
  }

  private parentId(sessionId: string): string | null {
    const row = this.db.prepare(`SELECT parent_id FROM sessions WHERE session_id = ?`).get(sessionId) as
      | { parent_id: string | null }
      | undefined
    return row?.parent_id ?? null
  }

  private childIds(sessionId: string): string[] {
    const rows = this.db
      .prepare(`SELECT session_id FROM sessions WHERE parent_id = ? ORDER BY session_id`)
      .all(sessionId) as Array<{ session_id: string }>
    return rows.map((row) => row.session_id)
  }

  private event(sessionId: string, seq: number): StoredEvent | undefined {
    if (!Number.isSafeInteger(seq) || seq < 1) return undefined
    const row = this.db
      .prepare(
        `SELECT session_id AS sessionId, seq, ts, type, text, body, truncated, sources
         FROM docs WHERE session_id = ? AND seq = ?`,
      )
      .get(sessionId, seq) as
      | {
          sessionId: string
          seq: number
          ts: string
          type: string
          text: string
          body: string
          truncated: number
          sources: string
        }
      | undefined
    if (!row) return undefined
    return { ...row, truncated: row.truncated === 1, sources: parseSources(row.sources) }
  }

  private events(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT session_id AS sessionId, seq, ts, type, text, body, truncated, sources
         FROM docs WHERE session_id = ? AND seq >= 1 ORDER BY seq`,
      )
      .all(sessionId) as Array<{
      sessionId: string
      seq: number
      ts: string
      type: string
      text: string
      body: string
      truncated: number
      sources: string
    }>
    return rows.map((row) => ({ ...row, truncated: row.truncated === 1, sources: parseSources(row.sources) }))
  }

  private neighbors(sessionId: string, seq: number, count: number, side: 'before' | 'after'): StoredEvent[] {
    if (count <= 0) return []
    const sql =
      side === 'before'
        ? `SELECT session_id AS sessionId, seq, ts, type, text, body, truncated, sources
           FROM docs WHERE session_id = ? AND seq >= 1 AND seq < ? ORDER BY seq DESC LIMIT ?`
        : `SELECT session_id AS sessionId, seq, ts, type, text, body, truncated, sources
           FROM docs WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`
    const rows = this.db.prepare(sql).all(sessionId, seq, count) as Array<{
      sessionId: string
      seq: number
      ts: string
      type: string
      text: string
      body: string
      truncated: number
      sources: string
    }>
    const events = rows.map((row) => ({
      ...row,
      truncated: row.truncated === 1,
      sources: parseSources(row.sources),
    }))
    return side === 'before' ? events.reverse() : events
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined
    return row?.value
  }

  private live(): void {
    if (this.closed) throw new HistoryIndexError('INDEX')
  }
}

function visibility(access: HistoryAccess): { sql: string; params: string[] } {
  if (access.kind === 'local') {
    return {
      sql: '(s.principal IS NULL OR s.principal = ?)',
      params: [access.principal],
    }
  }
  return {
    sql: `(s.session_id = ? OR (? <> '' AND s.workspace = ? AND (s.principal IS NULL OR s.principal = ?)))`,
    params: [access.self, access.workspace, access.workspace, access.principal],
  }
}

function cursorFilters(request: HistoryQuery): Omit<HistoryCursor, 'g' | 'o' | 'n'> {
  return {
    kind: request.kind,
    q: request.query,
    title: request.title,
    workspace: request.workspace,
    ...(request.workspaceMatch === 'contains' ? { workspaceMatch: 'contains' as const } : {}),
    sessionId: request.sessionId,
  }
}

function cursorMatches(
  cursor: HistoryCursor,
  generation: number,
  filters: Omit<HistoryCursor, 'g' | 'o' | 'n'>,
  limit: number,
): boolean {
  return (
    cursor.g === generation &&
    cursor.n === limit &&
    cursor.kind === filters.kind &&
    cursor.q === filters.q &&
    cursor.title === filters.title &&
    cursor.workspace === filters.workspace &&
    (cursor.workspaceMatch ?? 'exact') === (filters.workspaceMatch ?? 'exact') &&
    cursor.sessionId === filters.sessionId
  )
}

function groupSessions(rows: HitRow[]): HitRow[] {
  const seen = new Set<string>()
  const out: HitRow[] = []
  for (const row of rows) {
    if (seen.has(row.sessionId)) continue
    seen.add(row.sessionId)
    out.push(row)
  }
  return out
}

function toItem(row: HitRow): HistoryItem {
  const item: HistoryItem = {
    sessionId: row.sessionId,
    title: row.title,
    workspace: row.workspace,
    snippet: row.snippet || row.text.slice(0, 160),
    ts: row.ts,
  }
  if (row.seq >= 1) {
    item.seq = row.seq
    item.type = row.type
  }
  return item
}

function parseSources(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is number => typeof item === 'number')
  } catch {
    return []
  }
}
