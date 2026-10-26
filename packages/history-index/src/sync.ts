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
    keys: db.prepare('SELECT session_id FROM sessions'),
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

/** Index writes in IMMEDIATE transactions of at most BATCH documents. */
class Batch {
  private open = false
  private pending = 0

  constructor(private readonly db: DatabaseSync) {}

  begin(): void {
    if (this.open) return
    this.db.exec('BEGIN IMMEDIATE')
    this.open = true
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
    this.db.exec('ROLLBACK')
  }
}

type Context = { sql: Statements; batch: Batch; ledger: LedgerReader | undefined; side: SideTables }

/**
 * Bring the index up to the ledger without reading again what it already holds. Each session keeps the
 * seq and id of the last event indexed; later events are read after it, and a session whose indexed tail
 * is gone or replaced is indexed again from its first event. The generation that pages carry moves only
 * when a session leaves or is indexed again, so an append leaves an open page valid.
 */
export function syncLedger(db: DatabaseSync, dataDir: string, stamp: string): void {
  const ledger = openLedger(dataDir)
  const sql = statements(db)
  const batch = new Batch(db)
  try {
    // Without a ledger there is no history; side tables alone do not make a session.
    const side = ledger ? readSideTables(dataDir) : NO_SIDE
    const appended = ledger?.appended(Number(metaValue(sql, 'ledger_rowid') ?? '0'))
    batch.begin()
    const keys = new Set<string>([
      ...(ledger?.sessions.keys() ?? []),
      ...side.workspaces.keys(),
      ...(appended?.keys ?? []),
      ...(sql.keys.all() as Array<{ session_id: string }>).map((row) => row.session_id),
    ])
    let reshaped = false
    for (const key of keys) {
      if (!key || key.includes('\u0000')) continue
      if (syncSession({ sql, batch, ledger, side }, key)) reshaped = true
    }
    batch.begin()
    const generation = Number(metaValue(sql, 'generation') ?? '0')
    if (generation === 0 || reshaped) sql.putMeta.run('generation', String(generation + 1))
    sql.putMeta.run('source_stamp', stamp)
    if (appended) sql.putMeta.run('ledger_rowid', String(appended.rowid))
    batch.commit()
  } catch (error) {
    batch.rollback()
    if (error instanceof HistoryIndexError) throw error
    throw new HistoryIndexError('INDEX')
  } finally {
    ledger?.close()
  }
}

/** Returns whether the session left the index or was indexed again from its start. */
function syncSession({ sql, batch, ledger, side }: Context, key: string): boolean {
  const session = ledger?.sessions.get(key)
  const tail = ledger?.tail(key)
  const present = tail !== undefined || session !== undefined || side.workspaces.has(key)
  let reshaped = false
  for (;;) {
    // Read again in every transaction: another process may have indexed part of this session meanwhile.
    batch.begin()
    const stored = sql.load.get(key) as Row | undefined
    if (!present) {
      if (!stored) return false
      removeDocs(sql, key, TITLE_SEQ, LAST_SEQ)
      sql.dropSession.run(key)
      batch.done(1)
      return true
    }
    let derived: Derived = stored ? pick(stored) : BLANK
    if (
      derived.seq > 0 &&
      (tail === undefined || derived.seq > tail || ledger?.idAt(key, derived.seq) !== derived.id)
    ) {
      removeDocs(sql, key, 1, LAST_SEQ)
      derived = BLANK
      reshaped = true
    }
    const events =
      ledger && tail !== undefined && tail > derived.seq ? ledger.events(key, derived.seq, BATCH) : []
    for (const event of events) {
      insertDoc(sql, event)
      derived = advance(derived, event)
    }
    const wrote = write(sql, key, stored, { ...derived, ...shown(key, derived, session, side) })
    batch.done(events.length + (wrote ? 1 : 0))
    if (events.length < BATCH) return reshaped
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
function write(sql: Statements, key: string, stored: Row | undefined, next: Row): boolean {
  if (stored && FIELDS.every((field) => stored[field] === next[field])) return false
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
  if (stored && stored.title === next.title && stored.createdAt === next.createdAt) return true
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
  return true
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
