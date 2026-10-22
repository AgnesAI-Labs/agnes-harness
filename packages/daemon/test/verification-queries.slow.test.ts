import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPackageAdminService } from '@agnes/daemon-admin/packages/handler'
import { FilePackageOperationStore } from '@agnes/daemon-admin/packages/operations'
import { CompositeTargetStore } from '@agnes/daemon-foundation/storage/composite-target-store'
import { RegistryLister, SessionRegistry } from '@agnes/daemon-rpc/local/sessions'
import { resolveProfile } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import {
  activeRuntimePinId,
  capabilityHash,
  createPackageManager,
  emptyLock,
  packageDir,
  parseSource,
  publishModelAdapterCatalog,
  readLock,
  writeLock,
} from '@agnes/package-manager'
import {
  buildRuntimeTarget,
  createPluginRow,
  decodeRuntimeTargetArtifact,
  encodeRuntimeTargetArtifact,
} from '@agnes/plugin-runtime/host'
import type { PackageAdminMethodName } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { sqliteTables } from '../../daemon-foundation/test/sqlite-tables.js'
import * as sources from '../../package-manager/src/sources.js'
import { readRunningGenerationStatus } from '../src/supervisor/generation-status-read.js'
import { readModelSelectionCatalog } from '../src/supervisor/model-adapter-lookup.js'
import { createCompositeTargetActivation } from '../src/supervisor/publication/composite-target-activation.js'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true })
})

async function fixture(companion = false, benchmark = false) {
  const root = mkdtempSync(join(tmpdir(), 'agh-query-verification-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const m = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.0.0',
    references: async () => [],
  })
  const lock = emptyLock('local-dev', '0.0.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
      n,
      { provider: 'local' },
    ]),
  )
  lock.policySnapshot.capabilityCeiling = ['tools']
  writeLock(profileDir, lock)
  const pins = []
  for (let i = 0; i < 9; i++) {
    const id = companion && i === 0 ? '@agnes/model-adapters' : `@fixture/query-${i}`,
      dir = join(root, `source-${i}`)
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: id,
        version: '1.0.0',
        license: 'MIT',
        type: 'module',
        exports: './index.js',
        agnes: {
          plugins: [
            {
              id: `ext:query-${i}`,
              export: 'plugin',
              default: true,
              apiRange: '^5.0.0',
              runtime: 'in-process',
            },
          ],
        },
      }),
    )
    writeFileSync(join(dir, 'index.js'), 'export const plugin = { apply() {} }\n')
    if (benchmark) {
      mkdirSync(join(dir, 'data'))
      for (let n = 0; n < 32; n++) writeFileSync(join(dir, 'data', `${n}.txt`), Buffer.alloc(16 * 1024, n))
    }
    const source = parseSource(`file:./source-${i}`)
    const preview = await m.inspect(profileDir, source)
    await m.install(profileDir, source, { expectedIntegrity: preview.integrity })
    const entry = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' }).packages[id]!
    await m.trust(profileDir, id, { integrity: entry.integrity, capabilityHash: capabilityHash(entry) })
    await m.enable(profileDir, id, true)
    const pinId = activeRuntimePinId({ packageId: id, integrity: entry.integrity })
    pins.push(
      await m.pinRuntimeSnapshot(profileDir, {
        pinId,
        operationId: pinId,
        packageId: id,
        purpose: 'active',
        selector: {
          kind: 'installed',
          expectedIntegrity: entry.integrity,
          expectedTreeIntegrity: entry.treeIntegrity!,
        },
      }),
    )
  }
  // Real store qualification makes skinRosterInput exercise its active/rollback pin verification.
  const tables = sqliteTables()
  const store = new CompositeTargetStore(tables.table('tree'), 'local-dev')
  const artifact = encodeRuntimeTargetArtifact(
    buildRuntimeTarget({
      rows: pins.map(({ snapshot }, i) =>
        createPluginRow({
          id: `ext:query-${i}`,
          plugin: `${snapshot.packageId}@${snapshot.integrity}/plugin`,
          exportName: 'plugin',
          snapshotDigest: snapshot.integrity,
          entryRevision: snapshot.integrity,
          extrasRevision: 'none',
          mountRevision: 'test',
        }),
      ),
      resources: { mcp: [], skills: {} },
      resourceRevision: '0'.repeat(64),
      compositeRevision: '0'.repeat(64),
    }),
  )
  store.publishDesired(artifact)
  store.qualifyConverged(1, artifact, {
    hash: artifact.identity.treeHash,
    ok: true,
    rows: pins.map((_, i) => ({ id: `ext:query-${i}`, state: 'active' })),
  })
  const admin = createPackageAdminService({
    manager: m,
    profileDirectory: () => profileDir,
    operations: new FilePackageOperationStore(join(root, 'operations')),
    pluginTree: store,
    workerGeneration: () => 1,
  })
  const profile = await resolveProfile(
    { builtin: 'local-dev' },
    {
      platform: { os: 'darwin', arch: 'arm64', capabilities: {} },
      agnesVersion: '0.0.0',
      now: '2026-10-18',
      homeDir: root,
    },
  )
  const modelList = readModelSelectionCatalog({
    profile: () => profile,
    profileDir,
    sources: () => m.runtimePluginSnapshots(profileDir),
  })
  return { root, profileDir, m, admin, modelList, profile, artifact, store, close: () => tables.close() }
}

it('bounds each light query to one installed tree and one exact referenced snapshot, on cold and warm reads', async () => {
  const f = await fixture()
  const hash = vi.spyOn(sources, 'hashDirectory')
  const asyncHash = vi.spyOn(sources, 'hashDirectoryAsync')
  try {
    for (const method of [
      '_agnes/v1/applications.get',
      '_agnes/v1/packages.list',
      '_agnes/v1/clientModules.list',
      '_agnes/v1/skins.list',
      'models',
    ] as const) {
      // Display reads of the roster and the application state reuse the last complete inventory
      // until a package write: the cold round follows one, the warm round hashes nothing.
      const settled = method === '_agnes/v1/applications.get' || method === '_agnes/v1/clientModules.list'
      for (const round of ['cold', 'warm']) {
        if (round === 'cold') await f.m.recover(f.profileDir)
        hash.mockClear()
        asyncHash.mockClear()
        const start = performance.now()
        const result =
          method === 'models'
            ? await f.modelList()
            : await f.admin.call(
                method as PackageAdminMethodName,
                { profile: 'local-dev' },
                { audience: 'admin', principalId: 'test', clientId: 'test', permissions: ['packages.read'] },
              )
        expect(result).toBeDefined()
        const counts = new Map<string, number>()
        for (const [dir] of [...hash.mock.calls, ...asyncHash.mock.calls])
          counts.set(dir, (counts.get(dir) ?? 0) + 1)
        console.log(
          'verification query',
          method,
          round,
          { sync: hash.mock.calls.length, async: asyncHash.mock.calls.length },
          `${(performance.now() - start).toFixed(2)}ms`,
        )
        expect(hash.mock.calls.length).toBe(0)
        expect(asyncHash.mock.calls.length).toBe(settled && round === 'warm' ? 0 : 18)
        expect([...counts.values()].every((count) => count === 1)).toBe(true)
      }
    }
    // Same-sized, restored-mtime edits between requests must not consume the previous memo.
    const file = join(packageDir(f.root, 'local-dev', '@fixture/query-0'), 'index.js')
    const before = statSync(file),
      text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('apply', 'applyX').slice(0, text.length))
    utimesSync(file, before.atime, before.mtime)
    await expect(f.modelList()).rejects.toMatchObject({ code: 'E_PACKAGE_INTEGRITY' })
  } finally {
    await f.close()
  }
})

it('reads a community model description only with a current exact source grant, without starting any worker', async () => {
  const f = await fixture()
  try {
    const current = await f.m.runtimePluginSnapshots(f.profileDir)
    const source = current[0]!
    publishModelAdapterCatalog(
      f.profileDir,
      f.profile.hash,
      [
        {
          id: 'community',
          models: [],
          version: '1.0.0',
          wireApi: 'community',
          sourcePackage: source.snapshot.packageId,
          capabilities: { tools: true, imageInput: false, streaming: true },
        },
      ],
      current,
    )
    expect(await f.modelList()).toContainEqual(expect.objectContaining({ id: 'community' }))
    const lock = readLock(f.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' })
    lock.packages[source.snapshot.packageId]!.state.trusted = null
    writeLock(f.profileDir, lock)
    expect(await f.modelList()).not.toContainEqual(expect.objectContaining({ id: 'community' }))
  } finally {
    await f.close()
  }
})

it.each(['untrust', 'disable'] as const)(
  'review: current real manager %s hides companion adapter descriptions despite a stale boot profile',
  async (operation) => {
    const f = await fixture(true)
    const id = '@agnes/model-adapters'
    const source = (await f.m.runtimePluginSnapshots(f.profileDir)).find((s) => s.snapshot.packageId === id)!
    const profile = {
      ...f.profile,
      packages: [
        ...f.profile.packages,
        {
          id,
          version: source.snapshot.version,
          integrity: source.snapshot.integrity,
          source: 'file:./source-0',
          trust: 'trusted' as const,
          enabled: true,
        },
      ],
    }
    const read = readModelSelectionCatalog({
      profile: () => profile,
      profileDir: f.profileDir,
      sources: () => f.m.runtimePluginSnapshots(f.profileDir),
    })
    try {
      if (operation === 'untrust')
        await f.m.untrust(f.profileDir, id, {
          integrity: source.snapshot.integrity,
          capabilityHash: source.snapshot.capabilityHash,
        })
      else await f.m.setEnabled(f.profileDir, id, false)
      expect(
        (await f.m.runtimePluginSnapshots(f.profileDir)).filter(
          (s) => s.snapshot.packageId === id && s.trusted && s.enabled !== false,
        ),
      ).toEqual([])
      expect((await read()).filter((a) => a.sourcePackage === id)).toEqual([])
    } finally {
      await f.close()
    }
  },
)

it('opens a real Host session with bounded source verification and still refuses later tampering', async () => {
  const f = await fixture()
  const runtimePluginSources = () => f.m.runtimePluginSnapshots(f.profileDir)
  const { host } = await createTestHost({
    dataDir: f.root,
    script: [],
    disableSessionTitle: true,
    packageDirs: {
      '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)),
      '@agnes/code': fileURLToPath(new URL('../../code', import.meta.url)),
    },
    runtimePluginSources,
    extensionLoader: { import: async (file) => import(pathToFileURL(file).href) },
  })
  try {
    await host.applyRuntimeTarget(decodeRuntimeTargetArtifact(f.artifact))
    const hash = vi.spyOn(sources, 'hashDirectory')
    const asyncHash = vi.spyOn(sources, 'hashDirectoryAsync')
    const start = performance.now()
    const session = await host.createSession({ key: 'verify-session', cwd: f.root })
    console.log(
      'verification session open',
      { sync: hash.mock.calls.length, async: asyncHash.mock.calls.length },
      `${(performance.now() - start).toFixed(2)}ms`,
    )
    const counts = new Map<string, number>()
    for (const [directory] of [...hash.mock.calls, ...asyncHash.mock.calls])
      counts.set(directory, (counts.get(directory) ?? 0) + 1)
    const installed = [...counts].filter(
      ([dir]) =>
        dir.startsWith(join(f.root, 'profiles', 'local-dev', 'packages')) &&
        !dir.includes('.runtime-snapshots'),
    )
    const snapshots = [...counts].filter(([dir]) => dir.includes('.runtime-snapshots'))
    const generations = [...counts].filter(([dir]) => dir.includes('.runtime-generations'))
    expect(installed).toHaveLength(9)
    expect(snapshots).toHaveLength(9)
    const syncCounts = new Map<string, number>()
    for (const [directory] of hash.mock.calls) syncCounts.set(directory, (syncCounts.get(directory) ?? 0) + 1)
    // Keep the previous per-directory synchronous budgets, and additionally bound the combined total below.
    expect([...installed, ...snapshots].every(([dir]) => (syncCounts.get(dir) ?? 0) <= 3)).toBe(true)
    expect(generations.every(([dir]) => (syncCounts.get(dir) ?? 0) <= 2)).toBe(true)
    console.log('verification counts by tree', {
      installed: installed.map(([, n]) => n),
      snapshots: snapshots.map(([, n]) => n),
      generations: generations.map(([, n]) => n),
    })
    // Creating/publishing a new code archive intentionally ends the preceding read phase.
    // Independent copy validation and the publication reader retain fresh verification.
    // The previous fixture observed 99 sync + 54 async walks. Count both kinds after the conversion.
    expect(hash.mock.calls.length).toBeLessThanOrEqual(99)
    expect(hash.mock.calls.length + asyncHash.mock.calls.length).toBeLessThanOrEqual(153)
    // Review probe: the original asynchronous import/use gates remain independent of the memo.
    console.log('verification async read and use gates', asyncHash.mock.calls.length)
    expect(asyncHash.mock.calls.length).toBeGreaterThanOrEqual(45)
    await session.close()
    const file = join(packageDir(f.root, 'local-dev', '@fixture/query-0'), 'index.js')
    writeFileSync(file, readFileSync(file, 'utf8').replace('apply', 'throw'))
    await expect(host.createSession({ key: 'tampered-session', cwd: f.root })).rejects.toThrow()
  } finally {
    await host.close()
    await f.close()
  }
}, 60_000)

it('a package status read does not start a worker to decorate inventory', async () => {
  const acquireSharedWorker = vi.fn(async () => {
    throw new Error('must not start')
  })
  const pool = { businessWorker: () => undefined, acquireSharedWorker }
  await expect(readRunningGenerationStatus(pool, 3000)).rejects.toThrow('without a running worker')
  expect(acquireSharedWorker).not.toHaveBeenCalled()
})

it('review: the live status read does not wait for a busy worker for the whole startup budget', async () => {
  const command = vi.fn(async () => ({ plugins: [] }))
  const pool = { businessWorker: () => ({ link: { alive: true, command } }) }
  await readRunningGenerationStatus(pool as never, 30_000)
  expect(command).toHaveBeenCalledWith('pluginGenerations.status', {}, { timeoutMs: 3000 })
  await readRunningGenerationStatus(pool as never, 1000)
  expect(command).toHaveBeenLastCalledWith('pluginGenerations.status', {}, { timeoutMs: 1000 })
})

it.each([false, true])(
  'review: package list observes whether a worker is actually starting (%s)',
  async (starting) => {
    const f = await fixture()
    const inventory = await f.m.inventory(f.profileDir)
    const activation = createCompositeTargetActivation({
      store: f.store,
      workerGeneration: () => undefined,
      workerStarting: () => starting,
      contributions: (id) => inventory.packages.find((p) => p.id === id)?.contributions,
      generationStatus: () => readRunningGenerationStatus({ businessWorker: () => undefined }, 3000),
    })
    const admin = createPackageAdminService({
      manager: f.m,
      profileDirectory: () => f.profileDir,
      operations: new FilePackageOperationStore(join(f.root, 'read-review-operations')),
      pluginTree: f.store,
      workerGeneration: () => undefined,
      activation,
    })
    try {
      const listed = (await admin.call(
        '_agnes/v1/packages.list',
        { profile: 'local-dev' },
        { audience: 'admin', principalId: 'test', clientId: 'test', permissions: ['packages.read'] },
      )) as {
        packages: { actual: string; primaryStatus?: { reasonCode: string; reason: { en: string } } }[]
      }
      expect(listed.packages).toHaveLength(9)
      expect(
        listed.packages.every((p) => p.primaryStatus?.reasonCode === (starting ? 'starting' : 'not-running')),
      ).toBe(true)
      if (!starting)
        expect(listed.packages[0]!.primaryStatus?.reason.en).toContain('Start a session when needed')
    } finally {
      await f.close()
    }
  },
)

it('keeps scheduled session-list requests responsive during nine-package list/skin/mixed reads', async () => {
  const f = await fixture(false, true)
  const { host } = await createTestHost({ dataDir: f.root, script: [], disableSessionTitle: true })
  const lister = new RegistryLister(new SessionRegistry(host, { clock: Date.now }))
  const actual = sources.hashDirectoryAsync
  const asyncHash = vi.spyOn(sources, 'hashDirectoryAsync')
  const read = (method: PackageAdminMethodName) =>
    f.admin.call(
      method,
      { profile: 'local-dev' },
      {
        audience: 'admin',
        principalId: 'test',
        clientId: 'test',
        permissions: ['packages.read'],
      },
    )
  try {
    for (const mode of ['sync-control', 'async'] as const) {
      if (mode === 'sync-control')
        asyncHash.mockImplementation(async (...args) => sources.hashDirectory(...args))
      else asyncHash.mockImplementation(actual)
      for (const query of ['package', 'skin', 'mixed'] as const) {
        const latencies: number[] = []
        for (let round = 0; round < 3; round++) {
          let running = true
          const light = (async () => {
            do {
              const start = performance.now()
              await new Promise<void>((resolve) => setImmediate(resolve))
              expect((await lister.list({})).items).toEqual([])
              latencies.push(performance.now() - start)
            } while (running)
          })()
          try {
            if (query === 'mixed')
              await Promise.all([
                read('_agnes/v1/packages.list'),
                read('_agnes/v1/skins.list'),
                f.modelList(),
              ])
            else await read(query === 'skin' ? '_agnes/v1/skins.list' : '_agnes/v1/packages.list')
          } finally {
            running = false
            await light
          }
        }
        console.log(
          'verification responsiveness',
          JSON.stringify({
            mode,
            query,
            samples: latencies.length,
            maxMs: latencies.reduce((maximum, value) => Math.max(maximum, value), 0),
          }),
        )
        expect(latencies.length).toBeGreaterThan(0)
      }
    }
  } finally {
    asyncHash.mockRestore()
    await host.close()
    await f.close()
  }
}, 90_000)
