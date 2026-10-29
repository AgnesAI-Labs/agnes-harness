import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import {
  createPackageManager,
  emptyLock,
  hashDirectory,
  packageDir,
  parseSource,
  readInventory,
  writeLock,
} from '../src/index.js'
import { inspectStaged } from '../src/inspect.js'
import { capabilityHash } from '../src/integrity.js'
import { isRuntimePackageEligible, isSnapshotPackageEligible } from '../src/inventory.js'
import { previousPackageDir } from '../src/store.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const roots: string[] = []

async function currentFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-inventory-round-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const id = '@acme/round'
  const directory = packageDir(root, 'local-dev', id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      license: 'MIT',
      exports: './index.mjs',
      agnes: {
        plugins: [
          {
            id: 'ext:acme/round',
            export: 'main',
            apiRange: '^5.0.0',
            runtime: 'in-process',
            capabilities: {
              ui: true,
              streams: [
                {
                  name: 'events',
                  scope: 'profile',
                  lane: 'events',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  directions: ['outbound'],
                  maxFrameBytes: 1024,
                  maxBufferedBytes: 2048,
                  maxBytesPerSecond: 4096,
                },
              ],
            },
          },
        ],
        clientDescriptors: [{ rowId: 'ext:acme/round', path: './agnes.client.json' }],
      },
    }),
  )
  writeFileSync(join(directory, 'index.mjs'), 'export const main = () => {}\n')
  writeFileSync(join(directory, 'client.js'), 'export {}')
  writeFileSync(
    join(directory, 'agnes.client.json'),
    JSON.stringify({ client: { entry: './client.js', streams: ['events'] } }),
  )
  const tree = hashDirectory(directory, { exclude: [] })
  const source = { type: 'file' as const, ref: 'file:./round' }
  const checked = await inspectStaged({
    dir: directory,
    source,
    ceiling: ['ui', 'streams'],
    fetched: {
      dir: directory,
      version: '1.0.0',
      integrity: tree,
      license: 'MIT',
      dependencies: {},
    },
  })
  const lock = emptyLock('local-dev', '0.1.0')
  lock.policySnapshot.capabilityCeiling = ['ui', 'streams']
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
      name,
      { provider: 'local' },
    ]),
  )
  const entry = {
    version: '1.0.0',
    source,
    integrity: tree,
    treeIntegrity: tree,
    license: 'MIT',
    trust: 'trusted' as const,
    state: { installed: '2026-01-01T00:00:00Z', trusted: '2026-01-01T00:00:00Z', enabled: true },
    dependencies: {},
    previous: null,
    contributions: checked.preview.contributions,
    ...(checked.preview.declaredCapabilities
      ? { declaredCapabilities: checked.preview.declaredCapabilities }
      : {}),
  }
  lock.packages[id] = {
    ...entry,
    trustDecision: {
      integrity: tree,
      capabilityHash: capabilityHash(entry),
      decidedAt: '2026-01-01T00:00:00Z',
    },
  }
  writeLock(profileDir, lock)
  return {
    root,
    profileDir,
    id,
    directory,
    lock,
    manager: createPackageManager({ dataDir: root, agnesVersion: '0.1.0', references: async () => [] }),
  }
}

it('shares an ordinary in-flight read, then verifies bytes again even without a manager mutation', async () => {
  const f = await currentFixture()
  const [first, second] = await Promise.all([
    f.manager.inventory(f.profileDir),
    f.manager.inventory(f.profileDir),
  ])
  expect(first).toBe(second)
  expect(Object.isFrozen(first.packages)).toBe(true)
  const warm = await f.manager.inventory(f.profileDir)
  expect(warm).toEqual(first)
  expect(await f.manager.inventory(f.profileDir, { fresh: true })).toEqual(first)
  const [fresh, follower] = await Promise.all([
    f.manager.inventory(f.profileDir, { fresh: true }),
    f.manager.inventory(f.profileDir),
  ])
  expect(fresh).toBe(follower)
  expect(fresh).toEqual(first)
  writeFileSync(join(f.directory, 'index.mjs'), 'changed bytes')
  const failures = await Promise.allSettled([
    f.manager.inventory(f.profileDir),
    f.manager.inventory(f.profileDir),
    f.manager.inventory(f.profileDir, { fresh: true }),
  ])
  expect(failures.every((result) => result.status === 'rejected')).toBe(true)
  writeFileSync(join(f.directory, 'index.mjs'), 'export const main = () => {}\n')
  expect((await f.manager.inventory(f.profileDir)).packages[0]?.enabled).toBe(true)
})

it('cuts read boundaries on mutations, fresh verification and administrator policy changes', async () => {
  const f = await currentFixture()
  const before = f.manager.inventory(f.profileDir)
  const disable = f.manager.enable(f.profileDir, f.id, false)
  const during = f.manager.inventory(f.profileDir)
  await before
  await disable
  expect((await during).packages[0]?.enabled).toBe(false)
  await f.manager.enable(f.profileDir, f.id, true)
  const ordinary = f.manager.inventory(f.profileDir)
  const fresh = f.manager.inventory(f.profileDir, { fresh: true })
  expect(await ordinary).not.toBe(await fresh)
  const oldPolicy = f.manager.inventory(f.profileDir)
  writeFileSync(join(f.profileDir, 'plugin-capabilities.json'), JSON.stringify({ deny: ['ui'] }))
  const denied = f.manager.inventory(f.profileDir)
  expect(await oldPolicy).not.toBe(await denied)
  expect((await denied).packages[0]?.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-blocked', 'ui'],
  })
  expect((await f.manager.inventory(f.profileDir, { fresh: true })).packages[0]?.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-blocked', 'ui'],
  })
  writeFileSync(join(f.profileDir, 'plugin-capabilities.json'), '{}')
  writeFileSync(
    join(f.profileDir, 'package-sources.json'),
    JSON.stringify({ allowedSources: 'official-only' }),
  )
  await expect(f.manager.inventory(f.profileDir)).rejects.toMatchObject({ code: 'E_PACKAGE_SOURCE_POLICY' })
  writeFileSync(join(f.profileDir, 'package-sources.json'), '{}')
  expect((await f.manager.inventory(f.profileDir)).packages[0]?.blockers).toEqual([])
  const entry = f.lock.packages[f.id]
  if (!entry) throw new Error('missing fixture entry')
  await f.manager.untrust(f.profileDir, f.id, {
    integrity: entry.integrity,
    capabilityHash: capabilityHash(entry),
  })
  expect((await f.manager.inventory(f.profileDir)).packages[0]).toMatchObject({
    trusted: false,
    enabled: false,
  })
})

it('blocks one package with removed package-level agnes.capabilities without aborting inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-inventory-isolation-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const lock = emptyLock('local-dev', '0.1.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
      name,
      { provider: 'local' },
    ]),
  )
  lock.policySnapshot = { capabilityCeiling: [], workspacePackages: 'require-project-trust' }
  for (const [id, agnes] of [
    [
      'acme/stale-skill',
      { provides: ['skills'], capabilities: {}, plugins: [{ export: 'main', apiRange: '^5.0.0' }] },
    ],
    ['acme/good', { plugins: [{ export: 'main', apiRange: '^5.0.0' }] }],
  ] as const) {
    const directory = packageDir(root, 'local-dev', id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: id, version: '1.0.0', license: 'MIT', exports: './index.mjs', agnes }),
    )
    writeFileSync(join(directory, 'index.mjs'), 'export const main = () => {}\n')
    const treeIntegrity = hashDirectory(directory, { exclude: [] })
    lock.packages[id] = {
      version: '1.0.0',
      source: { type: 'file', ref: `file:./${id}` },
      integrity: treeIntegrity,
      trust: 'trusted',
      license: 'MIT',
      state: { installed: '2026-09-21T00:00:00.000Z', trusted: null, enabled: false },
      dependencies: {},
      previous: null,
      contributions: [],
      treeIntegrity,
    }
  }
  writeLock(profileDir, lock)
  const inventory = readInventory(lock, { dataDir: root, profileDir, ceiling: [] })
  const stale = inventory.packages.find((p) => p.id === 'acme/stale-skill')
  expect(stale?.blockers).toEqual([
    { code: 'incompatible', references: ['agnes-metadata', 'docs/guide/packages.md'] },
  ])
  if (!stale) throw new Error('missing stale row')
  expect(isRuntimePackageEligible({ ...stale, trusted: true, enabled: true })).toBe(false)
  expect(inventory.packages.find((p) => p.id === 'acme/good')).toBeDefined()
})

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([
  [{ apiRange: '^5.0.0', export: 'panel', id: 'web:legacy/panel' }, ['reserved-row-id:web:']],
  [{ export: 'panel', id: 'ext:legacy/panel' }, ['plugin-api-range-required', 'docs/guide/packages.md']],
  [
    { apiRange: '^99.0.0', export: 'panel', id: 'ext:legacy/panel' },
    ['plugin-api-range-incompatible', 'docs/guide/packages.md'],
  ],
])('keeps a legacy package %j in inventory as a deletable blocker', async (plugin, references) => {
  const root = mkdtempSync(join(tmpdir(), 'agnes-inventory-legacy-web-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const id = 'acme/pkg-a'
  const directory = packageDir(root, 'local-dev', id)
  mkdirSync(dirname(directory), { recursive: true })
  cpSync(join(fixtures, 'pkg-a'), directory, { recursive: true })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      license: 'MIT',
      exports: './index.mjs',
      agnes: { plugins: [plugin] },
    }),
  )
  writeFileSync(join(directory, 'index.mjs'), 'export default () => ({})\n')
  const treeIntegrity = hashDirectory(directory, { exclude: [] })
  const lock = emptyLock('local-dev', '0.1.0')
  lock.resolvedProfileHash = `sha256-${'0'.repeat(64)}`
  lock.seams = Object.fromEntries(
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((name) => [
      name,
      { provider: 'local' },
    ]),
  )
  lock.policySnapshot = { capabilityCeiling: [], workspacePackages: 'require-project-trust' }
  lock.packages[id] = {
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./legacy' },
    integrity: treeIntegrity,
    trust: 'trusted',
    license: 'MIT',
    state: { installed: '2026-09-21T00:00:00.000Z', trusted: null, enabled: false },
    dependencies: {},
    previous: null,
    contributions: [],
    treeIntegrity,
  }
  const entry = lock.packages[id]
  if (!entry) throw new Error('missing legacy package')
  const { previous: _previous, ...snapshot } = entry
  entry.previous = snapshot
  cpSync(directory, previousPackageDir({ dataDir: root, profile: 'local-dev' }, id), { recursive: true })
  writeLock(profileDir, lock)

  const inventory = readInventory(lock, { dataDir: root, profileDir, ceiling: [] })
  expect(inventory.packages[0]?.blockers).toEqual([{ code: 'incompatible', references }])
  expect(inventory.packages[0]?.verifiedRollbackTarget).toBeNull()
  const row = inventory.packages[0]
  if (!row) throw new Error('missing legacy inventory')
  expect(isRuntimePackageEligible({ ...row, trusted: true, enabled: true })).toBe(false)
  expect(isSnapshotPackageEligible({ ...row, trusted: true })).toBe(false)
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.1.0',
    references: async () => [],
  })
  await expect(
    manager.trust(profileDir, id, { integrity: treeIntegrity, capabilityHash: row.capabilityHash }),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
  await expect(manager.enable(profileDir, id, true)).rejects.toMatchObject({ code: 'E_PACKAGE_BLOCKED' })
  const sourceDir = join(root, 'migrated')
  cpSync(directory, sourceDir, { recursive: true })
  writeFileSync(
    join(sourceDir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.1',
      license: 'MIT',
      exports: './index.mjs',
      agnes: { plugins: [{ apiRange: '^5.0.0', export: 'panel', id: 'ext:legacy/panel' }] },
    }),
  )
  const source = parseSource('file:./migrated')
  const preview = await manager.inspect(profileDir, source)
  await manager.update(profileDir, id, source, { expectedIntegrity: preview.integrity })
  expect((await manager.inventory(profileDir)).packages[0]?.verifiedRollbackTarget).toBeNull()
  if (!preview.capabilityHash) throw new Error('missing migrated capability hash')
  await manager.trust(profileDir, id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  await manager.enable(profileDir, id, true)
  const migrated = (await manager.inventory(profileDir)).packages[0]
  if (!migrated) throw new Error('missing migrated package')
  expect(isRuntimePackageEligible(migrated)).toBe(true)
  await manager.remove(profileDir, id)
  expect((await manager.inventory(profileDir)).packages).toEqual([])
  expect(existsSync(directory)).toBe(false)
})

// The immutable tree is unchanged; older normalization lost only the client stream grants.
it('opens an earlier reviewed snapshot without granting newly discovered streams, then requires a reviewed update', async () => {
  const f = await currentFixture()
  const entry = f.lock.packages[f.id]
  assert(entry?.contributions && entry.trustDecision)
  entry.contributions = entry.contributions.map((row) => {
    if (!('client' in row) || !row.client) return row
    const { streams: _streams, ...client } = row.client
    return { ...row, client }
  })
  const priorHash = capabilityHash(entry)
  entry.trustDecision = { ...entry.trustDecision, capabilityHash: priorHash }
  writeLock(f.profileDir, f.lock)
  const old = (await f.manager.inventory(f.profileDir)).packages[0]
  assert(old)
  expect(old.trusted).toBe(true)
  expect(old.capabilityHash).toBe(priorHash)
  expect(old.contributions.every((row) => !('client' in row) || !row.client?.streams)).toBe(true)
  const source = parseSource(`file:${f.directory.split(sep).join('/')}`)
  const preview = await f.manager.inspect(f.profileDir, source)
  assert(preview.capabilityHash)
  expect(preview.capabilityHash).not.toBe(priorHash)
  expect(
    preview.contributions.some((row) => 'client' in row && row.client?.streams?.includes('events')),
  ).toBe(true)
  await f.manager.update(f.profileDir, f.id, source, {
    expectedIntegrity: preview.integrity,
    expectedInstalledIntegrity: old.entry.integrity,
    activation: {
      expectedInstalledIntegrity: old.entry.integrity,
      trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash },
    },
  })
  const updated = (await f.manager.inventory(f.profileDir)).packages[0]
  assert(updated)
  expect(updated).toMatchObject({ trusted: true, enabled: true, capabilityHash: preview.capabilityHash })
  expect(updated.contributions).toEqual(preview.contributions)
  const changed = structuredClone(f.lock)
  const changedEntry = changed.packages[f.id]
  assert(changedEntry)
  changedEntry.contributions = preview.contributions.map((row) =>
    'client' in row && row.client ? { ...row, client: { ...row.client, streams: ['unreviewed'] } } : row,
  )
  expect(() => readInventory(changed, { dataDir: f.root, profileDir: f.profileDir })).toThrow(
    'metadata differs',
  )
})

it('serves a settled read from the last complete one: no lock, no re-hash, until a write or a boundary change', async () => {
  const f = await currentFixture()
  const first = await f.manager.inventory(f.profileDir)
  const index = join(f.directory, 'index.mjs')
  const lockFile = join(f.profileDir, '.agnes-lock.lock')
  // A live holder of the package lock and an edit to installed bytes: nothing an ordinary read tolerates.
  writeFileSync(lockFile, String(process.pid))
  writeFileSync(index, 'changed bytes')
  try {
    const settled = await Promise.race([
      f.manager.inventory(f.profileDir, { settled: true }),
      new Promise<'waited'>((done) => setTimeout(() => done('waited'), 2000)),
    ])
    expect(settled).toBe(first)
  } finally {
    rmSync(lockFile, { force: true })
  }
  // Ordinary and fresh reads keep verifying bytes: the guarantee given up is for settled readers only.
  await expect(f.manager.inventory(f.profileDir, { fresh: true })).rejects.toBeDefined()
  // Once a verifying read has failed, the earlier complete one is no longer served.
  await expect(f.manager.inventory(f.profileDir, { settled: true })).rejects.toBeDefined()
})

it('stops serving the settled read after an ordinary read fails verification', async () => {
  const f = await currentFixture()
  const first = await f.manager.inventory(f.profileDir)
  writeFileSync(join(f.directory, 'index.mjs'), 'changed bytes')
  expect(await f.manager.inventory(f.profileDir, { settled: true })).toBe(first)
  await expect(f.manager.inventory(f.profileDir)).rejects.toBeDefined()
  await expect(f.manager.inventory(f.profileDir, { settled: true })).rejects.toBeDefined()
})

it('registers the first settled read and refreshes the settled one on every ordinary or fresh read', async () => {
  const f = await currentFixture()
  const first = await f.manager.inventory(f.profileDir, { settled: true })
  expect(await f.manager.inventory(f.profileDir, { settled: true })).toBe(first)
  const ordinary = await f.manager.inventory(f.profileDir)
  expect(ordinary).not.toBe(first)
  expect(await f.manager.inventory(f.profileDir, { settled: true })).toBe(ordinary)
  const fresh = await f.manager.inventory(f.profileDir, { fresh: true })
  expect(await f.manager.inventory(f.profileDir, { settled: true })).toBe(fresh)
  // `fresh` wins over `settled`: a publication read is never answered from memory.
  expect(await f.manager.inventory(f.profileDir, { fresh: true, settled: true })).not.toBe(fresh)
})

it('drops the settled read on a package write, a changed policy file, and a write that overlapped the read', async () => {
  const f = await currentFixture()
  const same = async () => {
    const settled = await f.manager.inventory(f.profileDir, { settled: true })
    // Equivalence: whatever a settled read returns is what a verifying read returns now.
    expect(settled).toEqual(await f.manager.inventory(f.profileDir, { fresh: true }))
    return settled
  }
  expect((await same()).packages[0]?.enabled).toBe(true)
  await f.manager.enable(f.profileDir, f.id, false)
  expect((await same()).packages[0]?.enabled).toBe(false)
  await f.manager.enable(f.profileDir, f.id, true)
  expect((await same()).packages[0]?.enabled).toBe(true)
  // Another process rewriting a policy file changes the boundary, not this process's epoch.
  await f.manager.inventory(f.profileDir, { settled: true })
  writeFileSync(join(f.profileDir, 'plugin-capabilities.json'), JSON.stringify({ deny: ['ui'] }))
  expect((await same()).packages[0]?.blockers).toContainEqual({
    code: 'policy',
    references: ['capability-blocked', 'ui'],
  })
  writeFileSync(join(f.profileDir, 'plugin-capabilities.json'), '{}')
  expect((await same()).packages[0]?.blockers).toEqual([])
  // A write that starts while a read is running, without touching the boundary files: the read's
  // result must not become the settled one while that write is still waiting for the lock.
  const overlapped = f.manager.inventory(f.profileDir)
  const recovery = f.manager.recover(f.profileDir)
  const read = await overlapped
  expect(await f.manager.inventory(f.profileDir, { settled: true })).not.toBe(read)
  await recovery
})

it('keeps the settled read across pin bookkeeping, which changes neither the lock nor the trees', async () => {
  const f = await currentFixture()
  const first = await f.manager.inventory(f.profileDir)
  await f.manager.collectRuntimeSnapshots(f.profileDir)
  await f.manager.listRuntimePins(f.profileDir)
  expect(await f.manager.inventory(f.profileDir, { settled: true })).toBe(first)
})
