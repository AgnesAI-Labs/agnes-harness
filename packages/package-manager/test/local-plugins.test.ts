import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { localPluginRoots } from '../src/local-source.js'
import { localWorkspaceTrustHash } from '../src/local-workspace-trust.js'
import { emptyLock, readLock, withLock, writeLock } from '../src/lockfile.js'
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
    ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((key) => [
      key,
      { provider: 'local' },
    ]),
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
  expect(f.localPlugins.workspace).toBe(join(f.root, 'workspace', '.agh', 'plugins'))
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
      agnes: { plugins: [{ apiRange: '^5.0.0', export: 'main', id: 'ext:package-tool/main' }] },
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
    const plugin = join(f.localPlugins.home, 'hello')
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

it('never discovers the private authoring area even when configured as a local root', async () => {
  const f = setup(),
    root = join(f.profileDir, '.authoring-candidates', 'candidate-' + 'a'.repeat(32), 'trees', 'revision')
  mkdirSync(join(root, 'ready-tool'), { recursive: true })
  writeFileSync(join(root, 'ready-tool/plugin.ts'), 'export default {apply(){}}\n')
  const { discoverLocalPlugins } = await import('../src/local-source.js')
  expect(discoverLocalPlugins({ home: root, workspace: root })).toEqual([])
})

it('does not trust or enable discovered repository plugins before explicit review', async () => {
  const f = setup()
  const plugin = join(f.localPlugins.workspace, 'unreviewed')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'plugin.js'), "throw new Error('must not evaluate before trust')")
  await f.manager.refreshLocalPlugins(f.profileDir)
  const item = (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'unreviewed')
  expect(item).toMatchObject({ trusted: false, enabled: false })
  await expect(f.manager.setEnabled(f.profileDir, 'unreviewed', true)).rejects.toMatchObject({
    code: 'E_PACKAGE_TRUST',
  })
  const hashBeforeEdit = localWorkspaceTrustHash(
    f.localPlugins,
    readLock(f.profileDir, { profile: 'test', agnesVersion: '0.0.0' }),
  )
  writeFileSync(join(plugin, 'plugin.js'), "throw new Error('changed before confirmation')")
  await expect(
    f.manager.trustWorkspace(f.profileDir, join(f.root, 'workspace'), hashBeforeEdit),
  ).rejects.toMatchObject({ code: 'E_PACKAGE_PREVIEW_STALE' })
  await f.manager.trustWorkspace(
    f.profileDir,
    join(f.root, 'workspace'),
    localWorkspaceTrustHash(
      f.localPlugins,
      readLock(f.profileDir, { profile: 'test', agnesVersion: '0.0.0' }),
    ),
  )
  expect((await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'unreviewed')).toMatchObject(
    { trusted: true, enabled: true, localReloadRequired: true },
  )
  // Another caller's scan (an admin reload) must not consume the trust's reload request.
  await f.manager.refreshLocalPlugins(f.profileDir)
  const reloadPlugin = vi.fn(async (_id: string) => {})
  const watcher = f.manager.watchLocalPlugins(f.profileDir, { reloadPlugin })
  try {
    await watcher.refresh() // Settings → Local plugins → Rescan
  } finally {
    await watcher.close()
  }
  expect(reloadPlugin.mock.calls).toEqual([['unreviewed']])
  expect(
    (await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'unreviewed')
      ?.localReloadRequired,
  ).toBeUndefined()
  writeFileSync(join(plugin, 'plugin.js'), "throw new Error('changed revision also needs trust')")
  await f.manager.refreshLocalPlugins(f.profileDir)
  expect((await f.manager.inventory(f.profileDir)).packages.find((p) => p.id === 'unreviewed')).toMatchObject(
    { trusted: false, enabled: false },
  )
})

it('rejects a rescan that lost the profile lock and retries it once the lock is free', async () => {
  const f = setup()
  const plugin = join(f.localPlugins.home, 'hello')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'plugin.ts'), 'export default { apply() {} }')
  await f.manager.refreshLocalPlugins(f.profileDir)
  const integrity = () =>
    readLock(f.profileDir, { profile: 'test', agnesVersion: '0.0.0' }).packages.hello?.integrity
  const before = integrity()
  writeFileSync(join(plugin, 'plugin.ts'), 'export default { apply() { /* edited */ } }')
  // Create both roots and let fixture FS events drain before any fake-timer debounce exists.
  mkdirSync(f.localPlugins.workspace, { recursive: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const reloadPlugin = vi.fn(async (_id: string) => {})
  const watcher = f.manager.watchLocalPlugins(f.profileDir, { reloadPlugin })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: Date.now() })
    let release!: () => void
    const held = withLock(f.profileDir, () => new Promise<void>((resolve) => (release = resolve))) // an install
    const refreshed = watcher.refresh().catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_200)
    expect(await refreshed).toMatchObject({ detail: { reason: 'busy' } })
    release()
    await held
    // No file event and no second Rescan: the watcher's own bounded retry commits the edit.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(reloadPlugin).toHaveBeenCalledWith('hello'))
    expect(integrity()).not.toBe(before)
  } finally {
    vi.useRealTimers()
    await watcher.close()
  }
})

it('keeps a reload that lost the profile lock pending, and Rescan retries it once the lock is free', async () => {
  const f = setup()
  const plugin = join(f.localPlugins.home, 'hello')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'plugin.ts'), 'export default { apply() {} }')
  mkdirSync(f.localPlugins.workspace, { recursive: true })
  await new Promise((resolve) => setTimeout(resolve, 300))
  let release!: () => void
  let holder: Promise<void> | undefined
  let entered!: () => void
  const reloadEntered = new Promise<void>((resolve) => (entered = resolve))
  // Like the daemon binding, reload reads the inventory first; an install takes the lock in between.
  const reloadPlugin = vi.fn(async (_id: string) => {
    if (reloadPlugin.mock.calls.length === 1) {
      holder = withLock(f.profileDir, () => new Promise<void>((resolve) => (release = resolve)))
      entered()
    }
    await f.manager.inventory(f.profileDir, { fresh: true })
  })
  const row = async () =>
    (await f.manager.inventory(f.profileDir, { fresh: true })).packages.find((p) => p.id === 'hello')
  const watcher = f.manager.watchLocalPlugins(f.profileDir, { reloadPlugin })
  try {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: Date.now() })
    const first = watcher.refresh()
    await reloadEntered
    await vi.advanceTimersByTimeAsync(10_200)
    await first
    release()
    await holder
    vi.useRealTimers()
    // A lost lock race is not the plugin's fault: no sticky failure, still waiting for its reload.
    const busy = await row()
    expect(busy?.localFailure).toBeUndefined()
    expect(busy?.localReloadRequired).toBe(true)
    await watcher.refresh() // Rescan with the source unchanged
    expect(reloadPlugin).toHaveBeenCalledTimes(2)
    const after = await row()
    expect(after?.localFailure).toBeUndefined()
    expect(after?.localReloadRequired).toBeUndefined()
  } finally {
    vi.useRealTimers()
    await watcher.close()
  }
})
