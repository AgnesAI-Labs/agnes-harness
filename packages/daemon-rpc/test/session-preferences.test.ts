import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import type { SessionLister } from '@agnes/daemon-foundation/local/ports'
import {
  SessionPreferencesStore,
  withSessionPreferences,
} from '@agnes/daemon-foundation/storage/session-preferences'
import { createSqliteStorage } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { recordingTable, sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import {
  copyForkBookmarks,
  type ForkPromptScan,
  registerSessionPreferences,
} from '../src/local/methods/session-preferences.js'

const row = {
  sessionId: 's',
  createdAt: '',
  generation: 1,
  lastSeq: 3,
  preset: 'code',
  title: '自动标题',
  cwd: '/workspace',
}
const lister: SessionLister = { list: async () => ({ items: [row] }) }

describe('session preferences', () => {
  it('accepts preference SQL through the production owner-confined table adapter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-preferences-owner-'))
    const storage = createSqliteStorage({ file: join(dir, 'ledger.db') })
    try {
      const table = storage.tables('@agnes/daemon').table('session_preferences')
      const store = new SessionPreferencesStore({
        ...table,
        exec: (sql, params) => {
          if (params) table.run(sql, params)
          else table.exec(sql)
        },
      })
      store.rename('s', '持久名称')
      expect(store.archive('s', true)).toEqual({ title: '持久名称', archived: true })
      expect(store.setBookmarks('s', ['01JTURN']).bookmarks).toEqual(['01JTURN'])
      expect(store.setBookmarks('s', [])).toEqual({ title: '持久名称', archived: true })
      store.archive('s', false)
      expect(store.pin('s', true).pinnedAt).toMatch(/^\d{4}-\d\d-\d\dT/)
      expect(storage.coreTableNames()).not.toContain('session_preferences')
    } finally {
      await storage.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('opens session_preferences with pinned_at in its CREATE and no ALTER', async () => {
    const tables = sqliteTables()
    const { table, sql } = recordingTable(tables.table('session_preferences'))
    new SessionPreferencesStore(table)
    expect(sql.filter((s) => /ALTER TABLE/.test(s))).toEqual([])
    expect(
      tables
        .table('x')
        .all<{ name: string }>("SELECT name FROM pragma_table_info('session_preferences')")
        .map((c) => c.name),
    ).toEqual(['session_key', 'title', 'archived', 'pinned_at', 'bookmarks'])
    await tables.close()
  })

  it('persists through a real SQLite restart; independent field writes never erase each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-session-preferences-'))
    let tables = sqliteTables(join(dir, 'preferences.db'))
    try {
      const store = new SessionPreferencesStore(tables.table('session_preferences'), () => 1_000)
      store.rename('old', '旧名称')
      expect(store.pin('old', true)).toEqual({
        title: '旧名称',
        archived: false,
        pinnedAt: '1970-01-01T00:00:01.000Z',
      })
      store.archive('s', true)
      store.rename('s', '  我的名称 😀  ')
      store.archive('s', true)
      expect(store.get('s')).toEqual({ title: '我的名称 😀', archived: true })
      await tables.close()
      tables = sqliteTables(join(dir, 'preferences.db'))
      const reopened = new SessionPreferencesStore(tables.table('session_preferences'))
      expect(reopened.get('s')).toEqual({ title: '我的名称 😀', archived: true })
      expect(reopened.get('old').pinnedAt).toBe('1970-01-01T00:00:01.000Z')
      reopened.archive('s', false)
      expect(reopened.apply({ ...row, title: '迟到的自动名称' })).toMatchObject({
        title: '我的名称 😀',
        titleSource: 'user',
        archived: false,
        cwd: '/workspace',
        lastSeq: 3,
      })
      expect(reopened.get('untouched')).toEqual({ archived: false })
    } finally {
      await tables.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes visible titles and rejects empty/control/overlong input without changing saved data', () => {
    const store = new SessionPreferencesStore()
    store.rename('s', '原名')
    for (const bad of ['', '   ', 'a\nb', '\u202ebad', '字'.repeat(81)]) {
      expect(() => store.rename('s', bad)).toThrow()
      expect(store.get('s').title).toBe('原名')
    }
    expect(store.rename('s', '😀'.repeat(80)).title).toBe('😀'.repeat(80))
  })

  it('keeps pagination and archive membership while overlaying generated titles', async () => {
    const store = new SessionPreferencesStore()
    store.rename('s', '用户名称')
    store.archive('s', true)
    const decorated = withSessionPreferences({ list: async () => ({ items: [row], cursor: 'next' }) }, store)
    expect(await decorated.list({ limit: 1 })).toEqual({
      items: [{ ...row, title: '用户名称', titleSource: 'user', archived: true }],
      cursor: 'next',
    })
  })

  it('validates real wire calls, requires local auth, rejects missing ids, and handles repeated restoration', async () => {
    const store = new SessionPreferencesStore()
    const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    registerSessionPreferences(endpoint, lister, store)
    const call = (method: string, params: unknown) =>
      endpoint.handle({ jsonrpc: '2.0', id: 1, method, params })
    expect(await call('_agnes/v1/session.rename', { sessionId: 's', title: 'name' })).toHaveProperty('error')
    endpoint.conn.initialized = true
    endpoint.conn.authKind = 'jwt'
    expect(await call('_agnes/v1/session.rename', { sessionId: 's', title: 'name' })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'jwt'
    expect(await call('_agnes/v1/session.archive', { sessionId: 's', archived: true })).toHaveProperty(
      'error.data.code',
      'CAPABILITY_DENIED',
    )
    endpoint.conn.credentialKind = 'local'
    expect(await call('_agnes/v1/session.rename', { sessionId: 'missing', title: 'name' })).toHaveProperty(
      'error.data.code',
      'SESSION_NOT_FOUND',
    )
    expect(await call('_agnes/v1/session.archive', { sessionId: 's', archived: 'yes' })).toHaveProperty(
      'error',
    )
    expect(await call('_agnes/v1/session.rename', { sessionId: 's', title: 'name' })).toHaveProperty(
      'result.title',
      'name',
    )
    expect(await call('_agnes/v1/session.archive', { sessionId: 's', archived: true })).toHaveProperty(
      'result.archived',
      true,
    )
    for (let i = 0; i < 2; i++)
      expect(await call('_agnes/v1/session.archive', { sessionId: 's', archived: false })).toHaveProperty(
        'result',
        { title: 'name', archived: false },
      )
    await endpoint.close()
  })

  it('pins on the wire for the local owner only, keeps the first pin time, and never pins an archived session', async () => {
    let now = Date.parse('2026-10-20T08:00:00.000Z')
    const store = new SessionPreferencesStore(undefined, () => now++)
    const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    registerSessionPreferences(endpoint, lister, store)
    const pin = (params: unknown) =>
      endpoint.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/session.pin', params })
    endpoint.conn.initialized = true
    for (const [authKind, credentialKind] of [
      ['jwt', 'local'],
      ['local', 'jwt'],
    ] as const) {
      endpoint.conn.authKind = authKind
      endpoint.conn.credentialKind = credentialKind
      expect(await pin({ sessionId: 's', pinned: true })).toHaveProperty(
        'error.data.code',
        'CAPABILITY_DENIED',
      )
    }
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    expect(store.get('s')).not.toHaveProperty('pinnedAt')
    expect(await pin({ sessionId: 'missing', pinned: true })).toHaveProperty(
      'error.data.code',
      'SESSION_NOT_FOUND',
    )
    expect(await pin({ sessionId: 's', pinned: 'yes' })).toHaveProperty('error')
    for (let i = 0; i < 2; i++)
      expect(await pin({ sessionId: 's', pinned: true })).toHaveProperty('result', {
        archived: false,
        pinnedAt: '2026-10-20T08:00:00.000Z',
      })
    expect(await pin({ sessionId: 's', pinned: false })).toHaveProperty('result', { archived: false })
    await pin({ sessionId: 's', pinned: true })
    expect(store.archive('s', true)).toEqual({ archived: true })
    expect(await pin({ sessionId: 's', pinned: true })).toHaveProperty('error.data.code', 'SESSION_ARCHIVED')
    expect(store.get('s')).toEqual({ archived: true })
    await endpoint.close()
  })
})

describe('session bookmarks', () => {
  it('keeps bookmarks in a session_preferences column with no side table', async () => {
    const tables = sqliteTables()
    const t = tables.table('session_preferences')
    const store = new SessionPreferencesStore(t)
    store.setBookmarks('s', ['01JTURNA'])
    expect(t.get("SELECT name FROM sqlite_master WHERE name = 'session_bookmarks'")).toBeUndefined()
    expect(t.get('SELECT bookmarks FROM session_preferences WHERE session_key = ?', ['s'])).toEqual({
      bookmarks: '["01JTURNA"]',
    })
    expect(store.setBookmarks('s', []).bookmarks).toBeUndefined()
    expect(t.get('SELECT bookmarks FROM session_preferences WHERE session_key = ?', ['s'])).toEqual({
      bookmarks: null,
    })
    await tables.close()
  })

  it('replaces the whole list, keeps the first place of a repeat, and clears with an empty list', () => {
    const store = new SessionPreferencesStore()
    store.rename('s', '名称')
    expect(store.setBookmarks('s', ['b', 'a', 'b'])).toEqual({
      title: '名称',
      archived: false,
      bookmarks: ['b', 'a'],
    })
    expect(store.setBookmarks('s', ['c']).bookmarks).toEqual(['c'])
    expect(store.setBookmarks('s', ['c'])).toEqual(store.get('s'))
    expect(store.setBookmarks('s', [])).toEqual({ title: '名称', archived: false })
    expect(store.archive('s', true)).not.toHaveProperty('bookmarks')
  })

  it('refuses an invalid list without changing the saved one', () => {
    const store = new SessionPreferencesStore()
    store.setBookmarks('s', ['keep'])
    const many = Array.from({ length: 201 }, (_, i) => `t${i}`)
    for (const bad of [many, [''], ['x'.repeat(129)], ['a\nb'], ['\u0085']]) {
      expect(() => store.setBookmarks('s', bad)).toThrow()
      expect(store.get('s').bookmarks).toEqual(['keep'])
    }
    // 200 distinct ids, or more entries that collapse to 200, are accepted.
    expect(store.setBookmarks('s', many.slice(0, 200)).bookmarks).toHaveLength(200)
    expect(store.setBookmarks('s', [...many.slice(0, 200), 't0']).bookmarks).toHaveLength(200)
  })

  it('persists across a real SQLite restart, independently of title and archive, and shows in the list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-session-bookmarks-'))
    let tables = sqliteTables(join(dir, 'preferences.db'))
    try {
      const store = new SessionPreferencesStore(tables.table('session_preferences'))
      store.setBookmarks('s', ['01JTURNA', '01JTURNB'])
      store.rename('s', '名称')
      store.archive('s', true)
      await tables.close()
      tables = sqliteTables(join(dir, 'preferences.db'))
      const reopened = new SessionPreferencesStore(tables.table('session_preferences'))
      expect(reopened.get('s')).toEqual({
        title: '名称',
        archived: true,
        bookmarks: ['01JTURNA', '01JTURNB'],
      })
      expect(reopened.setBookmarks('s', []).bookmarks).toBeUndefined()
      expect(reopened.get('s')).toEqual({ title: '名称', archived: true })
      reopened.setBookmarks('s', ['01JTURNB'])
      const decorated = withSessionPreferences(lister, reopened)
      expect((await decorated.list({})).items).toEqual([
        { ...row, title: '名称', titleSource: 'user', archived: true, bookmarks: ['01JTURNB'] },
      ])
      expect(
        (await withSessionPreferences(lister, new SessionPreferencesStore()).list({})).items[0],
      ).not.toHaveProperty('bookmarks')
    } finally {
      await tables.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('applies the same principal checks as rename on the wire and validates the list', async () => {
    const store = new SessionPreferencesStore()
    const endpoint = new LocalEndpoint({ clock: Date.now, principalId: 'local' })
    registerSessionPreferences(endpoint, lister, store)
    const set = (params: unknown) =>
      endpoint.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/session.bookmarks.set', params })
    endpoint.conn.initialized = true
    for (const [authKind, credentialKind] of [
      ['jwt', 'local'],
      ['local', 'jwt'],
    ] as const) {
      endpoint.conn.authKind = authKind
      endpoint.conn.credentialKind = credentialKind
      expect(await set({ sessionId: 's', bookmarks: ['a'] })).toHaveProperty(
        'error.data.code',
        'CAPABILITY_DENIED',
      )
    }
    endpoint.conn.authKind = 'local'
    endpoint.conn.credentialKind = 'local'
    expect(store.get('s')).not.toHaveProperty('bookmarks')
    expect(await set({ sessionId: 'missing', bookmarks: ['a'] })).toHaveProperty(
      'error.data.code',
      'SESSION_NOT_FOUND',
    )
    expect(await set({ sessionId: 's' })).toHaveProperty('error')
    expect(await set({ sessionId: 's', bookmarks: ['x'.repeat(129)] })).toHaveProperty('error')
    expect(await set({ sessionId: 's', bookmarks: ['a', 'b', 'a'] })).toHaveProperty('result', {
      archived: false,
      bookmarks: ['a', 'b'],
    })
    expect(await set({ sessionId: 's', bookmarks: [] })).toHaveProperty('result', { archived: false })
    await endpoint.close()
  })

  it('a fork keeps only the bookmarks whose prompt lies inside the copied history, in their order', async () => {
    const store = new SessionPreferencesStore()
    // 1200 prompts, so the copy pages through more than one 500-row scan.
    const events = Array.from({ length: 1200 }, (_, i) => ({ id: `u${i + 1}`, seq: i + 1 }))
    const queries: unknown[] = []
    const scan: ForkPromptScan = async (query) => {
      queries.push(query)
      return events.filter((e) => e.seq >= query.fromSeq && e.seq <= query.toSeq).slice(0, query.limit)
    }
    store.setBookmarks('p', ['u900', 'u2', 'u1100'])
    await copyForkBookmarks(store, scan, 'p', 1000, 'c')
    expect(store.get('c').bookmarks).toEqual(['u900', 'u2'])
    expect(store.get('p').bookmarks).toEqual(['u900', 'u2', 'u1100'])
    expect(queries).toEqual([
      { type: 'user/message', order: 'asc', fromSeq: 1, toSeq: 1000, limit: 500 },
      { type: 'user/message', order: 'asc', fromSeq: 501, toSeq: 1000, limit: 500 },
    ])
    // Nothing bookmarked inside the boundary, nothing bookmarked at all, or a failed read: no copy.
    await copyForkBookmarks(store, scan, 'p', 1, 'c2')
    queries.length = 0
    await copyForkBookmarks(store, scan, 'none', 1000, 'c3')
    expect(queries).toEqual([])
    await copyForkBookmarks(store, async () => Promise.reject(new Error('gone')), 'p', 1000, 'c4')
    for (const child of ['c2', 'c3', 'c4']) expect(store.get(child)).toEqual({ archived: false })
  })
})
