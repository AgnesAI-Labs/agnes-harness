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
import { isRuntimePackageEligible, isSnapshotPackageEligible } from '../src/inventory.js'
import { previousPackageDir } from '../src/store.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([
  [{ apiRange: '^1.4.0', export: 'panel', id: 'web:legacy/panel' }, ['reserved-row-id:web:']],
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
    [
      'approval',
      'checkpoint',
      'ledger',
      'sandbox',
      'verifier',
      'repair',
      'artifacts',
      'principals',
      'platform',
      'harness',
    ].map((name) => [name, '@agnes/base']),
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
      agnes: { plugins: [{ apiRange: '^1.4.0', export: 'panel', id: 'ext:legacy/panel' }] },
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
