import type { DatabaseSync } from 'node:sqlite'
import { HistoryIndexError } from './errors.js'
import {
  type LedgerEvent,
  type LedgerReader,
  type LedgerSession,
  openLedger,
  readSideTables,
  type SideTables,
} from './ledger.js'

/** The seq of a session's title document, below every ledger seq. */
export const TITLE_SEQ = -1
/** Documents per index transaction: a search in another process waits for one batch, not a whole build. */
const BATCH = 2000
const LAST_SEQ = Number.MAX_SAFE_INTEGER

/** What the index derived from a session's events, up to the last one it indexed. */
type Derived = {
  seq: number
  id: string | null
  firstTs: string | null
  generated: string | null
  prompt: string | null
}
type Shown = {
  workspace: string
  title: string
  createdAt: string
  parentId: string | null
  principal: string | null
}
type Row = Derived & Shown

const BLANK: Derived = { seq: 0, id: null, firstTs: null, generated: null, prompt: null }
const FIELDS = [
  'seq',
  'id',
  'firstTs',
  'generated',
  'prompt',
  'workspace',
  'title',
  'createdAt',
  'parentId',
  'principal',
] as const
const NO_SIDE: SideTables = { workspaces: new Map(), principals: new Map(), titles: new Map() }

function statements(db: DatabaseSync) {
  return {
    load: db.prepare(
      `SELECT indexed_seq AS seq, indexed_id AS id, first_ts AS firstTs, generated_title AS generated, prompt,
       workspace, title, created_at AS createdAt, parent_id AS parentId, principal FROM sessions WHERE session_id = ?`,
    ),
    all: db.prepare(
      `SELECT session_id AS key, indexed_seq AS seq, indexed_id AS id, first_ts AS firstTs, generated_title AS generated,
       prompt, workspace, title, created_at AS createdAt, parent_id AS parentId, principal FROM sessions`,
    ),
    upsert: db.prepare(
      `INSERT INTO sessions (session_id, workspace, title, created_at, parent_id, principal,
       indexed_seq, indexed_id, first_ts, generated_title, prompt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET workspace = excluded.workspace, title = excluded.title,
       created_at = excluded.created_at, parent_id = excluded.parent_id, principal = excluded.principal,
       indexed_seq = excluded.indexed_seq, indexed_id = excluded.indexed_id, first_ts = excluded.first_ts,
       generated_title = excluded.generated_title, prompt = excluded.prompt`,
    ),
    insert: db.prepare(
      `INSERT INTO docs (session_id, seq, ts, type, text, body, sources, truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    // The FTS table holds no text of its own: it is told each row, and a delete must repeat the row's
    // text. Kept here rather than in triggers, which made each insert several times slower.
    index: db.prepare('INSERT INTO docs_fts(rowid, text) VALUES (?, ?)'),
    unindex: db.prepare(
      `INSERT INTO docs_fts(docs_fts, rowid, text)
       SELECT 'delete', rowid, text FROM docs WHERE session_id = ? AND seq BETWEEN ? AND ?`,
    ),
    remove: db.prepare('DELETE FROM docs WHERE session_id = ? AND seq BETWEEN ? AND ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE session_id = ?'),
    meta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    putMeta: db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ),
  }
}
type Statements = ReturnType<typeof statements>

/**
 * Index writes in IMMEDIATE transactions of at most BATCH documents. The first write of a sync also moves
 * the generation in the same transaction, so a page issued before any committed change goes stale even
 * if the sync stops halfway.
 */
class Batch {
  private open = false
  private pending = 0
  private moved = false

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: Statements,
  ) {}

  begin(): void {
    if (this.open) return
    this.db.exec('BEGIN IMMEDIATE')
    this.open = true
  }

  /** Call before the first write of each change. */
  write(): void {
    if (this.moved) return
    this.moved = true
    this.sql.putMeta.run('generation', String(Number(metaValue(this.sql, 'generation') ?? '0') + 1))
  }

  done(count: number): void {
    this.pending += count
    if (this.pending >= BATCH) this.commit()
  }

  commit(): void {
    if (!this.open) return
    this.db.exec('COMMIT')
    this.open = false
    this.pending = 0
  }

  rollback(): void {
    if (!this.open) return
    this.open = false
    // SQLite has already rolled back after some errors (a full disk, an I/O error).
    if (this.db.isTransaction) this.db.exec('ROLLBACK')
  }
}

type Context = { sql: Statements; batch: Batch; ledger: LedgerReader | undefined; side: SideTables }

/**
 * Bring the index up to the ledger without reading again what it already holds. Each session keeps the
 * seq and id of the last event indexed; later events are read after it, and a session whose indexed tail
 * is gone or replaced is indexed again from its first event. A sync that changes anything moves the
 * generation, so an open page never silently shifts.
 */
export function syncLedger(db: DatabaseSync, dataDir: string, stamp: string): void {
  let ledger: LedgerReader | undefined
  let batch: Batch | undefined
  try {
    ledger = openLedger(dataDir)
    const sql = statements(db)
    batch = new Batch(db, sql)
    // Without a ledger there is no history; side tables alone do not make a session.
    const side = ledger ? readSideTables(dataDir) : NO_SIDE
    const appended = ledger?.appended(Number(metaValue(sql, 'ledger_rowid') ?? '0'))
    batch.begin()
    const stored = new Map((sql.all.all() as Array<Row & { key: string }>).map((row) => [row.key, row]))
    const fresh = new Set(appended?.keys ?? [])
    const keys = new Set<string>([
      ...(ledger?.sessions.keys() ?? []),
      ...side.workspaces.keys(),
      ...fresh,
      ...stored.keys(),
    ])
    for (const key of keys) {
      if (!key || key.includes('\u0000')) continue
      if (!fresh.has(key) && unchanged(key, stored.get(key), ledger, side)) continue
      syncSession({ sql, batch, ledger, side }, key)
    }
    batch.begin()
    if (Number(metaValue(sql, 'generation') ?? '0') === 0) batch.write()
    sql.putMeta.run('source_stamp', stamp)
    if (appended) sql.putMeta.run('ledger_rowid', String(appended.rowid))
    batch.commit()
  } catch (error) {
    batch?.rollback()
    if (error instanceof HistoryIndexError) throw error
    throw new HistoryIndexError('INDEX')
  } finally {
    ledger?.close()
  }
}

/** A stored session the ledger's append watermark and the side tables say nothing new about. */
function unchanged(
  key: string,
  stored: Row | undefined,
  ledger: LedgerReader | undefined,
  side: SideTables,
): boolean {
  const session = ledger?.sessions.get(key)
  if (!stored || session?.head === undefined || session.head !== stored.seq) return false
  const next: Row = { ...pick(stored), ...shown(key, stored, session, side) }
  return FIELDS.every((field) => stored[field] === next[field])
}

function syncSession({ sql, batch, ledger, side }: Context, key: string): void {
  const session = ledger?.sessions.get(key)
  const tail = session?.head ?? ledger?.tail(key)
  const present = tail !== undefined || session !== undefined || side.workspaces.has(key)
  for (;;) {
    // Read again in every transaction: another process may have indexed part of this session meanwhile.
    batch.begin()
    const stored = sql.load.get(key) as Row | undefined
    let derived: Derived = stored ? pick(stored) : BLANK
    const lost =
      !present ||
      (derived.seq > 0 &&
        (tail === undefined || derived.seq > tail || ledger?.idAt(key, derived.seq) !== derived.id))
    // Another process may have indexed from a newer commit than this snapshot; leave its work alone.
    if (lost && stored && ledger?.holds(key, derived.seq, derived.id)) return
    if (!present) {
      if (!stored) return
      batch.write()
      removeDocs(sql, key, TITLE_SEQ, LAST_SEQ)
      sql.dropSession.run(key)
      batch.done(1)
      return
    }
    if (lost) {
      batch.write()
      removeDocs(sql, key, 1, LAST_SEQ)
      derived = BLANK
    }
    const events =
      ledger && tail !== undefined && tail > derived.seq ? ledger.events(key, derived.seq, BATCH) : []
    if (events.length) batch.write()
    for (const event of events) {
      insertDoc(sql, event)
      derived = advance(derived, event)
    }
    const next = { ...derived, ...shown(key, derived, session, side) }
    if (stored && FIELDS.every((field) => stored[field] === next[field])) {
      batch.done(events.length)
    } else {
      batch.write()
      write(sql, key, stored, next)
      batch.done(events.length + 1)
    }
    if (events.length < BATCH) return
  }
}

function pick(row: Row): Derived {
  return { seq: row.seq, id: row.id, firstTs: row.firstTs, generated: row.generated, prompt: row.prompt }
}

function advance(derived: Derived, event: LedgerEvent): Derived {
  return {
    seq: event.seq,
    id: event.id,
    firstTs: derived.firstTs ?? event.ts,
    generated: event.title ?? derived.generated,
    prompt:
      derived.prompt ??
      (event.type === 'user/message' && event.text ? Array.from(event.text).slice(0, 56).join('') : null),
  }
}

function shown(key: string, derived: Derived, session: LedgerSession | undefined, side: SideTables): Shown {
  const workspace = side.workspaces.get(key)
  return {
    workspace: workspace?.cwd ?? '',
    title: side.titles.get(key) ?? derived.generated ?? workspace?.title ?? derived.prompt ?? '',
    createdAt: session?.createdAt || derived.firstTs || '',
    parentId: session?.parentId ?? null,
    principal: side.principals.get(key) ?? null,
  }
}

/** Writes the session row, and its title document when the title or its time changed. */
function write(sql: Statements, key: string, stored: Row | undefined, next: Row): void {
  sql.upsert.run(
    key,
    next.workspace,
    next.title,
    next.createdAt,
    next.parentId,
    next.principal,
    next.seq,
    next.id,
    next.firstTs,
    next.generated,
    next.prompt,
  )
  if (stored && stored.title === next.title && stored.createdAt === next.createdAt) return
  removeDocs(sql, key, TITLE_SEQ, TITLE_SEQ)
  if (next.title.trim())
    insertDoc(sql, {
      sessionId: key,
      seq: TITLE_SEQ,
      id: null,
      ts: next.createdAt,
      type: 'x/history/title',
      text: next.title,
      body: next.title,
      truncated: false,
      sources: [],
    })
}

function insertDoc(sql: Statements, event: LedgerEvent): void {
  const { lastInsertRowid } = sql.insert.run(
    event.sessionId,
    event.seq,
    event.ts,
    event.type,
    event.text,
    event.body,
    JSON.stringify(event.sources),
    event.truncated ? 1 : 0,
  )
  sql.index.run(lastInsertRowid, event.text)
}

function removeDocs(sql: Statements, key: string, from: number, to: number): void {
  sql.unindex.run(key, from, to)
  sql.remove.run(key, from, to)
}

function metaValue(sql: Statements, key: string): string | undefined {
  return (sql.meta.get(key) as { value: string } | undefined)?.value
}
