import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  hashDirectory,
  type InstalledInventory,
  type InstalledPackage,
  type PackageManager,
} from '@agnes/package-manager'
import {
  type ClientContribution,
  type PluginUiEntryDeclaration,
  projectClientModuleRows,
  validatePackageAdminCall,
  validatePackageAdminData,
} from '@agnes/protocol'
import { UI_COMPONENT_MODULE_BYTES } from '@agnes/protocol/intelligent-ui'
import { afterEach, expect, it } from 'vitest'
import { admissionDigest } from '../src/packages/client-admission.js'
import { createClientModuleRegistry } from '../src/packages/client-modules.js'
import { createPackageAdminService } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'
import { scopedPackageProfileDirectory } from '../src/packages/project.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(
  clients: ClientContribution[],
  services = false,
  renderer = 'export function render() {}',
) {
  const profile = 'local-dev'
  const root = await mkdtemp(join(tmpdir(), 'agh-admission-'))
  roots.push(root)
  const directory = join(root, 'installed')
  await mkdir(directory)
  for (const [name, source] of Object.entries({
    'entry.js': 'export { shared } from "./shared.js"',
    'style.css': '.page { color: red }',
    'shared.js': 'export const shared = true',
    'other.js': 'export const sibling = true',
    'renderer.js': renderer,
  }))
    await writeFile(join(directory, name), source)
  const id = '@acme/panel'
  const integrity = hashDirectory(directory, { exclude: [] })
  const row: InstalledPackage = {
    id,
    directory,
    entry: {
      source: { type: 'file', ref: 'file:./ordinary' },
      version: '1.0.0',
      integrity,
      treeIntegrity: integrity,
      trust: 'trusted',
      license: 'MIT',
      state: { installed: '2026-11-26T00:00:00.000Z', trusted: '2026-11-26T00:00:00.000Z', enabled: true },
      previous: null,
      dependencies: {},
    },
    capabilityHash: 'a'.repeat(64),
    trusted: true,
    enabled: true,
    blockers: [],
    verifiedRollbackTarget: null,
    contributions: clients.map((client, index) => ({
      kind: 'extension',
      id: `acme/row-${index}`,
      path: './manifest.json',
      apiRange: '*',
      capabilities: services ? { ui: true, tools: { prefix: 'panel_' } } : { ui: true },
      client,
    })),
  }
  const inventory = { profile, hash: 'a', packages: [row] }
  return { root, row, inventory }
}

it('serves only the consented client closure, and accepts renderer source only as its exact data leaf', async () => {
  const approved: ClientContribution = {
    id: 'approved',
    lifetime: 'profile',
    entry: 'entry.js',
    styles: ['style.css'],
    homeEntries: [
      { id: 'home', placement: 'primary' },
      { id: 'unused', placement: 'primary' },
    ],
  }
  const { root, row, inventory } = await fixture([
    approved,
    { id: 'other', entry: 'other.js' },
    {
      id: 'renderer',
      entry: 'renderer.js',
      intelligentComponents: [
        {
          kind: '@acme/panel/diff@1',
          propsSchema: { type: 'object' },
          maxPropsBytes: 256,
          fallback: 'Use the table.',
          accessibility: { label: 'Differences', keyboard: true },
        },
      ],
    },
  ])
  const registry = createClientModuleRegistry({ snapshotDirectory: () => join(root, 'snapshots') })
  let consent = false
  const input = {
    profile: inventory.profile,
    profileDirectory: root,
    inventory,
    actual: async () => undefined,
    refreshInventory: async () => inventory,
    presentation: async () => {
      const saved = consent
      return {
        revision: saved ? 7 : 8,
        grants: saved
          ? [
              {
                rowId: 'web:@acme/panel:approved',
                packageId: row.id,
                clientId: 'approved',
                declarationDigest: admissionDigest(approved),
                consent: 'reviewed consent',
                roles: [],
                pages: ['home'],
              },
            ]
          : [],
        current: async () => consent === saved,
      }
    },
  }
  const asset = (leaf: string, purpose: 'document' | 'isolated-component' = 'document') =>
    registry.read({ ...input, path: `/plugins/${row.id}/${row.entry.integrity}/${leaf}`, purpose })
  try {
    const blocked = await registry.list(input)
    expect(blocked.modules).toEqual([])
    expect(blocked.statuses).toContainEqual(expect.objectContaining({ reason: 'native-ui-not-admitted' }))
    expect(await asset('entry.js')).toEqual({ found: false })
    consent = true
    const admitted = await registry.list(input)
    expect(admitted.modules.map((row) => row.rowId)).toEqual(['web:@acme/panel:approved'])
    const approvedRow = projectClientModuleRows(admitted).rows?.find((item) => item.clientId === 'approved')
    expect(approvedRow).toMatchObject({
      documentAdmission: {
        kind: 'approved-presentation',
        bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        presentationRevision: 7,
      },
      homeEntries: [{ id: 'home', placement: 'primary' }],
    })
    expect(validatePackageAdminData('ClientModuleRosterRow', approvedRow).ok).toBe(true)
    for (const documentAdmission of [
      { kind: 'approved-presentation', bindingDigest: '0'.repeat(64) },
      { kind: 'release', bindingDigest: '0'.repeat(64), presentationRevision: 7 },
    ]) {
      expect(
        validatePackageAdminData('ClientModuleRosterRow', { ...approvedRow, documentAdmission }).ok,
      ).toBe(false)
    }
    for (const leaf of ['entry.js', 'style.css', 'shared.js'])
      expect(await asset(leaf)).toMatchObject({ found: true })
    expect(await asset('other.js')).toEqual({ found: false })
    expect(await asset('renderer.js')).toEqual({ found: false })
    expect(await asset('shared.js', 'isolated-component')).toEqual({ found: false })
    expect(await asset('renderer.js', 'isolated-component')).toEqual({
      found: true,
      base64: Buffer.from('export function render() {}').toString('base64'),
    })
    consent = false
    expect(await asset('entry.js')).toEqual({ found: false })
    expect((await registry.list(input)).modules).toEqual([])
  } finally {
    registry.close()
  }
})

it.each(['export { shared } from "./shared.js"', `// ${'a'.repeat(UI_COMPONENT_MODULE_BYTES)}`])(
  'refuses a non-leaf or oversized isolated renderer (%#)',
  async (source) => {
    const { root, row, inventory } = await fixture(
      [
        {
          entry: 'renderer.js',
          intelligentComponents: [
            {
              kind: '@acme/panel/diff@1',
              propsSchema: { type: 'object' },
              maxPropsBytes: 256,
              fallback: 'Use the table.',
              accessibility: { label: 'Differences', keyboard: true },
            },
          ],
        },
      ],
      false,
      source,
    )
    const registry = createClientModuleRegistry({ snapshotDirectory: () => join(root, 'snapshots') })
    const input = {
      profile: inventory.profile,
      profileDirectory: root,
      inventory,
      actual: async () => undefined,
      refreshInventory: async () => inventory,
    }
    try {
      expect((await registry.list(input)).rows).toEqual([])
      const path = `/plugins/${row.id}/${row.entry.integrity}/renderer.js`
      expect(await registry.read({ ...input, path, purpose: 'isolated-component' })).toEqual({ found: false })
    } finally {
      registry.close()
    }
  },
)

it('keeps the frontend publication owner private and independent of native admission', async () => {
  const { root, row, inventory } = await fixture(
    [{ entry: 'entry.js', services: ['frontend.publish'] }],
    true,
  )
  let current = row
  let generation = 1
  const service = createPackageAdminService({
    manager: {
      inventory: async () => ({ ...inventory, packages: [current] }),
    } as unknown as PackageManager,
    profileDirectory: async () => root,
    operations: new FilePackageOperationStore(join(root, 'operations')),
    clientModules: createClientModuleRegistry({ snapshotDirectory: () => join(root, 'snapshots') }),
    activation: {
      actual: async () => ({ actual: 'running', actualIntegrity: current.entry.integrity }),
    } as never,
    workerGeneration: () => generation,
  })
  const authority = {
    audience: 'admin' as const,
    principalId: 'test',
    clientId: 'test',
    permissions: ['packages.read' as const],
  }
  const params = { profile: inventory.profile }
  const method = '_agnes/v1/clientModules.frontendPublication'
  try {
    expect(await service.call('_agnes/v1/clientModules.list', params, authority)).toMatchObject({
      modules: [],
      rows: [],
    })
    const first = await service.call(method, params, authority)
    expect(first).toMatchObject({
      owner: { extension: 'acme/row-0', identity: expect.stringMatching(/^[a-f0-9]{64}$/) },
    })
    await expect(
      service.call(method, params, { ...authority, methods: ['_agnes/v1/clientModules.list'] }),
    ).rejects.toMatchObject({ message: 'CAPABILITY_DENIED' })
    generation++
    expect(await service.call(method, params, authority)).not.toEqual(first)
    current = { ...row, contributions: [...row.contributions, ...row.contributions] }
    await expect(service.call(method, params, authority)).rejects.toMatchObject({
      data: { reason: 'FRONTEND_PUBLICATION_OWNER_AMBIGUOUS' },
    })
    current = { ...row, enabled: false }
    expect(await service.call(method, params, authority)).toEqual({})
  } finally {
    service.closeClientModules()
  }
})

it('reads exact-profile annotations independently of old client admission and local failures', async () => {
  const { root, row, inventory } = await fixture([{ entry: 'entry.js' }])
  let current: InstalledInventory = inventory
  const service = createPackageAdminService({
    manager: { inventory: async () => current } as unknown as PackageManager,
    profileDirectory: scopedPackageProfileDirectory({ profile: inventory.profile, profileDir: root }),
    operations: new FilePackageOperationStore(join(root, 'operations')),
    clientModules: createClientModuleRegistry({
      snapshotDirectory: () => join(root, 'snapshots'),
      clock: () => new Date('2026-11-26T00:00:00.000Z'),
    }),
  })
  const method = '_agnes/v1/clientModules.uiEntries'
  const params = { profile: inventory.profile }
  const read = {
    audience: 'admin' as const,
    principalId: 'local',
    clientId: 'web',
    permissions: ['packages.read' as const],
    methods: ['_agnes/v1/clientModules.list', method] as const,
  }
  const help: PluginUiEntryDeclaration = {
    id: 'same',
    placement: 'settings',
    title: { en: '<Guide>', 'zh-CN': '指南' },
    configure: true,
  }
  const main = { ...help, rowId: 'ext:acme/main' }
  const other = { ...help, rowId: 'ext:acme/other', placement: 'sidebar' as const }
  const declared = { ...row, uiEntries: [other, main] }
  try {
    await expect(service.call(method, params, undefined)).rejects.toMatchObject({
      message: 'CAPABILITY_DENIED',
    })
    await expect(
      service.call(method, params, { ...read, methods: ['_agnes/v1/clientModules.list'] }),
    ).rejects.toMatchObject({ message: 'CAPABILITY_DENIED' })
    await expect(service.call(method, { profile: 'other' }, read)).rejects.toMatchObject({
      message: 'CAPABILITY_DENIED',
    })
    await expect(service.call(method, { ...params, sessionId: 'old' }, read)).rejects.toMatchObject({
      message: 'INVALID_PARAMS',
    })
    const legacy = await service.call('_agnes/v1/clientModules.list', params, read)
    expect(legacy).toMatchObject({
      rows: [],
      statuses: [expect.objectContaining({ reason: 'native-ui-not-admitted' })],
    })
    current = {
      ...inventory,
      packages: [
        { ...declared, id: '@acme/z' },
        { ...declared, id: '@acme/untrusted', trusted: false },
        { ...declared, id: '@acme/disabled', enabled: false },
        { ...declared, id: '@acme/local-failed', localFailure: 'retained old installation' },
        {
          ...declared,
          id: '@acme/editable',
          entry: { ...declared.entry, source: { type: 'workspace', ref: 'workspace:editable' } },
        },
        { ...declared, id: '@acme/blocked', blockers: [{ code: 'incompatible', references: [] }] },
        declared,
      ],
    }
    expect(await service.call(method, params, read)).toEqual({
      entries: [
        { ...main, packageId: row.id, integrity: row.entry.integrity },
        { ...other, packageId: row.id, integrity: row.entry.integrity },
        { ...main, packageId: '@acme/z', integrity: row.entry.integrity },
        { ...other, packageId: '@acme/z', integrity: row.entry.integrity },
      ],
    })
    current = { ...inventory, packages: [declared] }
    expect(await service.call('_agnes/v1/clientModules.list', params, read)).toEqual(legacy)
    current = { ...current, profile: 'other' }
    await expect(service.call(method, params, read)).rejects.toMatchObject({
      message: 'CAPABILITY_DENIED',
    })
  } finally {
    service.closeClientModules()
  }
})

it.each([false, true])('returns a deterministic prefix within both caps (large: %s)', async (large) => {
  const { root, row, inventory } = await fixture([])
  const markdown = large ? { en: '中'.repeat(2048), 'zh-CN': '文'.repeat(2048) } : { en: '# Guide' }
  const packages = Array.from({ length: 5 }, (_, pkgIndex) => ({
    ...row,
    id: `@acme/package-${pkgIndex}`,
    uiEntries: Array.from({ length: 32 }, (_, index) => ({
      id: `entry-${String(index % 8).padStart(2, '0')}`,
      rowId: `row-${Math.floor(index / 8)}`,
      placement: 'workbench.bottom' as const,
      title: { en: 'Guide' },
      markdown,
    })).toReversed(),
  })).toReversed()
  const service = createPackageAdminService({
    manager: { inventory: async () => ({ ...inventory, packages }) } as unknown as PackageManager,
    profileDirectory: scopedPackageProfileDirectory({ profile: inventory.profile, profileDir: root }),
    operations: new FilePackageOperationStore(join(root, 'operations')),
    clientModules: createClientModuleRegistry({ snapshotDirectory: () => join(root, 'snapshots') }),
  })
  const method = '_agnes/v1/clientModules.uiEntries'
  const params = { profile: inventory.profile }
  const authority = {
    audience: 'admin' as const,
    principalId: 'test',
    clientId: 'web',
    permissions: ['packages.read' as const],
  }
  try {
    const value = await service.call(method, params, authority)
    const checked = validatePackageAdminCall(method, 'result', value)
    expect(checked.ok).toBe(true)
    const expected = packages.toReversed().flatMap((pkg) =>
      pkg.uiEntries.toReversed().map((entry) => ({
        ...entry,
        packageId: pkg.id,
        integrity: pkg.entry.integrity,
      })),
    )
    const length = large
      ? expected.findIndex(
          (_, index) =>
            Buffer.byteLength(JSON.stringify({ entries: expected.slice(0, index + 1) })) > 512 * 1024,
        )
      : 128
    expect(length).toBeGreaterThan(0)
    if (large) expect(length).toBeLessThan(128)
    expect(value).toEqual({ entries: expected.slice(0, length) })
    expect(await service.call(method, params, authority)).toEqual(value)
    const overLimit = { entries: expected.slice(0, length + 1) }
    expect(validatePackageAdminCall(method, 'result', overLimit).ok).toBe(false)
  } finally {
    service.closeClientModules()
  }
})
