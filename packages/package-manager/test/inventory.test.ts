import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

function currentFixture() {
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
      agnes: { plugins: [{ export: 'main', apiRange: '^3.0.0', capabilities: { ui: true } }] },
    }),
  )
  writeFileSync(join(directory, 'index.mjs'), 'export const main = () => {}\n')
  const tree = hashDirectory(directory, { exclude: [] })
  const source = { type: 'file' as const, ref: 'file:./round' }
  const checked = inspectStaged({
    dir: directory,
    source,
    ceiling: [],
    fetched: {
      dir: directory,
      version: '1.0.0',
      integrity: tree,
      license: 'MIT',
      dependencies: {},
    },
  })
  const lock = emptyLock('local-dev', '0.1.0')
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
  const f = currentFixture()
  const [first, second] = await Promise.all([
    f.manager.inventory(f.profileDir),
    f.manager.inventory(f.profileDir),
  ])
  expect(first).toBe(second)
  expect(Object.isFrozen(first.packages)).toBe(true)
  writeFileSync(join(f.directory, 'index.mjs'), 'changed bytes')
  const failures = await Promise.allSettled([
    f.manager.inventory(f.profileDir),
    f.manager.inventory(f.profileDir),
  ])
  expect(failures.every((result) => result.status === 'rejected')).toBe(true)
  writeFileSync(join(f.directory, 'index.mjs'), 'export const main = () => {}\n')
  expect((await f.manager.inventory(f.profileDir)).packages[0]?.enabled).toBe(true)
})

it('cuts read boundaries on mutations, fresh verification and administrator policy changes', async () => {
  const f = currentFixture()
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

it('blocks one package with removed package-level agnes.capabilities without aborting inventory', () => {
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
      { kinds: ['skills'], capabilities: {}, plugins: [{ export: 'main', apiRange: '^3.0.0' }] },
    ],
    ['acme/good', { plugins: [{ export: 'main', apiRange: '^3.0.0' }] }],
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
  [{ apiRange: '^3.0.0', export: 'panel', id: 'web:legacy/panel' }, ['reserved-row-id:web:']],
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
      agnes: { plugins: [{ apiRange: '^3.0.0', export: 'panel', id: 'ext:legacy/panel' }] },
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
