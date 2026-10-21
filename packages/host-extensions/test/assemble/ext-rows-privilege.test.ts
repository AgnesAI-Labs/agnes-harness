import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedPackage } from '@agnes/host-common/profile/types'
import { HOST_CAPABILITY_GRANTS } from '@agnes/package-manager'
import { createPluginRow } from '@agnes/plugin-runtime/host'
import { afterEach, describe, expect, it } from 'vitest'
import { pinHostCapabilities } from '../../src/assemble/host-grants.js'
import type { PackageModule } from '../../src/assemble/packages.js'

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
  const directory = mkdtempSync(join(tmpdir(), 'agh-host-grant-'))
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
      { sessionTasks: true, searchProvider: true, hookRank: 3 },
      {
        sessionTasks: true,
        trustedHookCommands: true,
        contextBlocking: true,
        isolatedHooks: true,
        governanceHooks: true,
        hookRank: 15,
      },
      { sessionTasks: true, computerUse: true, hookRank: 13 },
      { sessionTasks: true, privacyTrajectory: true, governanceHooks: true, hookRank: 16 },
      { sessionTasks: true, skillDiscovery: true, hookRank: 18 },
    ])
    expect(h.authority.seam(h.pkg.id, 'artifacts', h.modules.get(h.pkg.id))).toEqual({
      privateArtifactStore: true,
    })
    expect(h.authority.seam(h.pkg.id, 'sandbox', h.modules.get(h.pkg.id))).toEqual({})
    expect(h.authority.extension('@acme/package', ids[0], { id: '@acme/package' })).toEqual({})
    expect(h.authority.extension(h.pkg.id, ids[0], { id: h.pkg.id })).toEqual({})
    expect(h.authority.extension(h.pkg.id, ids[0], undefined)).toEqual({})
    symlinkSync(h.directory, join(h.directory, 'data-link'))
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
  it('uses retained generation revisions and refuses a replaced package directory', () => {
    const h = fixture()
    const digest = h.authority.integrity(h.pkg.id)
    if (!digest) throw new Error('missing release tree digest')
    const retained = createPluginRow({
      id: 'ext:agnes/tools-web',
      plugin: 'builtin:@agnes/base/tools-web',
      snapshotDigest: 'host-ext-row:v1',
      exportName: 'agnes/tools-web',
      entryRevision: digest,
      extrasRevision: 'none',
      mountRevision: 'host-ext-row:v1',
    })
    writeFileSync(join(h.directory, 'index.js'), 'export const identity = 2\n')
    const restored = pinHostCapabilities([h.pkg], new Map([[h.pkg.id, h.directory]]), [retained])
    restored.bind(h.modules)
    expect(restored.extension(h.pkg.id, ids[0], h.modules.get(h.pkg.id))).toEqual({})
    renameSync(h.directory, `${h.directory}-retired`)
    roots.push(`${h.directory}-retired`)
    const replacement = fixture()
    renameSync(replacement.directory, h.directory)
    expect(h.grants()).toEqual(ids.map(() => ({})))
  })
})
