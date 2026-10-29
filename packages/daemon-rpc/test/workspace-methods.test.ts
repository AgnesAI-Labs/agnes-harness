import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalEndpoint } from '@agnes/daemon-foundation/local/endpoint'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { SessionPreferencesStore } from '@agnes/daemon-foundation/storage/session-preferences'
import {
  MemoryWorkspaceStore,
  WorkspaceCatalog,
  WorkspaceIndex,
} from '@agnes/daemon-foundation/storage/workspaces'
import { resolveWorkspaceDirectory, WorkspaceDirectoryError } from '@agnes/host'
import { describe, expect, it } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import { registerWorkspaces } from '../src/local/methods/workspaces.js'

const request = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  params,
})

function endpoint(
  catalog: WorkspaceCatalog,
  sessions?: Parameters<typeof registerWorkspaces>[2],
): LocalEndpoint {
  const endpoint = new LocalEndpoint({ clock: () => 0, principalId: 'tester' })
  endpoint.conn.initialized = true
  endpoint.conn.authKind = 'local'
  endpoint.conn.credentialKind = 'local'
  registerWorkspaces(endpoint, catalog, sessions)
  return endpoint
}

describe('workspace RPC methods', () => {
  it('adds and lists through the catalog', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async () => ({ path: '/repo/project', name: 'project' }),
      () => 0,
    )
    const ep = endpoint(catalog)

    await expect(
      ep.handle(request(1, '_agnes/v1/workspace.add', { path: '/repo/project' })),
    ).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        workspace: {
          path: '/repo/project',
          name: 'project',
          lastUsedAt: null,
          sessionCount: 0,
          available: true,
          workspaceId: createHash('sha256').update('/repo/project', 'utf8').digest('hex'),
          revision: 1,
        },
      },
    })
    await expect(ep.handle(request(2, '_agnes/v1/workspace.list'))).resolves.toMatchObject({
      result: { items: [{ path: '/repo/project', available: true }] },
    })
  })

  it('refuses to remove the managed chats workspace', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async (path) => ({ path, name: 'chats' }),
      () => 0,
      undefined,
      '/data/chats',
    )
    const ep = endpoint(catalog, { running: () => false, archive: () => {} })
    const chats = await catalog.add('/data/chats')

    await expect(
      ep.handle(request(1, '_agnes/v1/workspace.remove', { workspaceId: chats.workspaceId })),
    ).resolves.toMatchObject({ error: { code: -32011, data: { code: 'WORKSPACE_MANAGED' } } })
    expect((await catalog.list()).items).toMatchObject([{ path: '/data/chats', kind: 'chats' }])
  })

  it('maps Host validation to a stable workspace error', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      async () => {
        throw new WorkspaceDirectoryError('not-found')
      },
    )
    const ep = endpoint(catalog)

    await expect(
      ep.handle(request(1, '_agnes/v1/workspace.add', { path: '/missing' })),
    ).resolves.toMatchObject({
      error: { code: -32011, data: { code: 'WORKSPACE_INVALID', reason: 'not-found' } },
    })
  })
})

it.each(['memory', 'sqlite'])(
  'removes only the %s listing, archives sessions and permits re-add/recovery',
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'agnes-workspace-remove-'))
    const tables = sqliteTables()
    const sessions = new MemorySessionWorkspaces()
    const preferences = new SessionPreferencesStore(
      kind === 'sqlite' ? tables.table('session_preferences') : undefined,
    )
    const store =
      kind === 'sqlite' ? new WorkspaceIndex(tables.table('workspace_registry')) : new MemoryWorkspaceStore()
    const catalog = new WorkspaceCatalog(store, sessions, resolveWorkspaceDirectory)
    const running = new Set<string>()
    const ep = endpoint(catalog, {
      running: (id) => running.has(id),
      archive: (id) => {
        preferences.archive(id, true)
      },
    })
    const call = (params: unknown) => ep.handle(request(1, '_agnes/v1/workspace.remove', params))
    try {
      await writeFile(join(directory, 'keep.txt'), 'user files')
      const workspace = await catalog.add(directory)
      await catalog.authorizeAndBind('one', directory)
      await catalog.authorizeAndBind('two', directory)
      sessions.put('other', '/another-workspace')
      const params = { workspaceId: workspace.workspaceId, expectedRevision: workspace.revision }
      expect(await call({ ...params, expectedRevision: 999 })).toHaveProperty(
        'error.data.code',
        'WORKSPACE_STALE',
      )
      expect((await catalog.list()).items).toHaveLength(1)
      expect(preferences.get('one').archived).toBe(false)
      running.add('two')
      expect(await call(params)).toMatchObject({
        error: {
          data: {
            code: 'WORKSPACE_RUNNING',
            runningSessionCount: 1,
            reason: expect.stringContaining('Stop'),
          },
        },
      })
      expect((await catalog.list()).items).toHaveLength(1)
      expect(preferences.get('one').archived).toBe(false)
      running.clear()
      ep.conn.authKind = 'jwt'
      expect(await call(params)).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
      ep.conn.authKind = 'local'
      ep.conn.credentialKind = 'jwt'
      expect(await call(params)).toHaveProperty('error.data.code', 'CAPABILITY_DENIED')
      ep.conn.credentialKind = 'local'
      if (kind === 'sqlite') {
        const failing = endpoint(catalog, {
          running: () => false,
          archive: (id) => {
            preferences.archive(id, true)
            if (id === 'two') throw new Error('synthetic archive write failure')
          },
        })
        expect(await failing.handle(request(2, '_agnes/v1/workspace.remove', params))).toHaveProperty('error')
        expect((await catalog.list()).items).toHaveLength(1)
        expect(preferences.get('one').archived).toBe(false)
        expect(preferences.get('two').archived).toBe(false)
        await failing.close()
      }
      expect(await call(params)).toMatchObject({ result: { removed: true, archivedSessionCount: 2 } })
      expect(await catalog.list()).toEqual({ items: [] })
      expect(preferences.get('one').archived).toBe(true)
      expect(preferences.get('two').archived).toBe(true)
      expect(preferences.get('other').archived).toBe(false)
      expect((await stat(directory)).isDirectory()).toBe(true)
      expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('user files')
      expect(await call(params)).toMatchObject({ result: { removed: false, archivedSessionCount: 0 } })
      await expect(catalog.authorizeAndBind('new', directory)).rejects.toMatchObject({
        data: { code: 'WORKSPACE_NOT_FOUND' },
      })
      await expect(catalog.restoreBinding('one')).resolves.toMatchObject({ canonicalRoot: workspace.path })
      const restored = await catalog.add(directory)
      expect(restored.workspaceId).toBe(workspace.workspaceId)
      expect((await catalog.list()).items).toHaveLength(1)
      expect(preferences.get('one').archived).toBe(true)
      preferences.archive('one', false)
      expect(preferences.get('one').archived).toBe(false)
      await expect(catalog.restoreBinding('one')).resolves.toMatchObject({ canonicalRoot: workspace.path })
    } finally {
      await ep.close()
      await tables.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
