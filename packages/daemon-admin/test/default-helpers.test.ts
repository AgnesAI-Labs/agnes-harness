import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import { loadTemplate } from '@agnes/host'
import { createPackageManager, parseSource, readLock, writeLock } from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientModuleRegistry } from '../src/packages/client-modules.js'
import { activateDefaultHelpers, initializeDefaultHelpers } from '../src/packages/default-helpers.js'
import { createPackageAdminService } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'agh-default-helpers-'))
  roots.push(root)
  const profileDir = join(root, 'profiles', 'local-dev')
  mkdirSync(profileDir, { recursive: true })
  const exec = vi.fn(async () => {
    throw new Error('Network forbidden')
  })
  const manager = createPackageManager({
    dataDir: root,
    cwd: root,
    agnesVersion: '0.0.0',
    exec,
    references: async () => [],
  })
  const initializePolicy = async () => {
    const current = readLock(profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' })
    writeLock(profileDir, {
      ...current,
      resolvedProfileHash: `sha256-${'0'.repeat(64)}`,
      seams: Object.fromEntries(
        ['approval', 'checkpoint', 'billing', 'verifier', 'repair', 'artifacts', 'principals'].map((n) => [
          n,
          { provider: 'local' },
        ]),
      ),
      policySnapshot: {
        capabilityCeiling: loadTemplate('local-dev').policy?.capabilityCeiling ?? [],
        workspacePackages: 'require-project-trust',
      },
    })
  }
  return { root, profileDir, manager, exec, initializePolicy }
}
it('installs release defaults and registers the primary MHS entry offline once and preserves disable/remove on subsequent starts', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.map((p) => [
      p.id,
      p.entry.state.enabled,
      !!p.entry.state.trusted,
    ]),
  ).toEqual([
    ['@agnes/document-reader', true, true],
    ['@agnes/mcp-helper', true, true],
    ['@agnes/mhs', true, true],
    ['@agnes/plugin-helper', true, true],
    ['@agnes/skill-helper', true, true],
  ])
  const admin = createPackageAdminService({
    manager: s.manager,
    profileDirectory: () => s.profileDir,
    operations: new FilePackageOperationStore(join(s.root, 'operations')),
  })
  const listed = (await admin.call(
    '_agnes/v1/packages.list',
    { profile: 'local-dev' },
    {
      audience: 'admin',
      principalId: 'synthetic',
      clientId: 'synthetic',
      permissions: ['packages.read'],
    },
  )) as { packages: { id: string; presentation: { origin: string } }[] }
  expect(listed.packages.find((row) => row.id === '@agnes/mhs')?.presentation.origin).toBe('official')
  let published: RuntimeTargetArtifact | undefined
  const publish = vi.fn(async (target: RuntimeTargetArtifact) => {
    published = target
  })
  await activateDefaultHelpers({
    profileDir: s.profileDir,
    inventory: await s.manager.inventory(s.profileDir),
    previous: undefined,
    publish,
  })
  expect(publish).toHaveBeenCalledOnce()
  if (!published) throw new Error('No default runtime target')
  expect(decodeRuntimeTargetArtifact(published).tree.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'ext:agnes.mhs', disabled: false }),
      expect.objectContaining({ id: 'web:@agnes/mhs', disabled: false }),
    ]),
  )
  const registry = createClientModuleRegistry({
    snapshotDirectory: () => join(s.root, 'client-modules'),
    runtimeArtifacts: () => (published ? { desired: published } : undefined),
  })
  const roster = async () =>
    registry.list({
      profile: 'local-dev',
      profileDirectory: s.profileDir,
      inventory: await s.manager.inventory(s.profileDir),
      actual: async (id) => {
        const pkg = (await s.manager.inventory(s.profileDir)).packages.find((p) => p.id === id)
        return pkg?.enabled ? { actual: 'running', actualIntegrity: pkg.entry.integrity } : undefined
      },
      refreshInventory: () => s.manager.inventory(s.profileDir),
    })
  try {
    expect((await roster()).rows?.find((row) => row.packageId === '@agnes/mhs')).toMatchObject({
      enabled: true,
      phase: 'ready',
      homeEntries: [{ id: 'mhs', placement: 'primary' }],
      binding: { lifetime: 'profile', availability: 'active' },
    })
    await s.manager.setEnabled(s.profileDir, '@agnes/mhs', false)
    published = rebuildDesiredFromInventory({
      previous: published,
      inventory: await s.manager.inventory(s.profileDir),
      packageId: '@agnes/mhs',
      operation: 'disable',
    })
    expect(
      (await roster()).rows?.filter((row) => row.enabled).flatMap((row) => row.homeEntries ?? []),
    ).not.toContainEqual({ id: 'mhs', placement: 'primary' })
  } finally {
    registry.close()
  }
  await s.manager.setEnabled(s.profileDir, '@agnes/mcp-helper', false)
  await s.manager.setEnabled(s.profileDir, '@agnes/skill-helper', false)
  await s.manager.remove(s.profileDir, '@agnes/skill-helper')
  await initializeDefaultHelpers(s)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.map((p) => [p.id, p.entry.state.enabled]),
  ).toEqual([
    ['@agnes/document-reader', true],
    ['@agnes/mcp-helper', false],
    ['@agnes/mhs', false],
    ['@agnes/plugin-helper', true],
  ])
  expect(s.exec).not.toHaveBeenCalled()
})
it('provisions old profiles and rejects damaged initialization records', async () => {
  const s = setup()
  await s.initializePolicy()
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(4)
  writeFileSync(join(s.profileDir, 'default-helpers', 'state.json'), '{}')
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('Invalid helper initialization')
})
it('resumes interrupted first initialization without replacing already installed packages', async () => {
  const s = setup()
  const trust = s.manager.trust.bind(s.manager)
  const spy = vi
    .spyOn(s.manager, 'trust')
    .mockRejectedValueOnce(new Error('interrupted'))
    .mockImplementation(trust)
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(1)
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages.every((p) => p.entry.state.enabled)).toBe(true)
  expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
    'installed',
  )
  spy.mockRestore()
})
it('does not trust an interrupted initialization with changed release hashes', async () => {
  const s = setup()
  const spy = vi.spyOn(s.manager, 'trust').mockRejectedValueOnce(new Error('interrupted'))
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
  spy.mockRestore()
  const file = join(s.profileDir, 'default-helpers', 'state.json')
  const state = JSON.parse(readFileSync(file, 'utf8'))
  state.integrity['@agnes/skill-helper'] = `sha256-${'0'.repeat(64)}`
  writeFileSync(file, JSON.stringify(state))
  await expect(initializeDefaultHelpers(s)).rejects.toThrow('verification failed')
  expect((await s.manager.inventory(s.profileDir)).packages.every((p) => !p.entry.state.trusted)).toBe(true)
})

it('retries target publication after failure and never reactivates completed defaults', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  const publish = vi.fn().mockRejectedValueOnce(new Error('probe failed')).mockResolvedValue(undefined)
  const options = {
    profileDir: s.profileDir,
    inventory: await s.manager.inventory(s.profileDir),
    previous: undefined,
    publish,
  }
  await expect(activateDefaultHelpers(options)).rejects.toThrow('probe failed')
  await initializeDefaultHelpers(s)
  await activateDefaultHelpers(options)
  await activateDefaultHelpers(options)
  expect(publish).toHaveBeenCalledTimes(2)
})

it('migrates the earlier existing marker without enabling or replacing an installed helper', async () => {
  const s = setup()
  await s.initializePolicy()
  const source = parseSource('file:./bundled-plugins/skill-helper')
  const preview = await s.manager.inspect(s.profileDir, source)
  await s.manager.install(s.profileDir, source, { expectedIntegrity: preview.integrity })
  const before = (await s.manager.inventory(s.profileDir)).packages.find(
    (p) => p.id === '@agnes/skill-helper',
  )
  mkdirSync(join(s.profileDir, 'default-helpers'))
  writeFileSync(
    join(s.profileDir, 'default-helpers', 'state.json'),
    JSON.stringify({ version: 1, phase: 'existing', integrity: {} }),
  )
  await initializeDefaultHelpers(s)
  const inventory = await s.manager.inventory(s.profileDir)
  expect(inventory.packages.find((p) => p.id === '@agnes/skill-helper')).toEqual(before)
  expect(inventory.packages.find((p) => p.id === '@agnes/mcp-helper')?.entry.state).toMatchObject({
    enabled: true,
  })
  const publish = vi.fn(async () => {})
  await activateDefaultHelpers({ profileDir: s.profileDir, inventory, previous: undefined, publish })
  expect(publish).toHaveBeenCalledOnce()
  await s.manager.setEnabled(s.profileDir, '@agnes/mcp-helper', false)
  await s.manager.remove(s.profileDir, '@agnes/mcp-helper')
  await initializeDefaultHelpers(s)
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(3)
})
it('records completion without activation when all helpers are already installed', async () => {
  const s = setup()
  await s.initializePolicy()
  for (const name of ['skill-helper', 'mcp-helper', 'plugin-helper', 'document-reader']) {
    const source = parseSource(`file:./bundled-plugins/${name}`)
    const preview = await s.manager.inspect(s.profileDir, source)
    await s.manager.install(s.profileDir, source, { expectedIntegrity: preview.integrity })
  }
  const before = await s.manager.inventory(s.profileDir)
  await initializeDefaultHelpers(s)
  expect(await s.manager.inventory(s.profileDir)).toEqual(before)
  const publish = vi.fn(async () => {})
  await activateDefaultHelpers({ profileDir: s.profileDir, inventory: before, previous: undefined, publish })
  expect(publish).not.toHaveBeenCalled()
  await initializeDefaultHelpers(s)
  expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
    'complete',
  )
})

it.each([1, 2, 3])(
  'migrates a completed v%s profile by adding new helpers, preserving prior removals',
  async (version) => {
    const s = setup()
    await s.initializePolicy()
    mkdirSync(join(s.profileDir, 'default-helpers'))
    writeFileSync(
      join(s.profileDir, 'default-helpers', 'state.json'),
      JSON.stringify({ version, phase: 'complete', integrity: {} }),
    )
    await initializeDefaultHelpers(s)
    expect((await s.manager.inventory(s.profileDir)).packages.map((p) => p.id)).toEqual(
      version === 1
        ? ['@agnes/document-reader', '@agnes/plugin-helper']
        : version === 2
          ? ['@agnes/document-reader']
          : [],
    )
    await activateDefaultHelpers({
      profileDir: s.profileDir,
      inventory: await s.manager.inventory(s.profileDir),
      previous: undefined,
      publish: async () => {},
    })
    expect(
      JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).version,
    ).toBe(3)
    for (const pkg of (await s.manager.inventory(s.profileDir)).packages) {
      await s.manager.setEnabled(s.profileDir, pkg.id, false)
      await s.manager.remove(s.profileDir, pkg.id)
    }
    await initializeDefaultHelpers(s)
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(0)
  },
)
