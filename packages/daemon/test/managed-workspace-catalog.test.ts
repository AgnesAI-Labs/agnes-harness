import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { MemorySessionWorkspaces } from '@agnes/daemon-foundation/storage/lister'
import { createPrivateDirectorySync } from '@agnes/system-node'
import { expect, test, vi } from 'vitest'
import { openWorkspaceCatalog } from '../src/supervisor/workspace-catalog.js'

const deviceDrift = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    lstat: async (...args: Parameters<typeof fs.lstat>) => {
      const info = await fs.lstat(...args)
      if (typeof args[0] === 'string' && deviceDrift.has(args[0]) && typeof info.dev === 'bigint')
        info.dev += 3n
      return info
    },
  }
})

test('schedule-only legacy remains listed when Documents fails and no old directory is recreated', async () => {
  const base = await mkdtemp(join(tmpdir(), 'managed-catalog-'))
  const dataDir = join(await realpath(base), 'data')
  await mkdir(dataDir)
  const legacy = join(dataDir, 'chats')
  createPrivateDirectorySync(legacy)
  const catalog = await openWorkspaceCatalog({
    dataDir,
    ownerHome: await realpath(base),
    tables: undefined,
    sessions: new MemorySessionWorkspaces(),
    clock: () => 0,
    workspaceRoot: undefined,
    legacySchedules: [{ scheduleId: 's', targetRoot: legacy }],
    documentsDirectory: async () => {
      throw Error('no documents')
    },
  })
  expect(catalog.managedChats.currentError).toBeDefined()
  expect((await catalog.list()).items).toMatchObject([{ path: legacy, kind: 'chats', managedRole: 'legacy' }])
  await expect(catalog.authorizeAndBind('ordinary', legacy)).rejects.toThrow()
})

test('refreshes the legacy identity only when the parent volume renumbers with it at startup', async () => {
  const { sqliteTables } = await import('../../daemon-foundation/test/sqlite-tables.js')
  const { WorkspaceBindingIndex, WorkspaceIndex, workspaceIdFor } = await import(
    '@agnes/daemon-foundation/storage/workspaces'
  )
  const { lstat, rename } = await import('node:fs/promises')
  const base = await mkdtemp(join(tmpdir(), 'managed-catalog-'))
  const dataDir = join(await realpath(base), 'data')
  await mkdir(dataDir)
  const legacy = join(dataDir, 'chats')
  createPrivateDirectorySync(legacy)
  const tables = sqliteTables()
  new WorkspaceIndex(tables.table('workspace_registry')).put(
    { path: legacy, name: 'chats' },
    new Date(0).toISOString(),
  )
  new WorkspaceBindingIndex(tables.table('workspace_bindings')).putIfAbsent({
    sessionKey: 'old',
    canonicalRoot: legacy,
    workspaceId: workspaceIdFor(legacy),
    revision: 1,
  })
  const input = {
    dataDir,
    ownerHome: await realpath(base),
    tables,
    sessions: new MemorySessionWorkspaces(),
    clock: () => 0,
    workspaceRoot: undefined,
    documentsDirectory: async () => {
      throw Error('no documents')
    },
  }
  const catalog = await openWorkspaceCatalog(input)
  expect((await catalog.restoreBinding('old')).legacyChatReadGrant?.root).toBe(legacy)
  const legacyInfo = await lstat(legacy, { bigint: true })
  const currentIdentity = `${legacyInfo.dev}:${legacyInfo.ino}`
  const rebootIdentity = `${legacyInfo.dev + 3n}:${legacyInfo.ino}`
  const authorityTable = tables.table('managed_chat_authority')
  const recorded = () =>
    JSON.parse(
      authorityTable.get<{ payload: string }>('SELECT payload FROM managed_chat_authority WHERE id = 1')
        ?.payload ?? '{}',
    )
  expect(recorded()).toMatchObject({ legacyDirectoryIdentity: currentIdentity })
  deviceDrift.add(legacy)
  try {
    // A foreign filesystem replaces only the child, including on a fresh daemon boot.
    const mounted = await openWorkspaceCatalog(input)
    await expect(mounted.restoreBinding('old')).rejects.toThrow()
    expect((await mounted.list()).items).toMatchObject([
      { path: legacy, kind: 'chats', managedRole: 'legacy', available: false },
    ])
    expect(recorded()).toMatchObject({ legacyDirectoryIdentity: currentIdentity })
    // A reboot renumbers the data directory and its historical child together.
    deviceDrift.add(dataDir)
    const restarted = await openWorkspaceCatalog(input)
    expect((await restarted.restoreBinding('old')).legacyChatReadGrant?.directoryIdentity).toBe(
      rebootIdentity,
    )
    expect(recorded()).toMatchObject({ legacyDirectoryIdentity: rebootIdentity })
    await expect(catalog.restoreBinding('old')).rejects.toThrow()
  } finally {
    deviceDrift.clear()
  }
  await rename(legacy, `${legacy}-saved`)
  createPrivateDirectorySync(legacy)
  await expect(catalog.restoreBinding('old')).rejects.toThrow()
  const reopened = await openWorkspaceCatalog(input)
  await expect(reopened.restoreBinding('old')).rejects.toThrow()
  await tables.close()
})

test.each(['installation-home', 'external-profile', 'external-secrets'] as const)(
  'does not publish Documents redirected into configured %s',
  async (kind) => {
    const { readdir } = await import('node:fs/promises')
    const base = await realpath(await mkdtemp(join(tmpdir(), 'managed-private-docs-')))
    const ownerHome = join(base, 'installation')
    const protectedRoot = kind === 'installation-home' ? ownerHome : join(base, kind)
    const documents = join(protectedRoot, 'documents')
    await mkdir(documents, { recursive: true })
    const catalog = await openWorkspaceCatalog({
      dataDir: join(base, 'data'),
      ownerHome,
      privateRoots: kind === 'installation-home' ? [] : [protectedRoot],
      tables: undefined,
      sessions: new MemorySessionWorkspaces(),
      clock: () => 0,
      workspaceRoot: undefined,
      documentsDirectory: async () => documents,
    })
    expect(catalog.managedChats.current).toBeUndefined()
    expect(catalog.managedChats.currentError).toBeDefined()
    expect(await readdir(documents)).toEqual([])
    expect((await catalog.list()).items).toEqual([])
  },
)

test('allows a managed sibling when configured private home is below Documents', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'managed-private-sibling-')))
  const documents = join(base, 'documents')
  const ownerHome = join(documents, '.configured-home')
  await mkdir(ownerHome, { recursive: true })
  const catalog = await openWorkspaceCatalog({
    dataDir: join(ownerHome, 'data'),
    ownerHome,
    tables: undefined,
    sessions: new MemorySessionWorkspaces(),
    clock: () => 0,
    workspaceRoot: undefined,
    documentsDirectory: async () => documents,
  })
  expect(catalog.managedChats.currentError).toBeUndefined()
  expect(catalog.managedChats.current?.startsWith(join(documents, 'Agnes Harness', 'chats-'))).toBe(true)
})

test.each(['deleted', 'tampered'] as const)(
  'a %s current marker never downgrades its durable root into a project',
  async (damage) => {
    const { sqliteTables } = await import('../../daemon-foundation/test/sqlite-tables.js')
    const { rm, writeFile, readdir, symlink } = await import('node:fs/promises')
    const base = await realpath(await mkdtemp(join(tmpdir(), 'managed-current-failed-')))
    const ownerHome = join(base, 'home')
    const documents = join(base, 'documents')
    await mkdir(documents)
    const tables = sqliteTables()
    const input = {
      dataDir: join(base, 'data'),
      ownerHome,
      tables,
      sessions: new MemorySessionWorkspaces(),
      clock: () => 0,
      workspaceRoot: undefined,
      documentsDirectory: async () => documents,
    }
    const first = await openWorkspaceCatalog(input)
    const root = first.managedChats.current
    if (!root) throw Error('initial root was not prepared')
    await first.authorizeAndBind('existing', root)
    const prior = (await first.list()).items.find((row) => row.path === root)
    const workspaceId = prior?.workspaceId
    if (!prior || !workspaceId) throw Error('initial root was not registered')
    const marker = join(root, '.agh-managed-root.json')
    if (damage === 'deleted') await rm(marker)
    else await writeFile(marker, JSON.stringify({ version: 1, id: 'foreign', ownerNonce: 'foreign' }))
    const reopened = await openWorkspaceCatalog({
      ...input,
      documentsDirectory: async () => {
        throw Error('must not select another root')
      },
    })
    expect(reopened.managedChats.currentError).toBeDefined()
    expect((await reopened.list()).items.find((row) => row.path === root)).toMatchObject({
      workspaceId: workspaceId,
      revision: prior.revision,
      kind: 'chats',
      managedRole: 'current',
      available: false,
    })
    await expect(reopened.authorizeAndBind('fresh', root)).rejects.toThrow()
    await expect(reopened.restoreBinding('existing')).rejects.toThrow()
    await expect(reopened.bind(workspaceId, root)).rejects.toThrow()
    const alias = join(base, 'current-alias')
    await symlink(root, alias)
    await expect(reopened.add(alias)).rejects.toThrow()
    expect(() =>
      reopened.remove(workspaceId, prior.revision, { running: () => false, archive: () => {} }),
    ).toThrow()
    expect(await readdir(join(documents, 'Agnes Harness'))).toEqual([basename(root)])
    await tables.close()
  },
)
