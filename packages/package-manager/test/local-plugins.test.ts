import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { localPluginRoots } from '../src/local-source.js'
import { emptyLock, writeLock } from '../src/lockfile.js'
import { createPackageManager } from '../src/manager.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agnes-local-plugins-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'test')
  mkdirSync(profileDir, { recursive: true })
  const seams = Object.fromEntries(
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
    ].map((key) => [key, '@agnes/base']),
  )
  writeLock(profileDir, {
    ...emptyLock('test', '0.0.0'),
    resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
    seams,
  })
  const localPlugins = localPluginRoots(join(root, 'home'), join(root, 'workspace'))
  const manager = createPackageManager({
    dataDir: join(root, 'data'),
    agnesVersion: '0.0.0',
    localPlugins,
    references: async () => [],
  })
  return { root, profileDir, localPlugins, manager }
}
it('discovers both roots, freezes edits, keeps disabled choices and reports broken source', async () => {
  const f = setup()
  const single = join(f.localPlugins.home, 'hello')
  const pkg = join(f.localPlugins.workspace, 'package-tool')
  mkdirSync(single, { recursive: true })
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(single, 'plugin.ts'), 'export default { apply() {} }')
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: 'package-tool',
      version: '1.0.0',
      exports: './plugin.ts',
      agnes: { plugins: [{ export: 'main', id: 'ext:package-tool/main' }] },
    }),
  )
  writeFileSync(join(pkg, 'plugin.ts'), 'export const main = { apply() {} }')
  expect(await f.manager.refreshLocalPlugins(f.profileDir)).toEqual(['hello', 'package-tool'])
  const first = (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'hello')
  if (!first?.entry.treeIntegrity) throw new Error('Expected installed local snapshot')
  expect(first).toMatchObject({ trusted: true, enabled: true, entry: { source: { type: 'local' } } })
  await f.manager.setEnabled(f.profileDir, 'hello', false)
  const pin = await f.manager.pinRuntimeSnapshot(f.profileDir, {
    pinId: 'session-test',
    operationId: 'local-test',
    purpose: 'recovery',
    packageId: 'hello',
    selector: {
      kind: 'installed',
      expectedIntegrity: first.entry.integrity,
      expectedTreeIntegrity: first.entry.treeIntegrity,
    },
  })
  writeFileSync(join(single, 'plugin.ts'), 'export default { apply() { /* new */ } }')
  expect(await f.manager.refreshLocalPlugins(f.profileDir)).toEqual(['hello'])
  const next = (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'hello')
  if (!next) throw new Error('Expected updated local snapshot')
  expect(next.enabled).toBe(false)
  expect(next.entry.integrity).not.toBe(first.entry.integrity)
  expect(readFileSync(join(pin.snapshot.directory, 'plugin.ts'), 'utf8')).not.toContain('new')
  writeFileSync(join(pkg, 'package.json'), '{bad json')
  await f.manager.refreshLocalPlugins(f.profileDir)
  expect(
    (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'package-tool')?.localFailure,
  ).toContain('Check package.json')
  rmSync(pkg, { recursive: true })
  await f.manager.refreshLocalPlugins(f.profileDir)
  expect(
    (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'package-tool')?.enabled,
  ).toBe(false)
})
it('calls the generation reload port once per changed package and closes watching', async () => {
  const f = setup()
  const reloadPlugin = vi.fn(async () => {})
  f.manager.bindLocalPluginReload({ reloadPlugin })
  const watcher = f.manager.watchLocalPlugins(f.profileDir)
  try {
    const plugin = join(f.localPlugins.workspace, 'hello')
    mkdirSync(plugin)
    writeFileSync(join(plugin, 'plugin.js'), 'export default { apply() {} }')
    await watcher.refresh()
    expect(reloadPlugin.mock.calls).toEqual([['hello']])
    await watcher.refresh()
    expect(reloadPlugin.mock.calls).toHaveLength(1)
    expect((await f.manager.inventory(f.profileDir)).packages[0]?.localReloadRequired).toBeUndefined()
  } finally {
    await watcher.close()
  }
})
