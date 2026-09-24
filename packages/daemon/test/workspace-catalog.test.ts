import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import {
  assertWorkspaceBindingEnvelope,
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  WorkspaceCatalog,
  type WorkspaceDirectoryResolver,
  WorkspaceIndex,
  type WorkspaceStore,
} from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

const workspaceId = (path: string) => createHash('sha256').update(path, 'utf8').digest('hex')
const resolver =
  (available: Set<string>): WorkspaceDirectoryResolver =>
  async (path) => {
    if (!available.has(path)) throw new Error('unavailable')
    return { path, name: path.split('/').at(-1) || path }
  }

describe('WorkspaceCatalog', () => {
  it('deduplicates registration and sorts by the latest successful session binding', async () => {
    const sessions = new MemorySessionWorkspaces()
    const store = new MemoryWorkspaceStore()
    const available = new Set(['/repo/a', '/repo/b'])
    let now = Date.parse('2026-09-13T00:00:00.000Z')
    const catalog = new WorkspaceCatalog(store, sessions, resolver(available), () => now)

    await catalog.add('/repo/a')
    now += 1_000
    await catalog.add('/repo/b')
    await catalog.authorizeAndBind('b-session', '/repo/b')
    now += 1_000
    await catalog.add('/repo/a')
    await catalog.authorizeAndBind('a-session', '/repo/a')

    await expect(catalog.list()).resolves.toMatchObject({
      items: [
        { path: '/repo/a', lastUsedAt: '2026-09-13T00:00:02.000Z' },
        { path: '/repo/b', lastUsedAt: '2026-09-13T00:00:01.000Z' },
      ],
    })
  })

  it('does not promote durable history into the authority registry', async () => {
    const sessions = new MemorySessionWorkspaces()
    sessions.put('s1', '/repo/a')
    sessions.put('s2', '/repo/a')
    sessions.put('s3', '/repo/moved')
    const available = new Set(['/repo/a'])
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), sessions, resolver(available), () =>
      Date.parse('2026-09-13T00:00:00.000Z'),
    )

    await expect(catalog.list()).resolves.toEqual({ items: [] })
    await expect(catalog.restoreBinding('s1')).rejects.toMatchObject({
      data: { code: 'WORKSPACE_NOT_FOUND' },
    })
  })

  it('returns the server canonical path and aggregates sessions on that identity', async () => {
    const sessions = new MemorySessionWorkspaces()
    sessions.put('s1', '/real/repo')
    const resolve: WorkspaceDirectoryResolver = async () => ({ path: '/real/repo', name: 'repo' })
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), sessions, resolve, () => 0)

    await expect(catalog.add('/alias/repo')).resolves.toEqual({
      path: '/real/repo',
      name: 'repo',
      lastUsedAt: null,
      sessionCount: 1,
      available: true,
      workspaceId: workspaceId('/real/repo'),
      revision: 1,
    })
    expect(catalog.sessionPath('s1')).toBeUndefined()
    expect(catalog.sessionPath('missing')).toBeUndefined()
  })

  it('notifies bound listeners after successful binds and restores only', async () => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      resolver(new Set(['/repo/a'])),
      () => 0,
    )
    const seen: Array<[string, string]> = []
    catalog.onBound(() => {
      throw new Error('a failing listener must not break binding')
    })
    const stop = catalog.onBound((id, root) => seen.push([id, root]))
    await expect(catalog.authorizeAndBind('s1', '/repo/a')).rejects.toBeDefined()
    await catalog.add('/repo/a')
    await catalog.authorizeAndBind('s1', '/repo/a')
    await catalog.restoreBinding('s1')
    await expect(catalog.restoreBinding('missing')).rejects.toBeDefined()
    expect(seen).toEqual([
      [workspaceId('/repo/a'), '/repo/a'],
      [workspaceId('/repo/a'), '/repo/a'],
    ])
    stop()
    await catalog.restoreBinding('s1')
    expect(seen).toHaveLength(2)
  })

  it('does not advance recent use for an idempotent binding retry', async () => {
    const sessions = new MemorySessionWorkspaces()
    const store = new MemoryWorkspaceStore()
    let now = 0
    const catalog = new WorkspaceCatalog(store, sessions, resolver(new Set(['/repo/a'])), () => now)
    await catalog.add('/repo/a')
    await catalog.authorizeAndBind('same-request', '/repo/a')
    now = 5_000
    await catalog.authorizeAndBind('same-request', '/repo/a')

    await expect(catalog.list()).resolves.toMatchObject({
      items: [{ path: '/repo/a', lastUsedAt: '1970-01-01T00:00:00.000Z', sessionCount: 1 }],
    })
  })

  it('persists registration and successful use across store reopen', async () => {
    const tables = sqliteTables()
    const sessions = new MemorySessionWorkspaces()
    const available = new Set(['/repo/a'])
    const first = new WorkspaceCatalog(
      new WorkspaceIndex(tables.table('workspace_registry')),
      sessions,
      resolver(available),
      () => 1_000,
    )
    await first.add('/repo/a')
    await first.authorizeAndBind('session-a', '/repo/a')

    const reopened = new WorkspaceCatalog(
      new WorkspaceIndex(tables.table('workspace_registry')),
      sessions,
      resolver(available),
      () => 9_000,
    )
    await expect(reopened.list()).resolves.toMatchObject({
      items: [
        {
          path: '/repo/a',
          lastUsedAt: '1970-01-01T00:00:01.000Z',
          sessionCount: 1,
          available: true,
        },
      ],
    })
    await tables.close()
  })

  it('binds resource-control workspace ids from the catalog and rejects unknown or unavailable ids', async () => {
    const sessions = new MemorySessionWorkspaces()
    const available = new Set(['/repo/a'])
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), sessions, resolver(available), () =>
      Date.parse('2026-09-13T00:00:00.000Z'),
    )
    await catalog.add('/repo/a')
    const fallback = '/repo/a'
    await expect(catalog.bind(undefined, fallback)).resolves.toEqual({
      workspaceId: workspaceId('/repo/a'),
      path: '/repo/a',
    })
    await expect(catalog.bind(workspaceId('/repo/a'), fallback)).resolves.toEqual({
      workspaceId: workspaceId('/repo/a'),
      path: '/repo/a',
    })
    await expect(catalog.bind(workspaceId('/repo/missing'), fallback)).rejects.toMatchObject({
      data: { code: 'WORKSPACE_NOT_FOUND' },
    })
  })

  it('keeps legacy history out of an empty authority registry', async () => {
    const sessions = new MemorySessionWorkspaces()
    sessions.put('z-first-key', '/repo/a')
    sessions.put('a-second-key', '/repo/a')
    const event = (ts: string) =>
      ({
        seq: 1,
        ts,
        type: 'session/start',
        data: { preset: 'standard' },
      }) as never
    sessions.observe('z-first-key', event('2026-09-13T00:00:01.000Z'))
    sessions.observe('a-second-key', event('2026-09-13T00:00:02.000Z'))
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), sessions, resolver(new Set(['/repo/a'])))

    await expect(catalog.list()).resolves.toEqual({ items: [] })
  })

  it('authorizes only an explicitly registered canonical root and restores its private binding', async () => {
    const available = new Set(['/repo', '/repo/child'])
    const bindings = new MemoryWorkspaceBindings()
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      resolver(available),
      () => 0,
      bindings,
    )

    await catalog.add('/repo')
    await expect(catalog.authorizeAndBind('child', '/repo/child')).rejects.toMatchObject({
      data: { code: 'WORKSPACE_NOT_FOUND' },
    })
    const binding = await catalog.authorizeAndBind('root', '/repo')
    expect(() => assertWorkspaceBindingEnvelope(binding)).not.toThrow()
    await expect(catalog.restoreBinding('root')).resolves.toMatchObject({
      sessionKey: 'root',
      canonicalRoot: '/repo',
      revision: 1,
    })
    expect(() => assertWorkspaceBindingEnvelope({ ...binding })).toThrow('not issued')
  })

  it('rejects symlink drift while restoring an existing binding', async () => {
    let target = '/real/a'
    const resolve: WorkspaceDirectoryResolver = async () => ({
      path: target,
      name: target.split('/').at(-1) ?? target,
    })
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), new MemorySessionWorkspaces(), resolve)
    await catalog.add('/alias')
    await catalog.authorizeAndBind('session', '/alias')
    target = '/real/b'

    await expect(catalog.restoreBinding('session')).rejects.toMatchObject({
      data: { code: 'WORKSPACE_STALE' },
    })
  })

  it('rejects a binding after its registry revision changes', async () => {
    const base = new MemoryWorkspaceStore()
    let stale = false
    const store: WorkspaceStore = {
      put: (directory, registeredAt) => base.put(directory, registeredAt),
      touch: (path, usedAt) => base.touch(path, usedAt),
      rows: () => base.rows().map((row) => (stale ? { ...row, revision: row.revision + 1 } : row)),
    }
    const catalog = new WorkspaceCatalog(store, new MemorySessionWorkspaces(), resolver(new Set(['/repo'])))
    await catalog.add('/repo')
    await catalog.authorizeAndBind('session', '/repo')
    stale = true

    await expect(catalog.restoreBinding('session')).rejects.toMatchObject({
      data: { code: 'WORKSPACE_STALE' },
    })
  })
})
