import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage, type TableHandle as HostTableHandle } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import {
  MemorySessionWorkspaces,
  SessionWorkspaceIndex,
  StorageLister,
  TicketIndex,
} from '../src/storage/lister.js'
import { ensure, type TableHandle } from '../src/storage/table.js'
import { sqliteTables } from './sqlite-tables.js'

const EVENTS_DDL = `CREATE TABLE IF NOT EXISTS events (
  session_key TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, id TEXT NOT NULL,
  type TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'main', actor TEXT NOT NULL, origin TEXT NOT NULL,
  trust TEXT NOT NULL, register TEXT, ignorable INTEGER, surface_op TEXT, source_event_seqs TEXT,
  data TEXT NOT NULL, PRIMARY KEY (session_key, seq)
)`
const CLAIMS_DDL =
  'CREATE TABLE IF NOT EXISTS writer_claims (session_key TEXT PRIMARY KEY, run_id TEXT, until INTEGER, generation INTEGER)'

function setUp() {
  const tables = sqliteTables()
  const events = tables.table('events')
  ensure(events, EVENTS_DDL)
  const claims = tables.table('writer_claims')
  ensure(claims, CLAIMS_DDL)
  const ins = (key: string, seq: number, type: string, data: unknown) =>
    events.exec(
      'INSERT INTO events (session_key, seq, ts, id, type, lane, actor, origin, trust, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [key, seq, 1000 + seq, `id${seq}`, type, 'main', '{}', 'system', 'trusted', JSON.stringify(data)],
    )
  return { tables, events, claims, ins }
}

describe('StorageLister', () => {
  it('lists sessions from the events table with preset, generation and a keyset cursor', async () => {
    const { tables, claims, ins } = setUp()
    ins('agnes:t:a:cli:dm:1', 1, 'session/start', {
      key: 'agnes:t:a:cli:dm:1',
      preset: 'standard',
      resolvedProfileHash: null,
      agnesVersion: '0',
    })
    ins('agnes:t:a:cli:dm:1', 2, 'user/message', { content: [] })
    ins('agnes:t:a:cli:dm:2', 1, 'session/start', {
      key: 'agnes:t:a:cli:dm:2',
      preset: 'claw',
      resolvedProfileHash: null,
      agnesVersion: '0',
    })
    claims.exec('INSERT INTO writer_claims VALUES (?, ?, ?, ?)', ['agnes:t:a:cli:dm:1', 'r', 1, 5])

    const l = new StorageLister(tables.table('events'), tables.table('writer_claims'))
    const page1 = await l.list({ limit: 1 })
    expect(page1.items).toEqual([
      {
        sessionId: 'agnes:t:a:cli:dm:1',
        createdAt: new Date(1001).toISOString(),
        lastSeq: 2,
        generation: 5,
        preset: 'standard',
      },
    ])
    expect(page1.cursor).toBe('agnes:t:a:cli:dm:1')

    const page2 = await l.list({ limit: 1, cursor: page1.cursor as string })
    expect(page2.items[0]).toMatchObject({ sessionId: 'agnes:t:a:cli:dm:2', generation: 0, preset: 'claw' })
    // No writer_claims row for dm:2 - generation must default to 0, not throw or come back undefined.
    expect(page2.cursor).toBeUndefined()

    await tables.close()
  })

  it('filters by q as a session_key substring match', async () => {
    const { tables, ins } = setUp()
    ins('agnes:t:a:cli:dm:1', 1, 'session/start', { preset: null })
    ins('agnes:t:a:slack:ch:2', 1, 'session/start', { preset: null })
    const l = new StorageLister(tables.table('events'), tables.table('writer_claims'))
    const r = await l.list({ q: 'slack' })
    expect(r.items.map((i) => i.sessionId)).toEqual(['agnes:t:a:slack:ch:2'])
    await tables.close()
  })

  it('applies a server owner scope before keyset pagination', async () => {
    const { tables, ins } = setUp()
    for (const key of ['foreign-1', 'owner-1', 'owner-2'])
      ins(key, 1, 'session/start', { preset: 'standard' })
    const lister = new StorageLister(tables.table('events'), tables.table('writer_claims'))
    const first = await lister.list({ sessionIds: ['owner-1', 'owner-2'], limit: 1 })
    expect(first.items.map((item) => item.sessionId)).toEqual(['owner-1'])
    expect(first.cursor).toBe('owner-1')
    const second = await lister.list({
      sessionIds: ['owner-1', 'owner-2'],
      limit: 1,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    })
    expect(second.items.map((item) => item.sessionId)).toEqual(['owner-2'])
    expect(JSON.stringify([first, second])).not.toContain('foreign-1')
    await tables.close()
  })

  it('returns recorded cwd and applies cwd before pagination', async () => {
    const { tables, ins } = setUp()
    const workspaces = new SessionWorkspaceIndex(tables.table('session_workspaces'))
    for (const [key, cwd] of [
      ['session-1', '/repo/a'],
      ['session-2', '/repo/b'],
      ['session-3', '/repo/a'],
    ] as const) {
      ins(key, 1, 'session/start', { preset: 'standard' })
      workspaces.put(key, cwd)
    }
    const lister = new StorageLister(tables.table('events'), tables.table('writer_claims'), workspaces)

    const first = await lister.list({ cwd: '/repo/a', limit: 1 })
    expect(first.items).toMatchObject([{ sessionId: 'session-1', cwd: '/repo/a' }])
    expect(first.cursor).toBe('session-1')
    const second = await lister.list({
      cwd: '/repo/a',
      limit: 1,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    })
    expect(second.items).toMatchObject([{ sessionId: 'session-3', cwd: '/repo/a' }])
    expect(second.cursor).toBeUndefined()
    await tables.close()
  })

  it('answers preset: null when a session has no session/start row', async () => {
    const { tables, ins } = setUp()
    ins('agnes:t:a:cli:dm:1', 1, 'user/message', { content: [] })
    const l = new StorageLister(tables.table('events'), tables.table('writer_claims'))
    const r = await l.list({})
    expect(r.items).toEqual([
      {
        sessionId: 'agnes:t:a:cli:dm:1',
        createdAt: new Date(1001).toISOString(),
        lastSeq: 1,
        generation: 0,
        preset: null,
      },
    ])
    await tables.close()
  })
})

describe('TicketIndex', () => {
  it('put/get round-trips a ticket, session key and restart-safe workspace', async () => {
    const tables = sqliteTables()
    const idx = new TicketIndex(tables.table('approval_tickets'))
    idx.put('tk', 'agnes:t:a:cli:dm:1', 5000, '/workspace/one')
    expect(idx.get('tk')).toBe('agnes:t:a:cli:dm:1')
    expect(idx.cwd('tk')).toBe('/workspace/one')
    expect(idx.get('unknown')).toBeUndefined()
    expect(idx.cwd('unknown')).toBeUndefined()
    await tables.close()
  })

  it('migrates the original three-column table without losing tickets', async () => {
    const tables = sqliteTables()
    const table = tables.table('approval_tickets')
    table.exec(
      'CREATE TABLE approval_tickets (ticket TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)',
    )
    table.exec('INSERT INTO approval_tickets VALUES (?, ?, ?)', ['legacy', 'session-old', 9000])

    const idx = new TicketIndex(table)
    expect(idx.get('legacy')).toBe('session-old')
    expect(idx.cwd('legacy')).toBeUndefined()
    idx.put('new', 'session-new', 10_000, '/workspace/new')
    expect(idx.cwd('new')).toBe('/workspace/new')
    await tables.close()
  })

  it('migrates and persists through Host owner tables without using forbidden PRAGMA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-ticket-owner-'))
    const open = () =>
      createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
    let storage = open()
    try {
      const owner = storage.tables('@agnes/daemon').table('approval_tickets')
      owner.exec(
        'CREATE TABLE approval_tickets (ticket TEXT PRIMARY KEY, session_key TEXT NOT NULL, expires_at INTEGER NOT NULL)',
      )
      owner.run('INSERT INTO approval_tickets VALUES (?, ?, ?)', ['legacy', 'session-old', 9000])
      const adapt = (): TableHandle => ({
        exec(sql, params = []) {
          if (params.length) owner.run(sql, params)
          else owner.exec(sql)
        },
        get: <T>(sql: string, params = []) => owner.get<T>(sql, params),
        all: <T>(sql: string, params = []) => owner.all<T>(sql, params),
        transaction: <T>(fn: () => T) => owner.transaction(fn),
      })
      const idx = new TicketIndex(adapt())
      expect(idx.get('legacy')).toBe('session-old')
      idx.put('fresh', 'session-new', 10_000, '/workspace/new')
      expect(idx.cwd('fresh')).toBe('/workspace/new')
      await storage.close()

      storage = open()
      const reopened = storage.tables('@agnes/daemon').table('approval_tickets')
      const reopenedIndex = new TicketIndex({
        exec(sql, params = []) {
          if (params.length) reopened.run(sql, params)
          else reopened.exec(sql)
        },
        get: <T>(sql: string, params = []) => reopened.get<T>(sql, params),
        all: <T>(sql: string, params = []) => reopened.all<T>(sql, params),
        transaction: <T>(fn: () => T) => reopened.transaction(fn),
      })
      expect(reopenedIndex.get('legacy')).toBe('session-old')
      expect(reopenedIndex.cwd('fresh')).toBe('/workspace/new')
    } finally {
      await storage.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Reverse-verification of gc's core guarantee: it removes exactly the tickets whose deadline has
  // passed `now`, strictly - a ticket expiring at exactly `now` (the boundary case) still holds for
  // this instant and must survive. `future` proves the "not removed at all" half is not a fluke of
  // the boundary case; `boundary` is the one that actually distinguishes `<` from `<=`.
  it('gc(now) removes only tickets whose expires_at is strictly before now, and reports the count', async () => {
    const tables = sqliteTables()
    const idx = new TicketIndex(tables.table('approval_tickets'))
    idx.put('expired', 'session-a', 1000)
    idx.put('boundary', 'session-b', 2000)
    idx.put('future', 'session-c', 5000)

    const removed = idx.gc(2000)

    expect(removed).toBe(1)
    expect(idx.get('expired')).toBeUndefined()
    expect(idx.get('boundary')).toBe('session-b')
    expect(idx.get('future')).toBe('session-c')

    // A second gc at a later `now` catches the boundary ticket once it has actually passed, proving
    // the row was left in the table (not silently dropped) rather than merely unreported.
    expect(idx.gc(2001)).toBe(1)
    expect(idx.get('boundary')).toBeUndefined()
    expect(idx.get('future')).toBe('session-c')

    await tables.close()
  })
})

describe('SessionWorkspaceIndex', () => {
  it('persists cwd across reopen and refuses remapping the same session key', async () => {
    const tables = sqliteTables()
    const table = tables.table('session_workspaces')
    const first = new SessionWorkspaceIndex(table)
    first.put('session-one', '/workspace/one')

    const reopened = new SessionWorkspaceIndex(table)
    expect(reopened.get('session-one')).toBe('/workspace/one')
    expect(() => reopened.put('session-one', '/workspace/two')).toThrow(/already bound/)
    expect(reopened.get('session-one')).toBe('/workspace/one')
    await tables.close()
  })

  it('projects observed session metadata into the durable workspace index', async () => {
    const tables = sqliteTables()
    const index = new SessionWorkspaceIndex(tables.table('session_workspaces'))
    index.put('session-one', '/workspace/one')
    index.observe(
      'session-one',
      {
        seq: 1,
        ts: '2026-09-12T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type: 'session/start',
        data: { preset: 'standard', resolvedProfileHash: 'sha256-profile' },
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'system',
        trust: 'trusted',
      } as never,
      1,
    )
    index.observe(
      'session-one',
      {
        seq: 2,
        ts: '2026-09-12T00:00:01.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAC',
        type: 'x/core/preset-switch',
        data: { from: 'standard', to: 'claw' },
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'system',
        trust: 'trusted',
      } as never,
      1,
    )
    expect(index.keys()).toEqual(['session-one'])
    expect(index.metadata('session-one')).toEqual({
      createdAt: '2026-09-12T00:00:00.000Z',
      lastSeq: 2,
      generation: 1,
      preset: 'claw',
      profileHash: 'sha256-profile',
    })
    await tables.close()
  })

  it('refreshes only rows after the persisted sequence and folds worker status', async () => {
    const tables = sqliteTables()
    const index = new SessionWorkspaceIndex(tables.table('session_workspaces'))
    index.put('session-one', '/workspace/one')
    index.observe(
      'session-one',
      {
        seq: 1,
        ts: '2026-09-12T00:00:00.000Z',
        id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
        type: 'session/start',
        data: { preset: 'standard' },
        actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
        origin: 'system',
        trust: 'trusted',
      } as never,
      1,
    )
    const scans: Array<{ fromSeq: number; toSeq: number; limit?: number }> = []
    const source = {
      status: async () => ({ lastSeq: 2, preset: 'claw' }),
      scan: async (q: { fromSeq: number; toSeq: number; limit?: number }) => {
        scans.push(q)
        return [
          {
            seq: 2,
            ts: '2026-09-12T00:00:01.000Z',
            id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAC',
            type: 'x/core/preset-switch',
            data: { from: 'standard', to: 'claw' },
            actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
            origin: 'system',
            trust: 'trusted',
          },
        ]
      },
    }
    await index.refresh('session-one', source, 1)
    expect(scans).toEqual([{ fromSeq: 2, toSeq: 2, limit: 500 }])
    expect(index.metadata('session-one')).toMatchObject({ lastSeq: 2, preset: 'claw', generation: 1 })

    await index.refresh('session-one', source, 1)
    expect(scans).toHaveLength(1)
    await tables.close()
  })

  it('survives closing and reopening Host owner storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agnes-workspace-owner-'))
    const open = () =>
      createSqliteStorage({ file: join(root, 'sessions.db'), tablesDir: join(root, 'tables') })
    let storage = open()
    try {
      const asTable = (owner: HostTableHandle): TableHandle => ({
        exec(sql, params = []) {
          if (params.length) owner.run(sql, params)
          else owner.exec(sql)
        },
        get: <T>(sql: string, params = []) => owner.get<T>(sql, params),
        all: <T>(sql: string, params = []) => owner.all<T>(sql, params),
        transaction: <T>(fn: () => T) => owner.transaction(fn),
      })
      const first = new SessionWorkspaceIndex(
        asTable(storage.tables('@agnes/daemon').table('session_workspaces')),
      )
      first.put('session-durable', '/workspace/durable')
      await storage.close()

      storage = open()
      const reopened = new SessionWorkspaceIndex(
        asTable(storage.tables('@agnes/daemon').table('session_workspaces')),
      )
      expect(reopened.get('session-durable')).toBe('/workspace/durable')
    } finally {
      await storage.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  const ledgerEvent = (seq: number, type: string, ts: string) =>
    ({
      seq,
      ts,
      id: `01J6ZM2Q3R4S5T6V7W8X9Y0Z${String(seq).padStart(2, '0')}`,
      type,
      data: type === 'session/start' ? { preset: 'standard' } : {},
      actor: { id: 'local', org: 'local', role: 'owner', deptPath: [], attrs: {} },
      origin: 'system',
      trust: 'trusted',
    }) as never

  it('records the latest user message time and ignores open, title and replayed events', async () => {
    const tables = sqliteTables()
    const sql = new SessionWorkspaceIndex(tables.table('session_workspaces'))
    const memory = new MemorySessionWorkspaces()
    for (const index of [sql, memory]) {
      index.put('session-one', '/workspace/one')
      index.observe('session-one', ledgerEvent(1, 'session/start', '2026-09-12T00:00:00.000Z'), 1)
      expect(index.metadata('session-one')?.lastActiveAt).toBeUndefined()
      index.observe('session-one', ledgerEvent(2, 'user/message', '2026-09-12T00:01:00.000Z'), 1)
      // Opening a session appends a kernel event and the first turn appends a title; neither is chatting.
      index.observe('session-one', ledgerEvent(3, 'x/agnes/code-mode/kernel', '2026-09-12T00:02:00.000Z'), 1)
      index.observe('session-one', ledgerEvent(4, 'x/host/session-title', '2026-09-12T00:03:00.000Z'), 1)
      expect(index.metadata('session-one')?.lastActiveAt).toBe('2026-09-12T00:01:00.000Z')
      index.observe('session-one', ledgerEvent(2, 'user/message', '2026-09-12T09:00:00.000Z'), 1)
      expect(index.metadata('session-one')?.lastActiveAt).toBe('2026-09-12T00:01:00.000Z')
    }
    await tables.close()
  })

  it('adds last_active_at to a table created before it existed without losing rows', async () => {
    const tables = sqliteTables()
    const table = tables.table('session_workspaces')
    table.exec(
      `CREATE TABLE session_workspaces (session_key TEXT PRIMARY KEY, cwd TEXT NOT NULL, created_at TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0, preset TEXT,
        profile_hash TEXT, title TEXT)`,
    )
    table.exec(
      "INSERT INTO session_workspaces (session_key, cwd, created_at, last_seq, title) VALUES ('old', '/w', '2026-09-01T00:00:00.000Z', 7, 'kept')",
    )
    const index = new SessionWorkspaceIndex(table)
    expect(index.metadata('old')).toMatchObject({ createdAt: '2026-09-01T00:00:00.000Z', title: 'kept' })
    expect(index.metadata('old')?.lastActiveAt).toBeUndefined()
    index.observe('old', ledgerEvent(8, 'user/message', '2026-09-21T00:00:00.000Z'), 1)
    expect(new SessionWorkspaceIndex(table).metadata('old')?.lastActiveAt).toBe('2026-09-21T00:00:00.000Z')
    await tables.close()
  })
})
