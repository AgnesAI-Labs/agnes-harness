import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashDirectory, type InstalledPackage, type PackageManager } from '@agnes/package-manager'
import { type ClientContribution, projectClientModuleRows, validatePackageAdminData } from '@agnes/protocol'
import { UI_COMPONENT_MODULE_BYTES } from '@agnes/protocol/intelligent-ui'
import { afterEach, expect, it } from 'vitest'
import { admissionDigest } from '../src/packages/client-admission.js'
import { createClientModuleRegistry } from '../src/packages/client-modules.js'
import { createPackageAdminService } from '../src/packages/handler.js'
import { FilePackageOperationStore } from '../src/packages/operations.js'

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
