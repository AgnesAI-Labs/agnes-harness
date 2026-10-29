import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import { HOST_CAPABILITY_GRANTS } from '@agnes/package-manager'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { pinHostCapabilities, pinHostCapabilitiesAsync } from '../../src/assemble/host-grants.js'
import { type PackageModule, readNamedExports } from '../../src/assemble/packages.js'

const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const ids = [
  'agnes/tools-web',
  'agnes/hooks-runner',
  'agnes/computer-use',
  'agnes/privacy',
  'agnes/mcp-search',
] as const
function fixture(override: Partial<ResolvedPackage> = {}) {
  const parent = join(homedir(), 'agh-real-eval')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'agh-host-grant-'))
  roots.push(directory)
  writeFileSync(join(directory, 'index.js'), 'export const identity = 1\n')
  const pkg: ResolvedPackage = {
    id: '@agnes/base',
    version: '1.0.0',
    source: 'builtin',
    integrity: 'builtin:1.0.0',
    trust: 'builtin',
    enabled: true,
    ...override,
  }
  const module: PackageModule = { id: pkg.id, extensionEntry: join(directory, 'index.js') }
  const modules = new Map<string, PackageModule>([[pkg.id, module]])
  const authority = pinHostCapabilities([pkg], new Map([[pkg.id, directory]]))
  authority.bind(modules)
  const grants = () => ids.map((id) => authority.extension(pkg.id, id, modules.get(pkg.id)))
  return { directory, pkg, module, modules, authority, grants }
}

describe('verified ext: row privilege grants', () => {
  it('keeps the complete official distribution grant set in one declaration', () => {
    const h = fixture()
    expect(h.grants()).toEqual([
      { sessionTasks: true, childControl: true, searchProvider: true, hookRank: 3 },
      {
        sessionTasks: true,
        childControl: true,
        trustedHookCommands: true,
        contextBlocking: true,
        isolatedHooks: true,
        governanceHooks: true,
        hookRank: 15,
      },
      { sessionTasks: true, childControl: true, computerUse: true, hookRank: 13 },
      {
        sessionTasks: true,
        childControl: true,
        privacyTrajectory: true,
        governanceHooks: true,
        hookRank: 16,
      },
      { sessionTasks: true, childControl: true, skillDiscovery: true, hookRank: 18 },
    ])
    expect(h.authority.seam(h.pkg.id, 'artifacts', h.modules.get(h.pkg.id))).toEqual({
      privateArtifactStore: true,
    })
    expect(h.authority.seam(h.pkg.id, 'sandbox', h.modules.get(h.pkg.id))).toEqual({})
    expect(h.authority.extension('@acme/package', ids[0], { id: '@acme/package' })).toEqual({})
    expect(h.authority.extension(h.pkg.id, ids[0], { id: h.pkg.id })).toEqual({})
    expect(h.authority.extension(h.pkg.id, ids[0], undefined)).toEqual({})
    symlinkSync(h.directory, join(h.directory, 'data-link'), directoryLinkType)
    const linked = pinHostCapabilities([h.pkg], new Map([[h.pkg.id, h.directory]]))
    linked.bind(h.modules)
    expect(linked.extension(h.pkg.id, ids[0], h.module)).toEqual({})
    const image = { id: h.pkg.id }
    linked.bind(new Map([[h.pkg.id, image]]))
    expect(linked.extension(h.pkg.id, ids[0], image)).toMatchObject({ searchProvider: true })
    const alternate = fixture({ id: '@acme/release' })
    const declaration = HOST_CAPABILITY_GRANTS[0]
    if (!declaration) throw new Error('missing release declaration')
    const other = pinHostCapabilities(
      [alternate.pkg],
      new Map([[alternate.pkg.id, alternate.directory]]),
      [],
      [{ ...declaration, packageId: alternate.pkg.id }],
    )
    other.bind(alternate.modules)
    expect(other.extension(alternate.pkg.id, ids[2], alternate.module)).toEqual({
      sessionTasks: true,
      childControl: true,
      computerUse: true,
      hookRank: 13,
    })
  })
  it.each([
    { trust: 'trusted', source: 'file:./spoof' },
    { trust: 'trusted', source: 'npm:@agnes/base' },
    { trust: 'builtin', source: 'file:./spoof' },
    { trust: 'builtin', integrity: 'sha256-spoof' },
    { enabled: false },
    { id: '@acme/package' },
    ...ids.map((id) => ({ id, trust: 'trusted' as const, source: 'file:./spoof' })),
  ] satisfies Partial<ResolvedPackage>[])('refuses a named or untrusted lookalike: %j', (override) => {
    const h = fixture(override)
    expect(h.grants()).toEqual(ids.map(() => ({})))
    expect(h.authority.seam(h.pkg.id, 'artifacts', h.modules.get(h.pkg.id))).toEqual({})
  })
  it('withdraws grants when a bound module, installed trust or tree changes', () => {
    const h = fixture()
    const original = h.module
    h.modules.set(h.pkg.id, { id: h.pkg.id })
    expect(h.grants()).toEqual(ids.map(() => ({})))
    h.modules.set(h.pkg.id, original)
    h.pkg.trust = 'trusted'
    expect(h.grants()).toEqual(ids.map(() => ({})))
    h.pkg.trust = 'builtin'
    writeFileSync(join(h.directory, 'index.js'), 'export const identity = 2\n')
    expect(h.grants()).toEqual(ids.map(() => ({})))
    expect(h.authority.seam(h.pkg.id, 'artifacts', original)).toEqual({})
  })
  it.each([
    { name: 'sync', pin: pinHostCapabilities },
    { name: 'async', pin: pinHostCapabilitiesAsync },
  ])('uses retained revisions and refuses a replaced directory ($name)', async ({ pin }) => {
    const h = fixture()
    const official = h.grants()
    const digest = h.authority.integrity(h.pkg.id)
    if (!digest) throw new Error('missing release tree digest')
    const rowInput = {
      id: 'ext:agnes/tools-web',
      plugin: 'builtin:@agnes/base/tools-web',
      snapshotDigest: 'host-ext-row:v1',
      exportName: 'agnes/tools-web',
      entryRevision: digest,
      extrasRevision: 'none',
      mountRevision: 'host-ext-row:v1',
    }
    const retained = createPluginRow(rowInput)
    const cold = await pin([h.pkg], new Map([[h.pkg.id, h.directory]]), [retained])
    cold.bind(h.modules)
    expect(ids.map((id) => cold.extension(h.pkg.id, id, h.module))).toEqual(official)
    const mixed = await pin([h.pkg], new Map([[h.pkg.id, h.directory]]), [
      retained,
      createPluginRow({ ...rowInput, id: 'ext:agnes/hooks-runner', entryRevision: 'custom' }),
    ])
    mixed.bind(h.modules)
    expect(ids.map((id) => mixed.extension(h.pkg.id, id, h.module))).toEqual(ids.map(() => ({})))
    expect(mixed.seam(h.pkg.id, 'artifacts', h.module)).toEqual({})
    writeFileSync(join(h.directory, 'index.js'), 'export const identity = 2\n')
    const restored = await pin([h.pkg], new Map([[h.pkg.id, h.directory]]), [retained])
    restored.bind(h.modules)
    expect(restored.extension(h.pkg.id, ids[0], h.modules.get(h.pkg.id))).toEqual({})
    // A normal release starts a new authority; old generations cannot attest the upgraded tree.
    Object.assign(h.pkg, { version: '2.0.0', integrity: 'builtin:2.0.0' })
    const upgrade = await pin([h.pkg], new Map([[h.pkg.id, h.directory]]))
    upgrade.bind(h.modules)
    expect(ids.map((id) => upgrade.extension(h.pkg.id, id, h.module))).toEqual(official)
    const upgradedDigest = upgrade.integrity(h.pkg.id)
    if (!upgradedDigest) throw new Error('missing upgraded release tree digest')
    expect(upgradedDigest).not.toBe(digest)
    const upgradedRow = createPluginRow({ ...rowInput, entryRevision: upgradedDigest })
    const restarted = await pin([h.pkg], new Map([[h.pkg.id, h.directory]]), [upgradedRow])
    restarted.bind(h.modules)
    expect(ids.map((id) => restarted.extension(h.pkg.id, id, h.module))).toEqual(official)
    renameSync(h.directory, `${h.directory}-retired`)
    roots.push(`${h.directory}-retired`)
    const replacement = fixture()
    renameSync(replacement.directory, h.directory)
    expect(h.grants()).toEqual(ids.map(() => ({})))
  })
  it.each([
    { source: 'link:./base', trust: 'trusted' },
    { source: 'workspace:packages/base', trust: 'trusted' },
    { source: 'npm:@agnes/base', trust: 'trusted' },
  ] satisfies Partial<ResolvedPackage>[])(
    'refuses all grants for linked/workspace lookalikes: %j',
    (override) => {
      const h = fixture(override)
      expect(h.grants()).toEqual(ids.map(() => ({})))
      expect(h.authority.seam(h.pkg.id, 'artifacts', h.module)).toEqual({})
      expect(h.authority.governance()).toEqual([])
    },
  )

  it.each([
    { enabled: false },
    { source: 'file:./replacement' },
    { trust: 'trusted' },
    { version: '2.0.0' },
    { integrity: 'builtin:2.0.0' },
  ] satisfies Partial<ResolvedPackage>[])('rechecks every identity field at grant time: %j', (patch) => {
    const h = fixture()
    Object.assign(h.pkg, patch)
    expect(h.grants()).toEqual(ids.map(() => ({})))
    expect(h.authority.seam(h.pkg.id, 'artifacts', h.module)).toEqual({})
  })

  it('does not lend the official module or factories to another builtin owner', () => {
    const h = fixture()
    const other = { ...h.pkg, id: '@agnes/code' }
    const factory = () => () => undefined
    const isolated = async () => ({ data: {}, capability: async () => undefined })
    Object.assign(h.module, { ecosystem: { [ids[1]]: factory }, isolatedEcosystem: { [ids[1]]: isolated } })
    const borrowed = { ...h.module, id: other.id }
    h.modules.set(other.id, borrowed)
    const authority = pinHostCapabilities(
      [h.pkg, other],
      new Map([
        [h.pkg.id, h.directory],
        [other.id, h.directory],
      ]),
    )
    authority.bind(h.modules)
    expect(authority.extension(h.pkg.id, ids[1], h.module)).toMatchObject({ isolatedHooks: true })
    expect(authority.extension(other.id, ids[1], borrowed)).toEqual({})
    expect(authority.extension(h.pkg.id, ids[1], borrowed)).toEqual({})
    expect(authority.seam(other.id, 'artifacts', borrowed)).toEqual({})
    h.module.ecosystem![ids[1]] = () => () => undefined
    expect(authority.extension(h.pkg.id, ids[1], h.module)).toEqual({})
    h.module.ecosystem![ids[1]] = factory
    h.module.isolatedEcosystem![ids[1]] = async () => ({ data: {}, capability: async () => undefined })
    expect(authority.extension(h.pkg.id, ids[1], h.module)).toEqual({})
  })

  it('refuses a file loader directory symlink before and after swapping its target', () => {
    const h = fixture()
    const replacement = fixture()
    const link = join(h.directory, 'load-path')
    symlinkSync(replacement.directory, link, directoryLinkType)
    const authority = pinHostCapabilities([h.pkg], new Map([[h.pkg.id, link]]))
    authority.bind(h.modules)
    expect(authority.extension(h.pkg.id, ids[2], h.module)).toEqual({})
    unlinkSync(link)
    symlinkSync(h.directory, link, directoryLinkType)
    expect(authority.extension(h.pkg.id, ids[2], h.module)).toEqual({})
  })

  it('does not let named exports declare an executable code image', () => {
    const h = fixture()
    const module = readNamedExports(h.pkg.id, join(h.directory, 'index.js'), {
      id: h.pkg.id,
      extensionEntry: undefined,
      embeddedExtensions: [],
      hostGrants: HOST_CAPABILITY_GRANTS,
    })
    expect(module.extensionEntry).toBe(join(h.directory, 'index.js'))
    expect(module.embeddedExtensions).toBeUndefined()
    h.modules.set(h.pkg.id, module)
    h.authority.bind(h.modules)
    writeFileSync(join(h.directory, 'index.js'), 'export const identity = 2\n')
    expect(h.grants()).toEqual(ids.map(() => ({})))
  })

  it.each(['host-ext-row:v1', 'custom-reload-revision'])(
    'refuses a changed tree when a retained row has a non-hash revision: %s',
    (entryRevision) => {
      const h = fixture()
      const retained = createPluginRow({
        id: 'ext:agnes/hooks-runner',
        plugin: 'builtin:@agnes/base/hooks-runner',
        snapshotDigest: 'host-ext-row:v1',
        exportName: 'agnes/hooks-runner',
        entryRevision,
        extrasRevision: 'none',
        mountRevision: 'host-ext-row:v1',
      })
      writeFileSync(join(h.directory, 'index.js'), 'export const identity = 2\n')
      const restored = pinHostCapabilities([h.pkg], new Map([[h.pkg.id, h.directory]]), [retained])
      restored.bind(h.modules)
      expect.soft(restored.extension(h.pkg.id, ids[1], h.module)).toEqual({})
      expect(restored.seam(h.pkg.id, 'artifacts', h.module)).toEqual({})
    },
  )
})
