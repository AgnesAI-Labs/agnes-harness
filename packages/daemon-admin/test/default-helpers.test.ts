import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import { loadTemplate } from '@agnes/host'
import {
  bundledPluginSource,
  createPackageManager,
  DEFAULT_ENABLED_BUNDLED_PACKAGES,
  installedRuntimeSnapshotId,
  parseSource,
  readLock,
  writeLock,
} from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact, type RuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import { afterEach, expect, it, vi } from 'vitest'
import { createClientModuleRegistry } from '../src/packages/client-modules.js'
import {
  activateDefaultHelpers,
  initializeDefaultHelpers,
  refreshDefaultHelpers,
} from '../src/packages/default-helpers.js'
import { createPackageAdminService } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'

const payloads = vi.hoisted(() => new Map<string, { root: string; path: string }>())
vi.mock('../../package-manager/src/bundled-plugin-source.js', async (original) => {
  const module = await original<typeof import('../../package-manager/src/bundled-plugin-source.js')>()
  return {
    ...module,
    DEFAULT_ENABLED_BUNDLED_PACKAGES: [
      ...module.DEFAULT_ENABLED_BUNDLED_PACKAGES,
      {
        name: 'test-console',
        id: '@agnes/test-console',
        version: '0.1.0-alpha.0',
        license: 'Apache-2.0',
        ref: 'file:./bundled-plugins/test-console',
        sourcePath: 'test-console',
        freshOnly: true,
      },
    ],
    bundledPluginSource: (ref: string) => payloads.get(ref) ?? module.bundledPluginSource(ref),
  }
})
const roots: string[] = []
afterEach(() => {
  payloads.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup(restrictCeiling = false) {
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
  // A synthetic fresh-only release default exercises profile navigation without a product plugin.
  const payload = join(root, 'console-payload')
  mkdirSync(join(payload, 'client'), { recursive: true })
  writeFileSync(
    join(payload, 'package.json'),
    JSON.stringify({
      name: '@agnes/test-console',
      version: '0.1.0-alpha.0',
      type: 'module',
      license: 'Apache-2.0',
      exports: { '.': './index.mjs' },
      agnes: {
        plugins: [
          {
            id: 'ext:fixture.console',
            export: 'consolePlugin',
            apiRange: '^4.0.0',
            inject: ['services'],
            runtime: 'in-process',
            capabilities: {
              ui: true,
              streams: ['events', 'media'].map((lane) => ({
                name: `reports.${lane}`,
                lane,
                scope: 'profile',
                inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                directions: ['outbound'],
                maxFrameBytes: 4096,
                maxBufferedBytes: 8192,
                maxBytesPerSecond: 16384,
              })),
            },
          },
        ],
        clientDescriptors: [{ rowId: 'ext:fixture.console', path: './agnes.client.json' }],
      },
    }),
  )
  writeFileSync(join(payload, 'index.mjs'), 'export const consolePlugin = { apply() {} }')
  writeFileSync(join(payload, 'client/index.js'), 'export {}')
  writeFileSync(
    join(payload, 'agnes.client.json'),
    JSON.stringify({
      client: {
        entry: './client/index.js',
        lifetime: 'profile',
        services: [],
        streams: ['reports.events', 'reports.media'],
        slots: [],
        slotCatalogVersion: 'dsh-client-slots/v1',
        homeEntries: [
          {
            id: 'console',
            placement: 'primary',
            navigation: { title: 'Reports', icon: 'file-text', order: 40 },
          },
        ],
      },
    }),
  )
  payloads.set('file:./bundled-plugins/test-console', { root, path: 'console-payload' })
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
        capabilityCeiling: (loadTemplate('local-dev').policy?.capabilityCeiling ?? []).filter(
          (category) => !restrictCeiling || category === 'tools',
        ),
        workspacePackages: 'require-project-trust',
      },
    })
  }
  return { root, profileDir, manager, exec, initializePolicy }
}
it('installs release defaults and registers a synthetic primary entry offline once and preserves disable/remove on subsequent starts', async () => {
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
    ['@agnes/plugin-helper', true, true],
    ['@agnes/skill-helper', true, true],
    ['@agnes/test-console', true, true],
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
  expect(listed.packages.find((row) => row.id === '@agnes/test-console')?.presentation.origin).toBe(
    'official',
  )
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
      expect.objectContaining({ id: 'ext:fixture.console', disabled: false }),
      expect.objectContaining({ id: 'web:@agnes/test-console', disabled: false }),
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
    expect((await roster()).rows?.find((row) => row.packageId === '@agnes/test-console')).toMatchObject({
      enabled: true,
      phase: 'ready',
      homeEntries: [
        {
          id: 'console',
          placement: 'primary',
          navigation: { title: 'Reports', icon: 'file-text', order: 40 },
        },
      ],
      streams: ['reports.events', 'reports.media'],
      binding: { lifetime: 'profile', availability: 'active' },
    })
    await s.manager.setEnabled(s.profileDir, '@agnes/test-console', false)
    published = rebuildDesiredFromInventory({
      previous: published,
      inventory: await s.manager.inventory(s.profileDir),
      packageId: '@agnes/test-console',
      operation: 'disable',
    })
    expect(
      (await roster()).rows?.filter((row) => row.enabled).flatMap((row) => row.homeEntries ?? []),
    ).not.toContainEqual(expect.objectContaining({ id: 'console', placement: 'primary' }))
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
    ['@agnes/plugin-helper', true],
    ['@agnes/test-console', false],
  ])
  expect(s.exec).not.toHaveBeenCalled()
})
it.each([false, true])(
  'provisions profiles under their ceiling and rejects damaged records (restricted fresh=%s)',
  async (restricted) => {
    const s = setup(restricted)
    if (!restricted) await s.initializePolicy()
    await initializeDefaultHelpers(s)
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(4)
    writeFileSync(join(s.profileDir, 'default-helpers', 'state.json'), '{}')
    await expect(initializeDefaultHelpers(s)).rejects.toThrow('Invalid helper initialization')
  },
)
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

it.each(DEFAULT_ENABLED_BUNDLED_PACKAGES)(
  'refreshes $id across distribution upgrades with unchanged grants and durable target retry',
  async (helper) => {
    const s = setup()
    const source = bundledPluginSource(helper.ref)!
    const payload = join(s.root, 'release', helper.name)
    cpSync(join(source.root, source.path), payload, { recursive: true })
    payloads.set(helper.ref, { root: s.root, path: `release/${helper.name}` })
    const file = join(payload, 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    const oldVersion = helper.freshOnly ? '0.1.0-alpha.0' : '0.1.0'
    const nextVersion = helper.freshOnly ? oldVersion : '0.2.0'
    const parentRange = helper.freshOnly ? oldVersion : '>=0.1.0 <1.0.0'
    manifest.version = oldVersion
    writeFileSync(file, JSON.stringify(manifest))
    await initializeDefaultHelpers(s)
    let target: RuntimeTargetArtifact | undefined
    const publish = async (next: RuntimeTargetArtifact) => {
      target = next
    }
    await activateDefaultHelpers({
      ...s,
      inventory: await s.manager.inventory(s.profileDir),
      previous: target,
      publish,
    })
    const before = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)!
    const pin = await s.manager.pinRuntimeSnapshot(s.profileDir, {
      pinId: 'retained-bundled-turn',
      operationId: 'retained-bundled-turn',
      purpose: 'turn',
      packageId: helper.id,
      selector: {
        kind: 'installed',
        expectedIntegrity: before.entry.integrity,
        expectedTreeIntegrity: before.entry.treeIntegrity!,
      },
    })
    // The parent-owned example stays runnable across a compatible bundled parent refresh.
    const child = join(s.root, 'report-example')
    mkdirSync(child)
    writeFileSync(
      join(child, 'package.json'),
      JSON.stringify({
        name: '@fixture/report-example',
        version: '1.0.0',
        type: 'module',
        license: 'Apache-2.0',
        exports: { '.': './index.mjs' },
        dependencies: { [helper.id]: parentRange },
        agnes: {
          metadata: {
            displayName: 'Report example',
            summary: 'Synthetic report',
            description: 'Synthetic report',
            category: 'example',
            exampleOf: helper.id,
            pageEntry: 'reports',
          },
          clientDescriptors: [{ rowId: 'ext:fixture.report', path: './agnes.client.json' }],
          plugins: [
            {
              id: 'ext:fixture.report',
              export: 'reportPlugin',
              capabilities: { ui: true },
              apiRange: '^4.0.0',
              inject: ['tools'],
              runtime: 'in-process',
            },
          ],
        },
      }),
    )
    writeFileSync(join(child, 'index.mjs'), 'export const reportPlugin = { apply() {} }')
    writeFileSync(join(child, 'client.js'), 'export {}')
    writeFileSync(
      join(child, 'agnes.client.json'),
      JSON.stringify({
        client: {
          entry: './client.js',
          lifetime: 'profile',
          examplePages: ['reports'],
          services: [],
          slots: [],
          slotCatalogVersion: 'dsh-client-slots/v1',
        },
      }),
    )
    const childSource = parseSource(`file:${child}`)
    const example = await s.manager.inspect(s.profileDir, childSource)
    expect(example.dependencies[helper.id]).toBe(parentRange)
    expect(example.blockers).toEqual([])
    await s.manager.install(s.profileDir, childSource, { expectedIntegrity: example.integrity })
    await s.manager.trust(s.profileDir, example.id, {
      integrity: example.integrity,
      capabilityHash: example.capabilityHash!,
    })
    await s.manager.setEnabled(s.profileDir, example.id, true)
    target = rebuildDesiredFromInventory({
      previous: target,
      inventory: await s.manager.inventory(s.profileDir),
      packageId: example.id,
      operation: 'enable',
    })
    manifest.version = nextVersion
    writeFileSync(join(payload, 'distribution-revision.txt'), 'new release bytes')
    writeFileSync(file, JSON.stringify(manifest))
    const preview = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
    expect(preview.capabilityHash).toBe(before.capabilityHash)
    const options = { ...s, previous: () => target, publish }
    await expect(
      refreshDefaultHelpers({
        ...options,
        publish: async () => {
          throw new Error('probe failed')
        },
      }),
    ).rejects.toThrow('probe failed')
    const after = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)!
    expect(after).toMatchObject({
      trusted: true,
      enabled: true,
      capabilityHash: before.capabilityHash,
      entry: {
        version: nextVersion,
        integrity: preview.integrity,
        previous: { integrity: before.entry.integrity },
      },
    })
    expect(after.entry.trustDecision?.integrity).toBe(preview.integrity)
    const retained = await s.manager.resolveRuntimePin(s.profileDir, {
      pinId: pin.pinId,
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
    expect(retained.snapshot).toMatchObject({ version: oldVersion, integrity: before.entry.integrity })
    expect(JSON.parse(readFileSync(join(retained.snapshot.directory, 'package.json'), 'utf8')).version).toBe(
      oldVersion,
    )

    await refreshDefaultHelpers(options)
    expect(
      decodeRuntimeTargetArtifact(target!).tree.rows.some(
        (row) =>
          row.plugin.startsWith(`${helper.id}@`) &&
          row.entryRevision === installedRuntimeSnapshotId(after) &&
          !row.disabled,
      ),
    ).toBe(true)
    const published = target?.digest
    await refreshDefaultHelpers(options)
    expect(target?.digest).toBe(published)
    // Equal version labels are not an identity check: source builds can change their UI bytes.
    writeFileSync(join(payload, 'release-bytes.txt'), 'new distribution bytes')
    const equalVersionPreview = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
    expect(equalVersionPreview.version).toBe(nextVersion)
    expect(equalVersionPreview.capabilityHash).toBe(after.capabilityHash)
    await refreshDefaultHelpers(options)
    const equalVersion = (await s.manager.inventory(s.profileDir)).packages.find(
      (pkg) => pkg.id === helper.id,
    )!
    expect(equalVersion.entry).toMatchObject({
      version: nextVersion,
      integrity: equalVersionPreview.integrity,
    })
    expect(equalVersion.entry.integrity).not.toBe(after.entry.integrity)
    expect(equalVersion).toMatchObject({
      enabled: true,
      trusted: true,
      capabilityHash: after.capabilityHash,
      entry: { trustDecision: { integrity: equalVersionPreview.integrity } },
    })
    expect(target?.digest).not.toBe(published)
    expect(readFileSync(join(equalVersion.directory!, 'release-bytes.txt'), 'utf8')).toBe(
      'new distribution bytes',
    )
    const childAfter = (await s.manager.inventory(s.profileDir)).packages.find(
      (pkg) => pkg.id === example.id,
    )!
    expect(childAfter).toMatchObject({ enabled: true, trusted: true, blockers: [] })
    expect(
      decodeRuntimeTargetArtifact(target!).tree.rows.some(
        (row) => row.plugin.startsWith(`${example.id}@`) && !row.disabled,
      ),
    ).toBe(true)
    await s.manager.setEnabled(s.profileDir, example.id, false)
    await s.manager.remove(s.profileDir, example.id)
    // A later distribution must preserve the explicit disable and removal decisions.
    await s.manager.setEnabled(s.profileDir, helper.id, false)
    const disabled = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)
    manifest.version = '0.3.0'
    writeFileSync(file, JSON.stringify(manifest))
    await refreshDefaultHelpers(options)
    expect((await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)).toEqual(
      disabled,
    )
    await s.manager.releaseRuntimePin(s.profileDir, {
      pinId: pin.pinId,
      expectedSnapshotId: pin.snapshot.snapshotId,
    })
    await s.manager.remove(s.profileDir, helper.id)
    await initializeDefaultHelpers(s)
    await refreshDefaultHelpers(options)
    expect(
      (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id),
    ).toBeUndefined()
  },
)

it('retains a changed-capability release for explicit review, and preserves a different source and revoked trust', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  let target: RuntimeTargetArtifact | undefined
  const publish = async (next: RuntimeTargetArtifact) => {
    target = next
  }
  await activateDefaultHelpers({
    ...s,
    inventory: await s.manager.inventory(s.profileDir),
    previous: target,
    publish,
  })
  const helper = DEFAULT_ENABLED_BUNDLED_PACKAGES[0]!
  const source = bundledPluginSource(helper.ref)!
  const payload = join(s.root, 'release')
  cpSync(join(source.root, source.path), payload, { recursive: true })
  payloads.set(helper.ref, { root: s.root, path: 'release' })
  const file = join(payload, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.version = '1.0.0'
  manifest.agnes.plugins[0].capabilities = { filesystem: { read: ['./reviewed-data'] } }
  writeFileSync(file, JSON.stringify(manifest))
  const before = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)!
  const preview = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
  expect(preview.blockers).toEqual([])
  expect(preview.capabilityHash).not.toBe(before.capabilityHash)
  await refreshDefaultHelpers({ ...s, previous: () => target, publish })
  expect((await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)).toEqual(
    before,
  )
  // The normal reviewed path accepts this exact candidate, including its changed capability hash.
  await s.manager.update(s.profileDir, helper.id, parseSource(helper.ref), {
    expectedIntegrity: preview.integrity,
    expectedInstalledIntegrity: before.entry.integrity,
    activation: {
      expectedInstalledIntegrity: before.entry.integrity,
      trust: { integrity: preview.integrity, capabilityHash: preview.capabilityHash! },
    },
  })
  expect(
    (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id),
  ).toMatchObject({ trusted: true, enabled: true, capabilityHash: preview.capabilityHash })
  const other = DEFAULT_ENABLED_BUNDLED_PACKAGES[1]!
  const otherBefore = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === other.id)!
  await s.manager.untrust(s.profileDir, other.id, {
    integrity: otherBefore.entry.integrity,
    capabilityHash: otherBefore.capabilityHash,
  })
  const revoked = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === other.id)
  const pinnedSource = parseSource(`file:${payload}`)
  const pinned = await s.manager.update(s.profileDir, helper.id, pinnedSource, {
    expectedIntegrity: preview.integrity,
  })
  await s.manager.trust(s.profileDir, helper.id, {
    integrity: pinned.integrity,
    capabilityHash: preview.capabilityHash!,
  })
  await s.manager.setEnabled(s.profileDir, helper.id, true)
  const custom = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)
  await refreshDefaultHelpers({ ...s, previous: () => target, publish })
  expect((await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)).toEqual(
    custom,
  )
  expect((await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === other.id)).toEqual(
    revoked,
  )
})
