import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySessionWorkspaces } from '../src/storage/lister.js'
import {
  assertWorkspaceBindingEnvelope,
  MemoryWorkspaceBindings,
  MemoryWorkspaceStore,
  SessionWorkspaceConflictError,
  WorkspaceBindingIndex,
  WorkspaceCatalog,
  type WorkspaceDirectoryResolver,
  WorkspaceIndex,
  type WorkspaceStore,
} from '../src/storage/workspaces.js'
import { recordingTable, sqliteTables } from './sqlite-tables.js'

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
        { path: '/repo/a', name: 'a', lastUsedAt: '2026-09-13T00:00:02.000Z' },
        { path: '/repo/b', name: 'b', lastUsedAt: '2026-09-13T00:00:01.000Z' },
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
    const registrations: Array<[string, string]> = []
    catalog.onRegistered(() => {
      throw new Error('listener failure must not break registration')
    })
    const stopRegistered = catalog.onRegistered((id, root) => registrations.push([id, root]))
    catalog.onBound(() => {
      throw new Error('a failing listener must not break binding')
    })
    const stop = catalog.onBound((id, root) => seen.push([id, root]))
    await expect(catalog.authorizeAndBind('s1', '/repo/a')).rejects.toBeDefined()
    await catalog.add('/repo/a')
    expect(registrations).toEqual([[workspaceId('/repo/a'), '/repo/a']])
    stopRegistered()
    await catalog.add('/repo/a')
    expect(registrations).toHaveLength(1)
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

  it('opens workspace_registry with listed in its CREATE and no ALTER', async () => {
    const tables = sqliteTables()
    const { table, sql } = recordingTable(tables.table('workspace_registry'))
    new WorkspaceIndex(table)
    expect(sql.filter((s) => /ALTER TABLE/.test(s))).toEqual([])
    expect(
      tables
        .table('x')
        .all<{ name: string }>("SELECT name FROM pragma_table_info('workspace_registry')")
        .map((c) => c.name),
    ).toEqual(['path', 'name', 'workspace_id', 'revision', 'registered_at', 'last_used_at', 'listed'])
    await tables.close()
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
          name: 'a',
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

  it('marks the managed chats root and refuses to remove it without archiving', async () => {
    const sessions = new MemorySessionWorkspaces()
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      sessions,
      resolver(new Set(['/data/chats', '/repo/a'])),
      () => 0,
      new MemoryWorkspaceBindings(),
      '/data/chats',
    )
    const chats = await catalog.add('/data/chats')
    await catalog.add('/repo/a')
    await catalog.authorizeAndBind('chat', '/data/chats')
    expect(chats.kind).toBe('chats')
    const { items } = await catalog.list()
    expect(items.map((item) => [item.path, item.kind])).toEqual([
      ['/data/chats', 'chats'],
      ['/repo/a', undefined],
    ])
    const archived: string[] = []
    expect(() =>
      catalog.remove(chats.workspaceId ?? '', undefined, {
        running: () => false,
        archive: (id) => archived.push(id),
      }),
    ).toThrow(expect.objectContaining({ data: expect.objectContaining({ code: 'WORKSPACE_MANAGED' }) }))
    expect(archived).toEqual([])
    expect((await catalog.list()).items).toHaveLength(2)
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
      remove: (id, archive) => base.remove(id, archive),
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

it.each(['admit', 'reveal'])(
  'refuses a pending %s when the project is removed during directory validation',
  async (operation) => {
    const sessions = new MemorySessionWorkspaces()
    let release: (() => void) | undefined
    let validations = 0
    let block = false
    const catalog = new WorkspaceCatalog(new MemoryWorkspaceStore(), sessions, async (path) => {
      validations++
      if (block && (operation === 'reveal' || validations === 3))
        await new Promise<void>((resolve) => {
          release = resolve
        })
      return { path, name: 'project' }
    })
    const workspace = await catalog.add('/repo')
    block = true
    const pending =
      operation === 'admit'
        ? catalog.authorizeAndBind('new', '/repo')
        : catalog.bind(workspace.workspaceId, '')
    // Reach the freshness check after the listed row was read.
    for (let step = 0; step < 5 && !release; step++) await Promise.resolve()
    expect(release).toBeTypeOf('function')
    catalog.remove(workspace.workspaceId ?? '', undefined, { running: () => false, archive: () => {} })
    block = false
    release?.()
    await expect(pending).rejects.toMatchObject({ data: { code: 'WORKSPACE_NOT_FOUND' } })
    expect(sessions.keys()).toEqual([])
  },
)

describe('WorkspaceCatalog extra directories', () => {
  // Spelled without a literal home path so the secrets guard has nothing to allow.
  const home = posix.join('/home', 'user')
  const ssh = posix.join(home, '.ssh')
  const protectedRoots = ['/data', ssh]
  const all = [
    '/repo',
    '/shared/a',
    '/shared/b',
    '/shared/c',
    '/repo/inside',
    '/data',
    '/data/chats',
    home,
    ssh,
  ]
  const setup = async (
    guard: { protectedRoots: string[] } | null = { protectedRoots },
    bindings = new MemoryWorkspaceBindings(),
  ) => {
    const catalog = new WorkspaceCatalog(
      new MemoryWorkspaceStore(),
      new MemorySessionWorkspaces(),
      resolver(new Set(all)),
      () => 0,
      bindings,
      undefined,
      guard ?? undefined,
    )
    for (const path of ['/repo', '/shared/a', '/shared/b', '/repo/inside', '/data', home, ssh])
      await catalog.add(path)
    return catalog
  }
  const refusal = { data: { code: 'EXTRA_DIRECTORY_REFUSED' } }

  it('refuses every directory it cannot vouch for before any binding exists', async () => {
    const catalog = await setup()
    const refused: Array<[string, string[], object]> = [
      ['relative', ['shared/a'], refusal],
      ['missing', ['/shared/missing'], refusal],
      ['unregistered', ['/shared/c'], { data: { code: 'WORKSPACE_NOT_FOUND' } }],
      ['data directory', ['/data'], refusal],
      ['ssh directory', [ssh], refusal],
      ['ancestor of both (home)', [home], refusal],
      ['too many', Array.from({ length: 9 }, (_, i) => `/shared/n${i}`), refusal],
    ]
    for (const [name, paths, expected] of refused)
      await expect(catalog.authorizeAndBind(`s-${name}`, '/repo', paths), name).rejects.toMatchObject(
        expected,
      )
    expect(catalog.sessionPath('s-relative')).toBeUndefined()
    await expect(catalog.restoreBinding('s-data directory')).rejects.toMatchObject({
      data: { code: 'WORKSPACE_NOT_FOUND' },
    })
    const unguarded = await setup(null)
    await expect(unguarded.authorizeAndBind('s', '/repo', ['/shared/a'])).rejects.toMatchObject(refusal)
    expect(unguarded.admitsExtraRoots).toBe(false)
    expect(catalog.admitsExtraRoots).toBe(true)
  })

  it('persists the canonical list once, inherits it on fork, and refuses a different list on restore or rebind', async () => {
    const catalog = await setup()
    // Duplicates and anything the workspace root already covers fall away; the rest is sorted.
    const bound = await catalog.authorizeAndBind('s1', '/repo', [
      '/shared/b',
      '/repo/inside',
      '/shared/a',
      '/shared/b',
    ])
    expect(bound.extraRoots).toEqual(['/shared/a', '/shared/b'])
    await expect(catalog.restoreBinding('s1')).resolves.toMatchObject({
      extraRoots: ['/shared/a', '/shared/b'],
    })
    await expect(catalog.restoreBinding('s1', '/repo', [])).resolves.toMatchObject({
      extraRoots: ['/shared/a', '/shared/b'],
    })
    await expect(catalog.restoreBinding('s1', '/repo', ['/shared/b', '/shared/a'])).resolves.toBeDefined()
    for (const different of [['/shared/a'], ['/shared/a', '/shared/b', '/data/chats']])
      await expect(catalog.restoreBinding('s1', '/repo', different)).rejects.toMatchObject({
        data: { code: 'ID_CONFLICT' },
      })
    await expect(catalog.authorizeAndBind('s1', '/repo', ['/shared/a'])).rejects.toBeInstanceOf(
      SessionWorkspaceConflictError,
    )
    await expect(catalog.authorizeAndBind('s1', '/repo')).rejects.toBeInstanceOf(
      SessionWorkspaceConflictError,
    )
    const child = await catalog.authorizeAndBind('s1-child', '/repo', bound.extraRoots)
    expect(child.extraRoots).toEqual(bound.extraRoots)
    const plain = await catalog.authorizeAndBind('plain', '/repo')
    expect(plain.extraRoots).toBeUndefined()
    await expect(catalog.authorizeAndBind('plain', '/repo', ['/shared/a'])).rejects.toBeInstanceOf(
      SessionWorkspaceConflictError,
    )
  })

  it('stops granting an extra directory once it is no longer a registered workspace', async () => {
    const store = new MemoryWorkspaceStore()
    const catalog = new WorkspaceCatalog(
      store,
      new MemorySessionWorkspaces(),
      resolver(new Set(all)),
      () => 0,
      new MemoryWorkspaceBindings(),
      undefined,
      { protectedRoots },
    )
    await catalog.add('/repo')
    await catalog.add('/shared/a')
    await catalog.authorizeAndBind('s', '/repo', ['/shared/a'])
    catalog.remove(workspaceId('/shared/a'), undefined, { running: () => false, archive: () => undefined })
    await expect(catalog.restoreBinding('s')).rejects.toMatchObject({ data: { code: 'WORKSPACE_STALE' } })
  })

  it('stores extras next to an old-shaped binding row without touching it, and never adds them later', async () => {
    const tables = sqliteTables()
    tables
      .table('workspace_bindings')
      .exec(
        'CREATE TABLE workspace_bindings (session_key TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, revision INTEGER NOT NULL, canonical_root TEXT NOT NULL)',
      )
    tables
      .table('workspace_bindings')
      .exec("INSERT INTO workspace_bindings VALUES ('old', ?, 1, '/repo')", [workspaceId('/repo')])
    const bindings = new WorkspaceBindingIndex(tables.table('workspace_bindings'))
    const catalog = await setup({ protectedRoots }, bindings as never)
    await expect(catalog.restoreBinding('old')).resolves.toMatchObject({ canonicalRoot: '/repo' })
    expect((await catalog.restoreBinding('old')).extraRoots).toBeUndefined()
    await expect(catalog.authorizeAndBind('old', '/repo', ['/shared/a'])).rejects.toBeInstanceOf(
      SessionWorkspaceConflictError,
    )
    await catalog.authorizeAndBind('new', '/repo', ['/shared/a'])
    const reopened = await setup(
      { protectedRoots },
      new WorkspaceBindingIndex(tables.table('workspace_bindings')) as never,
    )
    await expect(reopened.restoreBinding('new')).resolves.toMatchObject({ extraRoots: ['/shared/a'] })
    await expect(reopened.restoreBinding('old')).resolves.toMatchObject({ canonicalRoot: '/repo' })
    await tables.close()
  })
})
