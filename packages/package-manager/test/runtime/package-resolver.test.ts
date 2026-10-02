import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackageResolverProvider } from '../../src/runtime/providers/package-resolver.js'
import { createPackageSourceProvider } from '../../src/runtime/providers/package-source.js'
import {
  emptyPackageLock,
  identifyPackage,
  installedDir,
  LOCK_FILE,
  packageLock,
  readPackageTree,
  readSnapshot,
} from '../../src/runtime/source-snapshot.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'pkg-resolve-'))
  roots.push(root)
  return root
}

function writePackage(
  source: string,
  packageId: string,
  version: string,
  extra: Record<string, unknown> = {},
  files: Record<string, string> = { 'readme.txt': `${packageId}@${version}` },
): string {
  const dir = join(source, packageId, version)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id: packageId, version, ...extra }))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

function requirement(packageId: string, versionRange: string, sourceId = 'local') {
  return { packageId, versionRange, sourceIds: [sourceId] }
}

async function publish(
  root: string,
  packageIds: string[],
): Promise<{ cache: string; sourceReads: () => number }> {
  const cache = join(root, 'cache')
  const source = createPackageSourceProvider({
    cacheDir: cache,
    localRoots: { local: join(root, 'source') },
    allowedFeatures: ['read'],
    allowedScopes: ['workspace'],
  })
  const refreshed = await source.refreshCatalog({
    sourceId: 'local',
    requirements: packageIds.flatMap((packageId) =>
      readdirSync(join(root, 'source', packageId)).map((version) => ({
        packageId,
        versionRange: version,
        sourceIds: ['local'],
      })),
    ),
  })
  expect(refreshed.ok).toBe(true)
  return { cache, sourceReads: () => source.networkReads() }
}

function request(
  cacheRequirements: ReturnType<typeof requirement>[],
  installedLock: ReturnType<typeof emptyPackageLock> = emptyPackageLock(),
  apiVersions: { contract: string; major: number }[] = [],
) {
  return {
    requirements: cacheRequirements,
    installedLock,
    allowedSources: ['local'],
    platform: 'test',
    apiVersions,
  }
}

describe('package resolver', () => {
  it('picks the highest stable version and ignores requirement order', async () => {
    const root = temp()
    const source = join(root, 'source')
    writePackage(source, 'acme.lib', '1.0.0')
    writePackage(source, 'acme.lib', '1.2.0')
    writePackage(source, 'acme.lib', '1.3.0-rc.1')
    writePackage(source, 'acme.app', '1.0.0', {
      dependencies: [{ packageId: 'acme.lib', versionRange: '^1.0.0' }],
    })
    writePackage(source, 'acme.extra', '2.0.0')
    const again = await publish(root, ['acme.lib', 'acme.app', 'acme.extra'])
    const left = createPackageResolverProvider({ cacheDir: again.cache })
    const first = left.resolve(
      request([requirement('acme.app', '1.0.0'), requirement('acme.extra', '2.0.0')]),
    )
    const second = left.resolve(
      request([requirement('acme.extra', '2.0.0'), requirement('acme.app', '1.0.0')]),
    )
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.conflicts).toEqual([])
    expect(second.value.lockGraph.digest).toBe(first.value.lockGraph.digest)
    const lib = first.value.lockGraph.entries.find((entry) => entry.packageId === 'acme.lib')
    const app = first.value.lockGraph.entries.find((entry) => entry.packageId === 'acme.app')
    expect(lib?.version).toBe('1.2.0')
    expect(app?.dependencies).toEqual([{ packageId: 'acme.lib', digest: lib?.digest }])
    expect(lib?.version).not.toBe('1.3.0-rc.1')
    expect(left.networkReads()).toBe(0)
    expect(left.processSpawns()).toBe(0)
    expect(existsSync(installedDir(again.cache))).toBe(false)
    const revision = readSnapshot(again.cache)
    expect(revision.ok).toBe(true)
    left.resolve(request([requirement('acme.app', '1.0.0')]))
    const after = readSnapshot(again.cache)
    expect(after.ok && revision.ok && after.value.revision).toBe(revision.ok ? revision.value.revision : -1)
  })

  it('keeps a pin, rejects a changed digest, and rebuilds that lock after restart', async () => {
    const root = temp()
    const source = join(root, 'source')
    writePackage(source, 'acme.lib', '1.0.0', {}, { 'readme.txt': 'pinned' })
    writePackage(source, 'acme.lib', '1.2.0', {}, { 'readme.txt': 'newer' })
    const published = await publish(root, ['acme.lib'])
    const resolver = createPackageResolverProvider({ cacheDir: published.cache })
    const pinned = resolver.resolve(request([requirement('acme.lib', '1.0.0')]))
    expect(pinned.ok).toBe(true)
    if (!pinned.ok) return
    expect(pinned.value.lockGraph.entries[0]?.version).toBe('1.0.0')
    const held = resolver.resolve(request([requirement('acme.lib', '^1.0.0')], pinned.value.lockGraph))
    expect(held.ok).toBe(true)
    if (!held.ok) return
    expect(held.value.conflicts).toEqual([])
    expect(held.value.lockGraph.entries.map((entry) => entry.version)).toEqual(['1.0.0'])
    const stored = JSON.parse(readFileSync(join(published.cache, LOCK_FILE), 'utf8')) as ReturnType<
      typeof emptyPackageLock
    >
    const restarted = createPackageResolverProvider({ cacheDir: published.cache })
    const restored = restarted.resolve(request([requirement('acme.lib', '^1.0.0')], stored))
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    expect(restored.value.lockGraph.digest).toBe(held.value.lockGraph.digest)
    expect(restarted.networkReads()).toBe(0)
    const brokenEntries = pinned.value.lockGraph.entries.map((entry) => ({
      ...entry,
      digest: 'd'.repeat(64),
    }))
    const broken = packageLock(brokenEntries)
    const mismatched = resolver.resolve(request([requirement('acme.lib', '^1.0.0')], broken))
    expect(mismatched.ok).toBe(true)
    if (!mismatched.ok) return
    expect(mismatched.value.conflicts.map((item) => item.packageId)).toContain('acme.lib')
    expect(mismatched.value.conflicts.some((item) => item.reason.includes('content identity mismatch'))).toBe(
      true,
    )
    expect(mismatched.value.lockGraph.entries.some((entry) => entry.version === '1.2.0')).toBe(false)
    expect(mismatched.value.lockGraph.entries.some((entry) => entry.digest === 'd'.repeat(64))).toBe(false)
  })

  it('refuses a missing dependency, a feature, a scope, a bad lock, and a disposed provider', async () => {
    const root = temp()
    const source = join(root, 'source')
    writePackage(source, 'acme.app', '1.0.0', {
      dependencies: [{ packageId: 'acme.missing', versionRange: '1.0.0' }],
    })
    writePackage(source, 'acme.feature', '1.0.0', { requiredFeatures: ['publish'] })
    writePackage(source, 'acme.optional', '1.0.0', {
      dependencies: [{ packageId: 'acme.missing', versionRange: '1.0.0', optional: true }],
    })
    writePackage(source, 'acme.scoped', '1.0.0', { scopes: ['admin'] })
    const published = await publish(root, ['acme.app', 'acme.feature', 'acme.optional', 'acme.scoped'])
    const resolver = createPackageResolverProvider({ cacheDir: published.cache })
    const missing = resolver.resolve(request([requirement('acme.app', '1.0.0')]))
    expect(missing.ok).toBe(true)
    if (!missing.ok) return
    expect(missing.value.conflicts.some((item) => item.reason.includes('missing dependency'))).toBe(true)
    expect(missing.value.lockGraph.entries.some((entry) => entry.packageId === 'acme.app')).toBe(false)
    const optional = resolver.resolve(request([requirement('acme.optional', '1.0.0')]))
    expect(optional.ok).toBe(true)
    if (!optional.ok) return
    expect(optional.value.conflicts).toEqual([])
    expect(optional.value.lockGraph.entries.map((entry) => entry.packageId)).toEqual(['acme.optional'])
    const denied = resolver.resolve(request([requirement('acme.feature', '1.0.0')]))
    expect(denied.ok).toBe(true)
    if (!denied.ok) return
    expect(denied.value.conflicts.some((item) => item.reason.includes('feature not allowed'))).toBe(true)
    expect(
      denied.value.conflicts.some((item) =>
        item.reason.includes('/packages/acme.feature/requiredFeatures/publish'),
      ),
    ).toBe(true)
    const scope = resolver.resolve(request([requirement('acme.scoped', '1.0.0')]))
    expect(scope.ok).toBe(true)
    if (!scope.ok) return
    expect(scope.value.conflicts.some((item) => item.reason.includes('scope not allowed'))).toBe(true)
    const badLock = resolver.resolve(
      request([requirement('acme.optional', '1.0.0')], { entries: [], digest: 'ab'.repeat(32) }),
    )
    expect(badLock.ok).toBe(false)
    if (badLock.ok) return
    expect(badLock.detailCode).toBe('lock_digest_mismatch')
    expect(resolver.resolve({}).ok).toBe(false)
    resolver.cancel()
    const cancelled = resolver.resolve(request([requirement('acme.optional', '1.0.0')]))
    expect(cancelled.ok).toBe(false)
    if (cancelled.ok) return
    expect(cancelled.detailCode).toBe('operation_cancelled')
    const sibling = createPackageResolverProvider({ cacheDir: published.cache })
    sibling.dispose()
    const disposed = sibling.resolve(request([requirement('acme.optional', '1.0.0')]))
    expect(disposed.ok).toBe(false)
    if (disposed.ok) return
    expect(disposed.detailCode).toBe('provider_disposed')
    const alive = createPackageResolverProvider({ cacheDir: published.cache })
    expect(alive.resolve(request([requirement('acme.optional', '1.0.0')])).ok).toBe(true)
  })

  it('locks a definition owner and refuses a second digest or a private implementation source', async () => {
    const root = temp()
    const source = join(root, 'source')
    const schemaA = 'a'.repeat(64)
    const schemaB = 'b'.repeat(64)
    const contract = 'acme.community/widgets'
    const definition = {
      contract,
      major: 1,
      ownerPackageId: 'acme.defs',
      schemaDigest: schemaA,
      operations: ['draw'],
      features: ['read'],
    }
    const defined = writePackage(source, 'acme.defs', '1.0.0', { contracts: [definition] })
    const definedTree = readPackageTree(defined)
    expect(definedTree.ok).toBe(true)
    if (!definedTree.ok) return
    const identified = identifyPackage(definedTree.value)
    expect(identified.ok).toBe(true)
    if (!identified.ok) return
    const definitionDigest = identified.value.definitions[0]?.definitionDigest
    expect(definitionDigest).toMatch(/^[a-f0-9]{64}$/)
    writePackage(source, 'acme.defs-alt', '1.0.0', {
      contracts: [{ ...definition, ownerPackageId: 'acme.defs-alt', schemaDigest: schemaB }],
    })
    writePackage(source, 'acme.impl', '1.0.0', {
      privatePaths: ['src/secret.ts'],
      dependencies: [{ packageId: 'acme.defs', versionRange: '1.0.0' }],
      contractRefs: [{ contract, major: 1, ownerPackageId: 'acme.defs', definitionDigest }],
    })
    writePackage(source, 'acme.consumer', '1.0.0', {
      dependencies: [{ packageId: 'acme.impl', versionRange: '1.0.0' }],
      contractRefs: [{ contract, major: 1, ownerPackageId: 'acme.impl', definitionDigest }],
    })
    writePackage(source, 'acme.good', '1.0.0', {
      dependencies: [{ packageId: 'acme.defs', versionRange: '1.0.0' }],
      contractRefs: [{ contract, major: 1, ownerPackageId: 'acme.defs', definitionDigest }],
    })
    const published = await publish(root, [
      'acme.defs',
      'acme.defs-alt',
      'acme.impl',
      'acme.consumer',
      'acme.good',
    ])
    const resolver = createPackageResolverProvider({ cacheDir: published.cache })
    const good = resolver.resolve(
      request([requirement('acme.good', '1.0.0'), requirement('acme.defs', '1.0.0')]),
    )
    expect(good.ok).toBe(true)
    if (!good.ok) return
    expect(good.value.conflicts).toEqual([])
    expect(good.value.lockGraph.entries.map((entry) => entry.packageId).sort()).toEqual([
      'acme.defs',
      'acme.good',
    ])
    const leaked = resolver.resolve(
      request([
        requirement('acme.consumer', '1.0.0'),
        requirement('acme.impl', '1.0.0'),
        requirement('acme.defs', '1.0.0'),
      ]),
    )
    expect(leaked.ok).toBe(true)
    if (!leaked.ok) return
    expect(
      leaked.value.conflicts.some(
        (item) => item.packageId === 'acme.consumer' && item.reason.includes('src/secret.ts'),
      ),
    ).toBe(true)
    expect(leaked.value.lockGraph.entries.some((entry) => entry.packageId === 'acme.consumer')).toBe(false)
    const forked = resolver.resolve(
      request([requirement('acme.defs', '1.0.0'), requirement('acme.defs-alt', '1.0.0')]),
    )
    expect(forked.ok).toBe(true)
    if (!forked.ok) return
    expect(
      forked.value.conflicts.filter((item) => item.reason.includes('definition digest mismatch')),
    ).toHaveLength(2)
    expect(forked.value.lockGraph.entries).toEqual([])
    const major = resolver.resolve(
      request([requirement('acme.defs', '1.0.0')], emptyPackageLock(), [{ contract, major: 2 }]),
    )
    expect(major.ok).toBe(true)
    if (!major.ok) return
    expect(major.value.conflicts.some((item) => item.reason.includes('api major mismatch'))).toBe(true)
    expect(major.value.lockGraph.entries).toEqual([])
  })
})
