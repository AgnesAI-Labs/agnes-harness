import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { rebuildDesiredFromInventory } from '@agnes/daemon-foundation/composite-desired'
import { loadTemplate } from '@agnes/host'
import {
  BUNDLED_PLUGIN_DIGESTS,
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
import * as sources from '../../package-manager/src/sources.js'
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
const staleRange = vi.hoisted(() => ({ on: false }))
vi.mock('@agnes/extension-api', async (original) => {
  const module = await original<typeof import('@agnes/extension-api')>()
  return {
    ...module,
    // Stands in for a Host release whose API no longer admits what an older install declared.
    satisfiesApiRange: (range: string, ...rest: [string?]) =>
      !(staleRange.on && range === '^5.0.0') && module.satisfiesApiRange(range, ...rest),
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
            apiRange: '^5.0.0',
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
    ['@agnes/browser', true, true],
    ['@agnes/conversation-ui', true, true],
    ['@agnes/deliverables-ui', true, true],
    ['@agnes/document-reader', true, true],
    ['@agnes/goal-ui', true, true],
    ['@agnes/interaction-ui', true, true],
    ['@agnes/mcp-helper', true, true],
    ['@agnes/navigation-ui', true, true],
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
    ['@agnes/browser', true],
    ['@agnes/conversation-ui', true],
    ['@agnes/deliverables-ui', true],
    ['@agnes/document-reader', true],
    ['@agnes/goal-ui', true],
    ['@agnes/interaction-ui', true],
    ['@agnes/mcp-helper', false],
    ['@agnes/navigation-ui', true],
    ['@agnes/plugin-helper', true],
    ['@agnes/test-console', false],
  ])
  expect(s.exec).not.toHaveBeenCalled()
})
it.each([
  [false, undefined],
  [true, undefined],
  [true, '@agnes/deliverables-ui'],
  [true, '@agnes/goal-ui'],
  [true, '@agnes/interaction-ui'],
] as const)(
  'provisions profiles under their ceiling and rejects damaged records (restricted=%s, other blocker=%s)',
  async (restricted, otherBlocker) => {
    const s = setup(restricted)
    if (!restricted) await s.initializePolicy()
    if (otherBlocker) {
      const inspect = s.manager.inspect.bind(s.manager)
      vi.spyOn(s.manager, 'inspect').mockImplementation(async (...args) => {
        const preview = await inspect(...args)
        return preview.id === otherBlocker
          ? {
              ...preview,
              blockers: [
                ...preview.blockers,
                { code: 'policy', message: 'Other refusal', references: ['other-policy'] },
              ],
            }
          : preview
      })
      await expect(initializeDefaultHelpers(s)).rejects.toThrow('verification failed')
      expect((await s.manager.inventory(s.profileDir)).packages.some((p) => p.id === otherBlocker)).toBe(
        false,
      )
      expect(
        JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase,
      ).toBe('pending')
      return
    }
    await initializeDefaultHelpers(s)
    const packages = (await s.manager.inventory(s.profileDir)).packages
    expect(packages).toHaveLength(restricted ? 4 : 10)
    for (const id of [
      '@agnes/browser',
      '@agnes/conversation-ui',
      '@agnes/deliverables-ui',
      '@agnes/goal-ui',
      '@agnes/interaction-ui',
      '@agnes/navigation-ui',
    ])
      expect(
        packages.some((pkg) => pkg.id === id),
        id,
      ).toBe(!restricted)
    const file = join(s.profileDir, 'default-helpers', 'state.json')
    await activateDefaultHelpers({
      ...s,
      inventory: await s.manager.inventory(s.profileDir),
      previous: undefined,
      publish: async () => {},
    })
    const receipt = JSON.parse(readFileSync(file, 'utf8'))
    expect(receipt).toMatchObject({ version: 4, phase: 'complete' })
    for (const id of [
      '@agnes/conversation-ui',
      '@agnes/deliverables-ui',
      '@agnes/goal-ui',
      '@agnes/interaction-ui',
      '@agnes/navigation-ui',
    ])
      expect(receipt.offered).toContain(id)
    // Even a subsequently wider ceiling does not silently reverse an omitted offer.
    const lock = readLock(s.profileDir, { profile: 'local-dev', agnesVersion: '0.0.0' })
    writeLock(s.profileDir, {
      ...lock,
      policySnapshot: {
        ...lock.policySnapshot,
        capabilityCeiling: loadTemplate('local-dev').policy?.capabilityCeiling ?? [],
        workspacePackages: 'require-project-trust',
      },
    })
    vi.spyOn(s.manager, 'inspect').mockRejectedValue(new Error('Previously offered defaults retried'))
    await initializeDefaultHelpers({ ...s, initializePolicy: async () => {} })
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(packages.length)
    for (const invalid of [
      {},
      { ...receipt, unexpected: true },
      { ...receipt, offered: {} },
      { ...receipt, phase: ['complete'] },
      { version: 4, phase: 'complete', integrity: {} },
      { ...receipt, offered: ['@agnes/not-a-default'] },
      { ...receipt, offered: [...receipt.offered, receipt.offered[0]] },
      { ...receipt, offered: [] },
    ]) {
      writeFileSync(file, JSON.stringify(invalid))
      await expect(initializeDefaultHelpers(s)).rejects.toThrow('Invalid helper')
    }
  },
)
it.each([
  { backfill: false, step: 'policy' },
  { backfill: false, step: 'trust' },
  { backfill: true, step: 'policy' },
  { backfill: true, step: 'trust' },
])(
  'resumes interrupted provisioning without replacing installed packages (backfill=$backfill, step=$step)',
  async ({ backfill, step }) => {
    const s = setup()
    if (backfill) {
      await s.initializePolicy()
      mkdirSync(join(s.profileDir, 'default-helpers'))
      writeFileSync(
        join(s.profileDir, 'default-helpers', 'state.json'),
        JSON.stringify({
          version: 3,
          phase: 'complete',
          integrity: {},
        }),
      )
    }
    const trust = s.manager.trust.bind(s.manager)
    const initializePolicy = s.initializePolicy
    const spy =
      step === 'trust'
        ? vi
            .spyOn(s.manager, 'trust')
            .mockRejectedValueOnce(new Error('interrupted'))
            .mockImplementation(trust)
        : vi
            .spyOn(s, 'initializePolicy')
            .mockRejectedValueOnce(new Error('interrupted'))
            .mockImplementation(initializePolicy)
    await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
    const pending = JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8'))
    expect(pending).toMatchObject({ version: 4, phase: 'pending' })
    expect(pending.offered).toContain('@agnes/goal-ui')
    expect(pending.integrity['@agnes/goal-ui']).toMatch(/^sha256-/)
    expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(step === 'trust' ? 1 : 0)
    await initializeDefaultHelpers(s)
    expect((await s.manager.inventory(s.profileDir)).packages.every((p) => p.entry.state.enabled)).toBe(true)
    expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
      'installed',
    )
    spy.mockRestore()
    await activateDefaultHelpers({
      ...s,
      inventory: await s.manager.inventory(s.profileDir),
      previous: undefined,
      publish: async () => {},
    })
    expect(JSON.parse(readFileSync(join(s.profileDir, 'default-helpers', 'state.json'), 'utf8')).phase).toBe(
      'complete',
    )
  },
)
it.each(['integrity', 'source'])(
  'refuses an interrupted initialization with changed %s',
  async (mismatch) => {
    const s = setup()
    const spy = vi.spyOn(s.manager, 'trust').mockRejectedValueOnce(new Error('interrupted'))
    await expect(initializeDefaultHelpers(s)).rejects.toThrow('interrupted')
    spy.mockRestore()
    const file = join(s.profileDir, 'default-helpers', 'state.json')
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (mismatch === 'integrity') {
      state.integrity['@agnes/skill-helper'] = `sha256-${'0'.repeat(64)}`
      writeFileSync(file, JSON.stringify(state))
    } else {
      const source = bundledPluginSource('file:./bundled-plugins/skill-helper')
      if (!source) throw new Error('Missing helper source')
      const foreign = join(s.root, 'foreign-helper')
      cpSync(join(source.root, source.path), foreign, { recursive: true })
      await s.manager.update(
        s.profileDir,
        '@agnes/skill-helper',
        parseSource(`file:${foreign.split(sep).join('/')}`),
        {
          expectedIntegrity: state.integrity['@agnes/skill-helper'],
        },
      )
    }
    await expect(initializeDefaultHelpers(s)).rejects.toThrow(
      mismatch === 'integrity' ? 'verification failed' : 'differs from initialization intent',
    )
    expect((await s.manager.inventory(s.profileDir)).packages.every((p) => !p.entry.state.trusted)).toBe(true)
  },
)

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
  expect((await s.manager.inventory(s.profileDir)).packages).toHaveLength(9)
})
it('records completion without activation when all helpers are already installed', async () => {
  const s = setup()
  await s.initializePolicy()
  for (const name of [
    'browser',
    'skill-helper',
    'mcp-helper',
    'plugin-helper',
    'navigation-ui',
    'conversation-ui',
    'goal-ui',
    'interaction-ui',
    'deliverables-ui',
    'document-reader',
  ]) {
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

it.each([1, 2, 3, 4])(
  'backfills never-offered defaults in a completed v%s receipt and preserves prior choices',
  async (version) => {
    const s = setup()
    await s.initializePolicy()
    const integrity: Record<string, string> = {}
    for (const name of ['skill-helper', 'mcp-helper', 'plugin-helper', 'document-reader']) {
      const source = parseSource(`file:./bundled-plugins/${name}`)
      const preview = await s.manager.inspect(s.profileDir, source)
      await s.manager.install(s.profileDir, source, { expectedIntegrity: preview.integrity })
      if (!preview.capabilityHash) throw new Error('Missing default capability hash')
      await s.manager.trust(s.profileDir, preview.id, {
        integrity: preview.integrity,
        capabilityHash: preview.capabilityHash,
      })
      await s.manager.setEnabled(s.profileDir, preview.id, true)
      // Installed defaults also count as offered even when absent from the legacy integrity map.
      if (name !== 'document-reader') integrity[preview.id] = preview.integrity
    }
    if (version !== 3) {
      await s.manager.setEnabled(s.profileDir, '@agnes/skill-helper', false)
      await s.manager.setEnabled(s.profileDir, '@agnes/mcp-helper', false)
      await s.manager.remove(s.profileDir, '@agnes/mcp-helper')
    }
    const before = await s.manager.inventory(s.profileDir)
    let target: RuntimeTargetArtifact | undefined
    for (const pkg of before.packages.filter((pkg) => pkg.enabled))
      target = rebuildDesiredFromInventory({
        previous: target,
        inventory: before,
        packageId: pkg.id,
        operation: 'enable',
      })
    mkdirSync(join(s.profileDir, 'default-helpers'))
    const file = join(s.profileDir, 'default-helpers', 'state.json')
    writeFileSync(
      file,
      JSON.stringify({
        version,
        phase: 'complete',
        integrity,
        ...(version === 4 ? { offered: [...Object.keys(integrity)] } : {}),
      }),
    )
    await initializeDefaultHelpers(s)
    const inventory = await s.manager.inventory(s.profileDir)
    expect(inventory.packages).toHaveLength(version === 3 ? 10 : 9)
    expect(inventory.packages.every((pkg) => pkg.trusted)).toBe(true)
    expect(inventory.packages.filter((pkg) => !pkg.enabled).map((pkg) => pkg.id)).toEqual(
      version === 3 ? [] : ['@agnes/skill-helper'],
    )
    expect(inventory.packages.some((pkg) => pkg.id === '@agnes/mcp-helper')).toBe(version === 3)
    for (const pkg of before.packages)
      expect(inventory.packages.find((current) => current.id === pkg.id)).toEqual(pkg)
    await activateDefaultHelpers({
      profileDir: s.profileDir,
      inventory,
      previous: target,
      publish: async (next) => {
        target = next
      },
    })
    for (const name of ['goal-ui', 'interaction-ui', 'deliverables-ui', 'navigation-ui', 'conversation-ui']) {
      const pkg = inventory.packages.find((pkg) => pkg.id === `@agnes/${name}`)
      if (!pkg || !target) throw new Error('Missing presentation or target')
      expect(pkg.entry.trustDecision).toMatchObject({
        integrity: pkg.entry.integrity,
        capabilityHash: pkg.capabilityHash,
      })
      expect(decodeRuntimeTargetArtifact(target).tree.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `web:${pkg.id}`,
            entryRevision: installedRuntimeSnapshotId(pkg),
            disabled: false,
          }),
        ]),
      )
    }
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      version: 4,
      phase: 'complete',
      offered: expect.arrayContaining(inventory.packages.map((pkg) => pkg.id)),
    })
    expect(JSON.parse(readFileSync(file, 'utf8')).offered).toHaveLength(10)
    await s.manager.setEnabled(s.profileDir, '@agnes/goal-ui', false)
    await s.manager.remove(s.profileDir, '@agnes/goal-ui')
    await s.manager.setEnabled(s.profileDir, '@agnes/interaction-ui', false)
    await initializeDefaultHelpers(s)
    await refreshDefaultHelpers({
      ...s,
      previous: () => target,
      publish: async (next) => {
        target = next
      },
    })
    const after = (await s.manager.inventory(s.profileDir)).packages
    expect(after.find((pkg) => pkg.id === '@agnes/goal-ui')).toBeUndefined()
    expect(after.find((pkg) => pkg.id === '@agnes/interaction-ui')?.enabled).toBe(false)
  },
)

it('refreshes an identical bundled source after a checkout move and preserves pins and prior provenance', async () => {
  const s = setup()
  await initializeDefaultHelpers(s)
  const helper = DEFAULT_ENABLED_BUNDLED_PACKAGES[0]!
  const before = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)!
  const pin = await s.manager.pinRuntimeSnapshot(s.profileDir, {
    pinId: 'source-move-session',
    operationId: 'source-move-session',
    purpose: 'turn',
    packageId: helper.id,
    selector: {
      kind: 'installed',
      expectedIntegrity: before.entry.integrity,
      expectedTreeIntegrity: before.entry.treeIntegrity!,
    },
  })
  const pins = await s.manager.runtimePinRecords(s.profileDir)
  const bundled = bundledPluginSource(helper.ref)!
  const payload = join(s.root, 'checkout-b', helper.name)
  cpSync(join(bundled.root, bundled.path), payload, {
    recursive: true,
    filter: (path) => !path.split(sep).includes('node_modules'),
  })
  payloads.set(helper.ref, { root: s.root, path: `checkout-b/${helper.name}` })
  let target: RuntimeTargetArtifact | undefined
  const options = {
    ...s,
    previous: () => target,
    publish: async (next: RuntimeTargetArtifact) => {
      target = next
    },
  }
  await refreshDefaultHelpers(options)
  const after = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)!
  expect(after).toMatchObject({
    enabled: true,
    trusted: true,
    capabilityHash: before.capabilityHash,
    entry: {
      source: before.entry.source,
      integrity: before.entry.integrity,
      version: before.entry.version,
      provenance: { resolvedLocation: realpathSync(payload) },
      previous: before.entry.previous,
    },
  })
  expect(await s.manager.runtimePinRecords(s.profileDir)).toEqual(pins)
  expect(
    (
      await s.manager.resolveRuntimePin(s.profileDir, {
        pinId: pin.pinId,
        expectedSnapshotId: pin.snapshot.snapshotId,
      })
    ).snapshot,
  ).toEqual(pin.snapshot)
  await refreshDefaultHelpers(options)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)?.entry,
  ).toEqual(after.entry)
})

it.each(DEFAULT_ENABLED_BUNDLED_PACKAGES)(
  'refreshes $id across distribution upgrades with unchanged grants and durable target retry',
  async (helper) => {
    const s = setup()
    const source = bundledPluginSource(helper.ref)!
    const payload = join(s.root, 'release', helper.name)
    // Release fixtures contain runtime files, matching the package copier's node_modules exclusion.
    cpSync(join(source.root, source.path), payload, {
      recursive: true,
      filter: (path) => !path.split(sep).includes('node_modules'),
    })
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
            exampleOf: helper.id,
            pageEntry: 'reports',
          },
          clientDescriptors: [{ rowId: 'ext:fixture.report', path: './agnes.client.json' }],
          plugins: [
            {
              id: 'ext:fixture.report',
              export: 'reportPlugin',
              capabilities: { ui: true },
              apiRange: '^5.0.0',
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
    const childSource = parseSource(`file:${child.split(sep).join('/')}`)
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
  // This verifies several real install/update cycles, including retained snapshots and rollback.
  120_000,
)

it.each(['update', 'probe'])(
  'publishes a complete release after an interrupted %s without intermediate targets',
  async (failure) => {
    const s = setup()
    await s.initializePolicy()
    const helpers = DEFAULT_ENABLED_BUNDLED_PACKAGES.filter((helper) =>
      ['@agnes/goal-ui', '@agnes/interaction-ui'].includes(helper.id),
    )
    let target: RuntimeTargetArtifact | undefined
    for (const helper of helpers) {
      const source = bundledPluginSource(helper.ref)!
      const payload = join(s.root, 'release', helper.name)
      cpSync(join(source.root, source.path), payload, {
        recursive: true,
        filter: (path) => !path.split(sep).includes('node_modules'),
      })
      payloads.set(helper.ref, { root: s.root, path: `release/${helper.name}` })
      const preview = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
      await s.manager.install(s.profileDir, parseSource(helper.ref), { expectedIntegrity: preview.integrity })
      await s.manager.trust(s.profileDir, helper.id, {
        integrity: preview.integrity,
        capabilityHash: preview.capabilityHash!,
      })
      await s.manager.setEnabled(s.profileDir, helper.id, true)
      target = rebuildDesiredFromInventory({
        previous: target,
        inventory: await s.manager.inventory(s.profileDir),
        packageId: helper.id,
        operation: 'enable',
      })
      writeFileSync(join(payload, 'release-revision.txt'), 'new release bytes')
    }
    const before = target
    const expected = new Map<string, string>()
    for (const helper of helpers)
      expected.set(helper.id, (await s.manager.inspect(s.profileDir, parseSource(helper.ref))).integrity)
    const published: RuntimeTargetArtifact[] = []
    const publish = async (next: RuntimeTargetArtifact) => {
      const inventory = await s.manager.inventory(s.profileDir)
      for (const helper of helpers) {
        const pkg = inventory.packages.find((pkg) => pkg.id === helper.id)!
        expect(pkg.entry.integrity).toBe(expected.get(helper.id))
        expect(decodeRuntimeTargetArtifact(next).tree.rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              plugin: expect.stringContaining(`${helper.id}@`),
              entryRevision: installedRuntimeSnapshotId(pkg),
              disabled: false,
            }),
          ]),
        )
      }
      published.push(next)
      target = next
    }
    const options = { ...s, previous: () => target, publish }
    const update = s.manager.update.bind(s.manager)
    const spy = vi.spyOn(s.manager, 'update').mockImplementation(async (...args) => {
      if (failure === 'update' && args[1] === helpers[1]!.id) throw new Error('interrupted update')
      return update(...args)
    })
    await expect(
      refreshDefaultHelpers({
        ...options,
        publish:
          failure === 'probe'
            ? async (next) => {
                await publish(next)
                target = before
                throw new Error('interrupted probe')
              }
            : publish,
      }),
    ).rejects.toThrow(`interrupted ${failure}`)
    expect(target).toBe(before)
    spy.mockRestore()
    published.length = 0
    const reads = vi.spyOn(s.manager, 'inventory')
    await refreshDefaultHelpers(options)
    expect(published).toEqual([target])
    // Only a committed update re-reads fresh: the probe retry republishes without one.
    expect(reads.mock.calls.filter(([, opts]) => opts?.fresh).length).toBe(failure === 'update' ? 1 : 0)
    reads.mockClear()
    await refreshDefaultHelpers(options)
    expect(published).toEqual([target])
    expect(reads.mock.calls).toEqual([[s.profileDir]])
  },
  120_000,
)

it('compares installed defaults with the build-time digest manifest and falls back to hashing the source', async () => {
  const s = setup()
  await s.initializePolicy()
  const helper = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.id === '@agnes/goal-ui')!
  const source = bundledPluginSource(helper.ref)!
  const release = join(s.root, 'release', helper.name)
  cpSync(join(source.root, source.path), release, {
    recursive: true,
    filter: (path) => !path.split(sep).includes('node_modules'),
  })
  payloads.set(helper.ref, { root: s.root, path: `release/${helper.name}` })
  const preview = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
  await s.manager.install(s.profileDir, parseSource(helper.ref), { expectedIntegrity: preview.integrity })
  await s.manager.trust(s.profileDir, helper.id, {
    integrity: preview.integrity,
    capabilityHash: preview.capabilityHash!,
  })
  await s.manager.setEnabled(s.profileDir, helper.id, true)
  let target = rebuildDesiredFromInventory({
    previous: undefined,
    inventory: await s.manager.inventory(s.profileDir),
    packageId: helper.id,
    operation: 'enable',
  })
  const options = {
    ...s,
    previous: () => target,
    publish: async (next: RuntimeTargetArtifact) => {
      target = next
    },
  }
  const manifest = join(s.root, BUNDLED_PLUGIN_DIGESTS)
  const hash = vi.spyOn(sources, 'hashDirectory')
  const update = vi.spyOn(s.manager, 'update')
  const sourceHashes = () => hash.mock.calls.filter(([dir]) => dir === release).length
  writeFileSync(manifest, JSON.stringify({ [`release/${helper.name}`]: preview.integrity }))
  await refreshDefaultHelpers(options)
  expect(sourceHashes()).toBe(0)
  // A missing, partial or malformed manifest falls back to hashing the shipped source.
  for (const content of ['{}', '{ damaged', JSON.stringify({ [`release/${helper.name}`]: 'sha256-short' })]) {
    writeFileSync(manifest, content)
    await refreshDefaultHelpers(options)
  }
  rmSync(manifest)
  await refreshDefaultHelpers(options)
  expect(sourceHashes()).toBe(4)
  expect(update).not.toHaveBeenCalled()
  // A changed release still goes through inspect and the fully verified update path.
  writeFileSync(join(release, 'release-revision.txt'), 'new release bytes')
  const next = sources.hashDirectory(release)
  writeFileSync(manifest, JSON.stringify({ [`release/${helper.name}`]: next }))
  await refreshDefaultHelpers(options)
  expect(update).toHaveBeenCalledTimes(1)
  expect(
    (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === helper.id)?.entry.integrity,
  ).toBe(next)
}, 120_000)

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
  const helper = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.id === '@agnes/skill-helper')!
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
  const other = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.id === '@agnes/mcp-helper')!
  const otherBefore = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === other.id)!
  await s.manager.untrust(s.profileDir, other.id, {
    integrity: otherBefore.entry.integrity,
    capabilityHash: otherBefore.capabilityHash,
  })
  const revoked = (await s.manager.inventory(s.profileDir)).packages.find((pkg) => pkg.id === other.id)
  const pinnedSource = parseSource(`file:${payload.split(sep).join('/')}`)
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
}, 120_000)
it('refreshes an installed default whose apiRange the Host no longer admits', async () => {
  const s = setup()
  await s.initializePolicy()
  const helper = DEFAULT_ENABLED_BUNDLED_PACKAGES.find((pkg) => pkg.id === '@agnes/goal-ui')!
  const source = bundledPluginSource(helper.ref)!
  const release = join(s.root, 'release', helper.name)
  cpSync(join(source.root, source.path), release, {
    recursive: true,
    filter: (path) => !path.split(sep).includes('node_modules'),
  })
  payloads.set(helper.ref, { root: s.root, path: `release/${helper.name}` })
  const file = join(release, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  manifest.agnes.plugins[0].apiRange = '^5.0.0'
  writeFileSync(file, JSON.stringify(manifest))
  const old = await s.manager.inspect(s.profileDir, parseSource(helper.ref))
  await s.manager.install(s.profileDir, parseSource(helper.ref), { expectedIntegrity: old.integrity })
  await s.manager.trust(s.profileDir, helper.id, {
    integrity: old.integrity,
    capabilityHash: old.capabilityHash!,
  })
  await s.manager.setEnabled(s.profileDir, helper.id, true)
  staleRange.on = true
  try {
    const stale = (await s.manager.inventory(s.profileDir, { fresh: true })).packages.find(
      (pkg) => pkg.id === helper.id,
    )!
    expect(stale.blockers.map((blocker) => blocker.references[0])).toEqual(['plugin-api-range-incompatible'])
    manifest.agnes.plugins[0].apiRange = '>=5.0.0'
    writeFileSync(file, JSON.stringify(manifest))
    let target: RuntimeTargetArtifact | undefined
    await refreshDefaultHelpers({
      ...s,
      previous: () => target,
      publish: async (next) => {
        target = next
      },
    })
    expect(
      (await s.manager.inventory(s.profileDir, { fresh: true })).packages.find((pkg) => pkg.id === helper.id),
    ).toMatchObject({ blockers: [], enabled: true, trusted: true })
  } finally {
    staleRange.on = false
  }
}, 120_000)
