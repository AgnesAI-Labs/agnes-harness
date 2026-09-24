import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { emptyLock, hashDirectory, packageDir, readInventory, writeLock } from '../src/index.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('keeps a legacy web-row package in inventory as a deletable blocker', () => {
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
      agnes: { plugins: [{ export: 'panel', id: 'web:legacy/panel' }] },
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
  writeLock(profileDir, lock)

  const inventory = readInventory(lock, { dataDir: root, profileDir, ceiling: [] })
  expect(inventory.packages[0]?.blockers).toEqual([
    { code: 'incompatible', references: ['reserved-row-id:web:'] },
  ])
  expect(inventory.packages[0]?.verifiedRollbackTarget).toBeNull()
})
