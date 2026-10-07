import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { searchHistoryDirectory } from '../src/directory.js'
import { HistoryIndexError } from '../src/errors.js'
import { readLedgerDirectory } from '../src/ledger.js'
import { type HistoryAccess, type HistoryIndex, openHistoryIndex } from '../src/store.js'

const dirs: string[] = []
const indexes: HistoryIndex[] = []

afterEach(() => {
  for (const index of indexes.splice(0)) index.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agh-history-'))
  dirs.push(dir)
  return dir
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function seed(dir: string): void {
  const ledger = new DatabaseSync(join(dir, 'sessions.db'))
  ledger.exec(`CREATE TABLE events (
    session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, id TEXT NOT NULL,
    type TEXT NOT NULL, origin TEXT NOT NULL, trust TEXT NOT NULL, source_event_seqs TEXT, data TEXT NOT NULL
  )`)
  ledger.exec(`CREATE TABLE sessions (
    session_key TEXT PRIMARY KEY, parent_key TEXT, boundary_seq INTEGER, created_at TEXT NOT NULL
  )`)
  const event = ledger.prepare(
    `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const session = ledger.prepare(
    `INSERT INTO sessions (session_key, parent_key, created_at) VALUES (?, ?, ?)`,
  )
  const say = (key: string, seq: number, text: string, sources?: number[]) =>
    event.run(
      key,
      seq,
      `2026-01-01T00:00:0${seq}Z`,
      `${key}:${seq}`,
      'user/message',
      'user',
      'untrusted',
      sources ? JSON.stringify(sources) : null,
      JSON.stringify({ content: [{ type: 'text', text }] }),
    )
  session.run('self', 'parent-secret', '2026-01-01T00:00:00Z')
  session.run('peer', null, '2026-01-01T00:00:01Z')
  session.run('other-owner', null, '2026-01-01T00:00:02Z')
  session.run('away', null, '2026-01-01T00:00:03Z')
  session.run('readerless', null, '2026-01-01T00:00:04Z')
  session.run('parent-secret', null, '2026-01-01T00:00:05Z')
  session.run('child-ok', 'self', '2026-01-01T00:00:06Z')
  session.run('child-secret', 'self', '2026-01-01T00:00:07Z')
  event.run(
    'self',
    1,
    '2026-01-01T00:00:01Z',
    'self:title',
    'x/host/session-title',
    'system',
    'trusted',
    null,
    JSON.stringify({ status: 'generated', title: 'Bridge notes' }),
  )
  say('self', 2, 'alpha bridge repair')
  say('self', 3, 'follow the bridge', [2])
  say('peer', 1, 'alpha bridge repair extra')
  say('other-owner', 1, 'alpha bridge repair secret')
  say('away', 1, 'alpha bridge repair elsewhere')
  say('readerless', 1, 'alpha bridge repair public')
  say('parent-secret', 1, 'hidden parent text')
  say('child-ok', 1, 'visible child')
  say('child-secret', 1, 'hidden child')
  say('secret-only', 1, 'secret')
  ledger.close()

  const tables = join(dir, 'tables')
  mkdirSync(tables)
  const side = new DatabaseSync(join(tables, 'daemon.db'))
  side.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT)`)
  side.exec(`CREATE TABLE session_principal_ownership (
    session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL,
    reservation_kind TEXT NOT NULL, reservation_state TEXT NOT NULL
  )`)
  const workspace = side.prepare(`INSERT INTO session_workspaces (session_key, cwd, title) VALUES (?, ?, ?)`)
  const owner = side.prepare(
    `INSERT INTO session_principal_ownership
     (session_id, principal_id, reservation_kind, reservation_state) VALUES (?, ?, 'new', 'ready')`,
  )
  for (const [key, cwd] of [
    ['self', '/work/a'],
    ['peer', '/work/a'],
    ['other-owner', '/work/a'],
    ['away', '/work/b'],
    ['readerless', '/work/a'],
    ['parent-secret', '/work/b'],
    ['child-ok', '/work/a'],
    ['child-secret', '/work/b'],
    ['secret-only', '/work/a'],
  ] as const) {
    workspace.run(key, cwd, null)
  }
  for (const [key, principal] of [
    ['self', 'owner-a'],
    ['peer', 'owner-a'],
    ['other-owner', 'owner-b'],
    ['away', 'owner-a'],
    ['parent-secret', 'owner-b'],
    ['child-ok', 'owner-a'],
    ['child-secret', 'owner-b'],
    ['secret-only', 'owner-a'],
  ] as const) {
    owner.run(key, principal)
  }
  side.close()
}

function openSeed(): { dir: string; index: HistoryIndex; access: HistoryAccess } {
  const dir = tempDir()
  seed(dir)
  const index = openHistoryIndex(join(dir, 'history-index.db'))
  indexes.push(index)
  index.rebuild(readLedgerDirectory(dir))
  const access: HistoryAccess = { kind: 'caller', self: 'self', workspace: '/work/a', principal: 'owner-a' }
  return { dir, index, access }
}

describe('history index', () => {
  it('finds a literal phrase and hides other workspaces, owners, and the caller', () => {
    const { dir, index, access } = openSeed()
    const ledger = sha(join(dir, 'sessions.db'))
    const page = index.query({
      access,
      kind: 'search',
      query: 'alpha bridge',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: true,
      limit: 20,
    })
    expect(page.items.map((item) => item.sessionId).sort()).toEqual(['peer', 'readerless'])
    expect(page.items.some((item) => item.snippet.toLowerCase().includes('alpha'))).toBe(true)
    expect(sha(join(dir, 'sessions.db'))).toBe(ledger)
    const substring = index.query({
      access,
      kind: 'search',
      query: 'ridg',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: true,
    })
    expect(substring.items).toEqual([])
    const operators = index.query({
      access,
      kind: 'search',
      query: 'alpha OR secret',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: true,
    })
    expect(operators.items).toEqual([])
  })

  it('lists titles in the caller workspace and rejects a stale cursor', () => {
    const { dir, index, access } = openSeed()
    const titled = index.query({
      access,
      kind: 'list',
      query: '',
      title: 'Bridge',
      workspace: '',
      sessionId: '',
      omitSelf: false,
      limit: 20,
    })
    expect(titled.items.map((item) => item.sessionId)).toEqual(['self'])
    const page = index.query({
      access,
      kind: 'list',
      query: '',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: false,
      limit: 1,
    })
    expect(page.items).toHaveLength(1)
    if (!page.next) throw new Error('expected a next cursor')
    const cursor = page.next
    index.rebuild({ ...readLedgerDirectory(dir), stamp: 'changed' })
    expect(() =>
      index.query({
        access,
        kind: 'list',
        query: '',
        title: '',
        workspace: '',
        sessionId: '',
        omitSelf: false,
        limit: 1,
        cursor,
      }),
    ).toThrow(HistoryIndexError)
  })

  it('reads an authorized event and marks an unauthorized parent without its id', () => {
    const { index, access } = openSeed()
    const read = index.readEvent(access, 'self', 3, 1, 0)
    expect(read.event.sources).toEqual([2])
    expect(read.before.map((event) => event.seq)).toEqual([2])
    expect(read.event.body).toContain('follow the bridge')
    const trace = index.traceSession(access, 'self')
    expect(trace.ancestors).toEqual([{ kind: 'unavailable' }])
    expect(
      trace.descendants.some((node) => node.kind === 'session' && node.session.sessionId === 'child-ok'),
    ).toBe(true)
    expect(JSON.stringify(trace)).not.toContain('parent-secret')
    expect(JSON.stringify(trace)).not.toContain('child-secret')
    expect(() => index.readEvent(access, 'other-owner', 1, 0, 0)).toThrowError(HISTORY_DENIED())
    expect(() => index.readEvent(access, 'missing', 1, 0, 0)).toThrowError(HISTORY_DENIED())
    expect(() => index.readEvent(access, 'self', 99, 0, 0)).toThrowError(/Event not found/)
  })

  it('uses the sole principal for directory search and refuses several owners', () => {
    const dir = tempDir()
    const ledger = new DatabaseSync(join(dir, 'sessions.db'))
    ledger.exec(`CREATE TABLE events (
      session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, origin TEXT, trust TEXT,
      source_event_seqs TEXT, data TEXT
    )`)
    ledger.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, parent_key TEXT, created_at TEXT)`)
    const event = ledger.prepare(
      `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
       VALUES (?, 1, 't', ?, 'user/message', 'user', 'untrusted', NULL, ?)`,
    )
    event.run('mine', 'mine:1', JSON.stringify({ text: 'alpha bridge repair' }))
    event.run('open', 'open:1', JSON.stringify({ text: 'alpha bridge repair public' }))
    event.run('far', 'far:1', JSON.stringify({ text: 'alpha bridge repair elsewhere' }))
    ledger.close()
    mkdirSync(join(dir, 'tables'))
    const side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
    side.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT)`)
    side.exec(
      `CREATE TABLE session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)`,
    )
    const workspace = side.prepare(
      `INSERT INTO session_workspaces (session_key, cwd, title) VALUES (?, ?, ?)`,
    )
    workspace.run('mine', '/work/a', 'Bridge notes')
    workspace.run('open', '/work/a', null)
    workspace.run('far', '/work/b', null)
    side
      .prepare(`INSERT INTO session_principal_ownership (session_id, principal_id) VALUES (?, ?)`)
      .run('mine', 'owner-a')
    side.close()
    const page = searchHistoryDirectory(dir, { query: 'alpha bridge', title: 'Bridge', workspace: '/work/a' })
    expect(page.items.map((item) => item.sessionId)).toEqual(['mine'])
    const listed = searchHistoryDirectory(dir, { query: '', title: '', workspace: '/work/a' })
    expect(listed.items.map((item) => item.sessionId).sort()).toEqual(['mine', 'open'])
    const second = new DatabaseSync(join(dir, 'tables', 'other.db'))
    second.exec(`CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL)`)
    second.exec(
      `CREATE TABLE session_principal_ownership (session_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL)`,
    )
    second.prepare(`INSERT INTO session_workspaces (session_key, cwd) VALUES (?, ?)`).run('extra', '/work/a')
    second
      .prepare(`INSERT INTO session_principal_ownership (session_id, principal_id) VALUES (?, ?)`)
      .run('extra', 'owner-c')
    second.close()
    expect(() => searchHistoryDirectory(dir, { query: '', title: '', workspace: '' })).toThrow(
      /multiple owners/i,
    )
  })

  it('refuses to open the ledger as the index and an unreadable ledger', () => {
    const dir = tempDir()
    const ledger = new DatabaseSync(join(dir, 'sessions.db'))
    ledger.exec('CREATE TABLE unrelated (id INTEGER)')
    ledger.close()
    expect(() => openHistoryIndex(join(dir, 'sessions.db'))).toThrow(HistoryIndexError)
    expect(() => readLedgerDirectory(dir)).toThrow(/ledger/i)
    const empty = tempDir()
    expect(readLedgerDirectory(empty)).toMatchObject({ sessions: [], events: [] })
  })
})

function HISTORY_DENIED(): RegExp {
  return /Not authorized to read that session/
}
