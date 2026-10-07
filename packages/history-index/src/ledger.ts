import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HistoryIndexError } from './errors.js'
import { eventBody, extractText } from './text.js'

const TITLE_EVENT = 'x/host/session-title'

export type LedgerSession = {
  sessionId: string
  workspace: string
  title: string
  createdAt: string
  parentId: string | null
  principals: string[]
}

export type LedgerEvent = {
  sessionId: string
  seq: number
  ts: string
  type: string
  text: string
  body: string
  truncated: boolean
  sources: number[]
}

export type HistoryCorpus = {
  stamp: string
  sessions: LedgerSession[]
  events: LedgerEvent[]
}

type WorkspaceRow = { cwd: string; title?: string }
type EventRow = {
  session_key: string
  seq: number
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

export function sourceStamp(dataDir: string): string {
  const parts = [stampFile(join(dataDir, 'sessions.db'))]
  const tables = join(dataDir, 'tables')
  if (existsSync(tables)) {
    for (const name of readdirSync(tables).sort()) {
      if (name.endsWith('.db') || name.endsWith('.db-wal') || name.endsWith('.db-shm'))
        parts.push(stampFile(join(tables, name)))
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

function readSideTables(dataDir: string): {
  workspaces: Map<string, WorkspaceRow>
  principals: Map<string, string>
} {
  const workspaces = new Map<string, WorkspaceRow>()
  const principals = new Map<string, string>()
  const dir = join(dataDir, 'tables')
  if (!existsSync(dir)) return { workspaces, principals }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.db')) continue
    const db = new DatabaseSync(join(dir, name), { readOnly: true })
    try {
      db.exec('PRAGMA query_only = ON')
      const tables = tableNames(db)
      if (tables.has('session_workspaces')) readWorkspaces(db, workspaces)
      if (tables.has('session_principal_ownership')) readPrincipals(db, principals)
    } finally {
      db.close()
    }
  }
  return { workspaces, principals }
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

/** Read the ledger and daemon side tables. The ledger is opened read-only and never migrated. */
export function readLedgerDirectory(dataDir: string): HistoryCorpus {
  const stamp = sourceStamp(dataDir)
  const ledger = join(dataDir, 'sessions.db')
  if (!existsSync(ledger)) return { stamp, sessions: [], events: [] }
  const db = new DatabaseSync(ledger, { readOnly: true })
  try {
    db.exec('PRAGMA query_only = ON')
    const tables = tableNames(db)
    if (!tables.has('events')) throw new HistoryIndexError('LEDGER')
    const parents = new Map<string, { parentId: string | null; createdAt: string }>()
    if (tables.has('sessions')) {
      const rows = db.prepare(`SELECT session_key, parent_key, created_at FROM sessions`).all() as Array<{
        session_key: string
        parent_key: string | null
        created_at: string
      }>
      for (const row of rows) {
        const parent = row.parent_key && row.parent_key !== row.session_key ? row.parent_key : null
        parents.set(row.session_key, { parentId: parent, createdAt: String(row.created_at ?? '') })
      }
    }
    const side = readSideTables(dataDir)
    const events: LedgerEvent[] = []
    const titles = new Map<string, string>()
    const firstTs = new Map<string, string>()
    const rows = db
      .prepare(
        `SELECT session_key, seq, ts, type, origin, trust, source_event_seqs, data
         FROM events ORDER BY session_key, seq`,
      )
      .all() as EventRow[]
    for (const row of rows) {
      if (!row.session_key || !Number.isSafeInteger(row.seq)) continue
      let data: unknown
      try {
        data = JSON.parse(row.data)
      } catch {
        data = undefined
      }
      const text = data === undefined ? '' : extractText(data)
      const packed = eventBody(typeof row.data === 'string' ? row.data : '')
      const ts = String(row.ts)
      if (!firstTs.has(row.session_key)) firstTs.set(row.session_key, ts)
      if (row.type === TITLE_EVENT) {
        const title = generatedTitle(data, row.origin, row.trust)
        if (title) titles.set(row.session_key, title)
      }
      events.push({
        sessionId: row.session_key,
        seq: row.seq,
        ts,
        type: row.type,
        text,
        body: packed.body,
        truncated: packed.truncated,
        sources: sourcesOf(row.source_event_seqs),
      })
    }
    const ids = new Set<string>([
      ...parents.keys(),
      ...events.map((event) => event.sessionId),
      ...side.workspaces.keys(),
    ])
    const sessions: LedgerSession[] = []
    for (const sessionId of ids) {
      if (!sessionId || sessionId.includes('\u0000')) continue
      const workspace = side.workspaces.get(sessionId)
      const parent = parents.get(sessionId)
      const generated = titles.get(sessionId)
      const title = generated ?? workspace?.title ?? ''
      const principal = side.principals.get(sessionId)
      sessions.push({
        sessionId,
        workspace: workspace?.cwd ?? '',
        title,
        createdAt: parent?.createdAt || firstTs.get(sessionId) || '',
        parentId: parent?.parentId ?? null,
        principals: principal ? [principal] : [],
      })
    }
    return { stamp, sessions, events }
  } catch (error) {
    if (error instanceof HistoryIndexError) throw error
    throw new HistoryIndexError('LEDGER')
  } finally {
    db.close()
  }
}
