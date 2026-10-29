import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchHistoryDirectory } from '../src/directory.js'
import { HistoryIndexError } from '../src/errors.js'
import * as ledger from '../src/ledger.js'
import { sourceStamp } from '../src/ledger.js'
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

function openSeed(before?: (dir: string) => void): {
  dir: string
  index: HistoryIndex
  access: HistoryAccess
} {
  const dir = tempDir()
  seed(dir)
  before?.(dir)
  const index = openHistoryIndex(join(dir, 'history-index.db'))
  indexes.push(index)
  index.sync(dir)
  const access: HistoryAccess = { kind: 'caller', self: 'self', workspace: '/work/a', principal: 'owner-a' }
  return { dir, index, access }
}

describe('history index', () => {
  it('defaults local filters to exact and refuses cursors from a different match mode', () => {
    const { index } = openSeed()
    const base = {
      access: { kind: 'local' as const, principal: 'owner-a' },
      kind: 'list' as const,
      query: '',
      title: '',
      workspace: '/work',
      sessionId: '',
      omitSelf: false,
      limit: 1,
    }
    expect(index.query(base).items).toEqual([])
    const page = index.query({ ...base, workspaceMatch: 'contains' })
    expect(page.items).toHaveLength(1)
    expect(page.next).toBeDefined()
    if (!page.next) throw new Error('Expected a second page')
    expect(() => index.query({ ...base, cursor: page.next as string })).toThrow()
    expect(index.query({ ...base, workspaceMatch: 'contains', cursor: page.next }).items).toHaveLength(1)
  })
  it('keeps caller workspace filters exact even when a fragment matches an authorized workspace', () => {
    const { index, access } = openSeed()
    for (const kind of ['list', 'search'] as const) {
      const result = index.query({
        access,
        kind,
        query: kind === 'search' ? 'alpha' : '',
        title: '',
        workspace: '/work',
        sessionId: '',
        omitSelf: false,
      })
      expect(result.items).toEqual([])
    }
  })
  it('creates the v4 schema: indexed tails, parent index and external-content FTS', () => {
    const { dir, index } = openSeed()
    index.close()
    const db = new DatabaseSync(join(dir, 'history-index.db'), { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
      expect(
        db
          .prepare(`SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`)
          .all(),
      ).toEqual([
        { type: 'index', name: 'sessions_parent' },
        { type: 'index', name: 'sessions_workspace' },
        { type: 'table', name: 'docs' },
        { type: 'table', name: 'docs_fts' },
        { type: 'table', name: 'docs_fts_config' },
        { type: 'table', name: 'docs_fts_data' },
        { type: 'table', name: 'docs_fts_docsize' },
        { type: 'table', name: 'docs_fts_idx' },
        { type: 'table', name: 'meta' },
        { type: 'table', name: 'sessions' },
      ])
      expect(
        (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map((c) => c.name),
      ).toEqual([
        'session_id',
        'workspace',
        'title',
        'created_at',
        'parent_id',
        'principal',
        'indexed_seq',
        'indexed_id',
        'first_ts',
        'generated_title',
        'prompt',
      ])
      expect(
        db.prepare(`SELECT indexed_seq, indexed_id FROM sessions WHERE session_id = 'self'`).get(),
      ).toEqual({
        indexed_seq: 3,
        indexed_id: 'self:3',
      })
      const fts = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'docs_fts'`).get() as { sql: string }
      expect(fts.sql).toMatch(/content\s*=\s*'docs'/)
      expect(fts.sql).toMatch(/content_rowid\s*=\s*'rowid'/)
      expect(
        db
          .prepare(
            `SELECT session_id, principal FROM sessions WHERE session_id IN ('readerless', 'self') ORDER BY session_id`,
          )
          .all(),
      ).toEqual([
        { session_id: 'readerless', principal: null },
        { session_id: 'self', principal: 'owner-a' },
      ])
    } finally {
      db.close()
    }
  })

  it('drops a v2 index with a readers table and recreates it at v4', () => {
    const dir = tempDir()
    const path = join(dir, 'history-index.db')
    const old = new DatabaseSync(path)
    old.exec('PRAGMA application_id = 1095190616') // 0x41474858
    old.exec('PRAGMA user_version = 2')
    old.exec(
      'CREATE TABLE readers (session_id TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY (session_id, principal))',
    )
    old.close()
    const index = openHistoryIndex(path)
    indexes.push(index)
    index.close()
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'readers'`).get()).toBeUndefined()
    } finally {
      db.close()
    }
  })

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
    // Whole-ledger hits for 'peer' are collapsed into its title row (titles fall back to the first
    // prompt), so pin the FTS snippet column with a session-scoped search, which skips title matching.
    const scoped = index.query({
      access,
      kind: 'search',
      query: 'alpha bridge',
      title: '',
      workspace: '',
      sessionId: 'peer',
      omitSelf: true,
      limit: 20,
    })
    expect(scoped.items.map((item) => item.snippet)).toEqual(['[alpha bridge] repair extra'])
    expect(sha(join(dir, 'sessions.db'))).toBe(ledger)
    const substring = index.query({
      access,
      kind: 'search',
      query: 'ridg',
      title: '',
      workspace: '',
      // Within a session only event text is searched; title substrings are a session-search feature.
      sessionId: 'peer',
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

  it('finds visible renamed and provisional CJK titles while retaining caller and workspace filters', () => {
    // The ledger never rewrites an event, so the provisional prompts are in place before the first sync.
    const { dir, index, access } = openSeed((seeded) => {
      const ledger = new DatabaseSync(join(seeded, 'sessions.db'))
      ledger
        .prepare(
          "UPDATE events SET data = ? WHERE type = 'user/message' AND seq = 1 AND session_key IN ('peer', 'away', 'other-owner')",
        )
        .run(JSON.stringify({ content: [{ type: 'text', text: '读取示例销售 CSV，计算收入。' }] }))
      ledger.close()
    })
    const side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
    side.exec('CREATE TABLE session_preferences (session_key TEXT PRIMARY KEY, title TEXT)')
    side.prepare('INSERT INTO session_preferences VALUES (?, ?)').run('self', '销售报告（人工标题）')
    side.close()
    const before = sha(join(dir, 'sessions.db'))
    index.sync(dir)
    const query = {
      access,
      kind: 'search' as const,
      query: '销售',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: false,
    }
    const page = index.query(query)
    expect(page.items.map((item) => item.sessionId).sort()).toEqual(['peer', 'self'])
    expect(page.items.find((item) => item.sessionId === 'peer')?.title).toBe('读取示例销售 CSV，计算收入。')
    expect(page.items.find((item) => item.sessionId === 'self')?.title).toBe('销售报告（人工标题）')
    expect(index.query({ ...query, omitSelf: true }).items.map((item) => item.sessionId)).toEqual(['peer'])
    expect(index.query({ ...query, query: '%' }).items).toEqual([])
    expect(index.query({ ...query, sessionId: 'peer' }).items).toEqual([])
    expect(sha(join(dir, 'sessions.db'))).toBe(before)
  })

  it('lists titles in the caller workspace, keeps a cursor while nothing indexed changes and rejects it after an append', () => {
    const { dir, index, access } = openSeed()
    const titled = index.query({
      access,
      kind: 'list',
      query: '',
      title: 'Bridge notes',
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
    const next = {
      access,
      kind: 'list' as const,
      query: '',
      title: '',
      workspace: '',
      sessionId: '',
      omitSelf: false,
      limit: 1,
      cursor,
    }
    const side = new DatabaseSync(join(dir, 'tables', 'daemon.db'))
    side.exec('CREATE TABLE unrelated (id INTEGER)')
    side.close()
    expect(index.sync(dir)).toEqual({ synced: true, generation: page.generation })
    expect(index.query(next).items).toHaveLength(1)
    const ledger = new DatabaseSync(join(dir, 'sessions.db'))
    ledger
      .prepare(
        `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
         VALUES ('peer', 2, '2026-01-01T00:00:09Z', 'peer:2', 'user/message', 'user', 'untrusted', NULL, ?)`,
      )
      .run(JSON.stringify({ text: 'appended later' }))
    ledger.close()
    expect(index.sync(dir).generation).toBe(page.generation + 1)
    expect(() => index.query(next)).toThrow(HistoryIndexError)
  })

  it('reads an authorized event and marks an unauthorized parent without its id', () => {
    const { index, access } = openSeed()
    const read = index.readEvent(access, 'self', 3, 1, 0)
    expect(index.referenceExcerpt(access, 'peer').text).toContain('alpha bridge repair extra')
    for (const id of ['other-owner', 'away', 'missing'])
      expect(() => index.referenceExcerpt(access, id)).toThrowError(HISTORY_DENIED())
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
    const page = searchHistoryDirectory(dir, {
      query: 'alpha bridge',
      title: 'Bridge notes',
      workspace: '/work/a',
    })
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

  it('indexes a commit that landed only in the ledger wal', () => {
    const dir = tempDir()
    const path = join(dir, 'sessions.db')
    const db = new DatabaseSync(path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA wal_autocheckpoint = 0')
    db.exec(`CREATE TABLE events (
      session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, origin TEXT, trust TEXT,
      source_event_seqs TEXT, data TEXT
    )`)
    db.exec(`CREATE TABLE sessions (session_key TEXT PRIMARY KEY, parent_key TEXT, created_at TEXT)`)
    db.prepare(
      `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
       VALUES ('before', 1, 't', 'before:1', 'user/message', 'user', 'untrusted', NULL, ?)`,
    ).run(JSON.stringify({ text: 'alpha bridge before' }))
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    const listed = searchHistoryDirectory(dir, { query: '', title: '', workspace: '' })
    expect(listed.items.map((item) => item.sessionId)).toEqual(['before'])
    const main = statSync(path)
    const next = new DatabaseSync(path)
    try {
      next.exec('PRAGMA journal_mode = WAL')
      next.exec('PRAGMA wal_autocheckpoint = 0')
      next
        .prepare(
          `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
           VALUES ('after', 1, 't2', 'after:1', 'user/message', 'user', 'untrusted', NULL, ?)`,
        )
        .run(JSON.stringify({ text: 'wal only marker' }))
      const after = statSync(path)
      expect(after.size).toBe(main.size)
      expect(after.mtimeMs).toBe(main.mtimeMs)
      expect(existsSync(`${path}-wal`)).toBe(true)
      expect(sourceStamp(dir)).toContain(`${path}-wal:`)
      // A reader writes its read mark to -shm; counting it would make every sync see a change.
      expect(sourceStamp(dir)).not.toContain('-shm')
      const page = searchHistoryDirectory(dir, { query: 'wal only marker', title: '', workspace: '' })
      expect(page.items.map((item) => item.sessionId)).toEqual(['after'])
      const stamp = sourceStamp(dir)
      searchHistoryDirectory(dir, { query: 'wal only marker', title: '', workspace: '' })
      expect(sourceStamp(dir)).toBe(stamp)
    } finally {
      next.close()
    }
  })

  it('opens no ledger while the source stamp is unchanged, then reads only the appended event', () => {
    const dir = tempDir()
    const path = join(dir, 'sessions.db')
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE events (
      session_key TEXT, seq INTEGER, ts TEXT, id TEXT, type TEXT, origin TEXT, trust TEXT,
      source_event_seqs TEXT, data TEXT
    )`)
    db.prepare(
      `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
       VALUES ('one', 1, 't', 'one:1', 'user/message', 'user', 'untrusted', NULL, ?)`,
    ).run(JSON.stringify({ text: 'alpha bridge once' }))
    db.close()
    searchHistoryDirectory(dir, { query: '', title: '', workspace: '' })
    const open = vi.spyOn(ledger, 'openLedger')
    searchHistoryDirectory(dir, { query: '', title: '', workspace: '' })
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()

    const again = new DatabaseSync(path)
    again
      .prepare(
        `INSERT INTO events (session_key, seq, ts, id, type, origin, trust, source_event_seqs, data)
         VALUES ('two', 1, 't2', 'two:1', 'user/message', 'user', 'untrusted', NULL, ?)`,
      )
      .run(JSON.stringify({ text: 'alpha bridge twice' }))
    again.close()
    const read: string[] = []
    const realOpen = ledger.openLedger
    const counted = vi.spyOn(ledger, 'openLedger').mockImplementation((dataDir: string) => {
      const reader = realOpen(dataDir)
      if (!reader) return reader
      return {
        ...reader,
        events: (sessionId, after, limit) => {
          const events = reader.events(sessionId, after, limit)
          read.push(...events.map((event) => `${event.sessionId}:${event.seq}`))
          return events
        },
      }
    })
    try {
      const page = searchHistoryDirectory(dir, { query: '', title: '', workspace: '' })
      expect(page.items.map((item) => item.sessionId).sort()).toEqual(['one', 'two'])
      expect(read).toEqual(['two:1'])
    } finally {
      counted.mockRestore()
    }
  })

  it('refuses to open the ledger as the index and an unreadable ledger', () => {
    const dir = tempDir()
    const ledger = new DatabaseSync(join(dir, 'sessions.db'))
    ledger.exec('CREATE TABLE unrelated (id INTEGER)')
    ledger.close()
    expect(() => openHistoryIndex(join(dir, 'sessions.db'))).toThrow(HistoryIndexError)
    const index = openHistoryIndex(join(dir, 'history-index.db'))
    indexes.push(index)
    expect(() => index.sync(dir)).toThrow(/ledger/i)
    const empty = tempDir()
    const fresh = openHistoryIndex(join(empty, 'history-index.db'))
    indexes.push(fresh)
    expect(fresh.sync(empty)).toEqual({ generation: 1, synced: true })
    expect(fresh.principals()).toEqual([])
  })
})

function HISTORY_DENIED(): RegExp {
  return /Not authorized to read that session/
}
