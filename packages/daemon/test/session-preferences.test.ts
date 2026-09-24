import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSqliteStorage } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { registerSessionPreferences } from '../src/local/methods/session-preferences.js'
import type { SessionLister } from '../src/local/ports.js'
import { SessionPreferencesStore, withSessionPreferences } from '../src/storage/session-preferences.js'
import { sqliteTables } from './sqlite-tables.js'

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
      expect(storage.coreTableNames()).not.toContain('session_preferences')
    } finally {
      await storage.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists through a real SQLite restart; independent field writes never erase each other', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agnes-session-preferences-'))
    let tables = sqliteTables(join(dir, 'preferences.db'))
    try {
      const store = new SessionPreferencesStore(tables.table('session_preferences'))
      store.archive('s', true)
      store.rename('s', '  我的名称 😀  ')
      store.archive('s', true)
      expect(store.get('s')).toEqual({ title: '我的名称 😀', archived: true })
      await tables.close()
      tables = sqliteTables(join(dir, 'preferences.db'))
      const reopened = new SessionPreferencesStore(tables.table('session_preferences'))
      expect(reopened.get('s')).toEqual({ title: '我的名称 😀', archived: true })
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
})
