import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPackageResolverProvider as createReferenceResolver } from '../../../../examples/runtime-reference/src/providers/package-resolver.ts'
import { createPackageSourceProvider as createReferenceSource } from '../../../../examples/runtime-reference/src/providers/package-source.ts'
import {
  type PackageResolverEvidence,
  type PackageResolverPort,
  registerPackageResolverContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/package-resolver.ts'
import {
  type PackageScenarioEvidence,
  type PackageSourcePort,
  registerPackageSourceContract,
} from '../../../../packages/extension-api/testkit/runtime/contracts/package-source.ts'
import type { BuildIdentity } from '../../../../packages/extension-api/testkit/runtime/evidence.ts'
import type { ConformanceHarness } from '../../../../packages/extension-api/testkit/runtime/harness.ts'
import { createPackageResolverProvider as createDefaultResolver } from '../../../../packages/package-manager/src/runtime/providers/package-resolver.ts'
import {
  createPackageSourceProvider as createDefaultSource,
  type PackageSourceOptions,
  type PackageSourceProvider,
} from '../../../../packages/package-manager/src/runtime/providers/package-source.ts'
import {
  emptyPackageLock,
  identifyPackage,
  readPackageTree,
  sha256Hex,
} from '../../../../packages/package-manager/src/runtime/source-snapshot.ts'
import { initGitPackage, startNpmRegistry, writePackageTree } from '../fixtures/package-sources.ts'

const SOURCE_ID = {
  default: 'agh.default/package-source',
  reference: 'agh.reference/package-source',
} as const
const RESOLVER_ID = {
  default: 'agh.default/package-resolver',
  reference: 'agh.reference/package-resolver',
} as const

type Kind = keyof typeof SOURCE_ID
type SourceFactory = (options: PackageSourceOptions) => PackageSourceProvider
type ResolverFactory = typeof createDefaultResolver

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function evidence(
  providerDigest: string,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): PackageScenarioEvidence {
  return { passed: true, providerDigest, configDigest, releaseSetDigest, detail }
}

function repoRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url))
}

function createBuild(): BuildIdentity {
  const root = repoRoot()
  const lockDigest = sha256Hex(readFileSync(join(root, 'pnpm-lock.yaml')))
  const sdk = JSON.parse(readFileSync(join(root, 'packages/extension-api/package.json'), 'utf8')) as {
    name: string
    version: string
  }
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const specVersion = 'runtime-services-1'
  return {
    codeSha,
    buildDigest: sha256Hex(`${codeSha}\n${specVersion}`),
    lockDigest,
    specVersion,
    sdkVersion: sdk.version,
    sdkDigest: sha256Hex(`${sdk.name}@${sdk.version}`),
    platform: `${process.platform}-${process.arch}`, // guards-allow-platform: evidence only, no branch
  }
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function requirement(sourceId: string) {
  return { packageId: 'acme.tools', versionRange: '1.0.0', sourceIds: [sourceId] }
}

function sourcePort(create: SourceFactory, kind: Kind): PackageSourcePort {
  const realId = SOURCE_ID[kind]
  const providerDigest = sha256(realId)
  return {
    recipe: 'local',
    async select() {
      const root = temp('pkg-select-')
      try {
        const provider = create({
          cacheDir: join(root, 'snapshots'),
          localRoots: { local: join(root, 'source') },
          providerId: realId,
        })
        assert.equal(provider.providerId, realId)
        assert.equal(provider.contract, 'agh.package-source')
        return evidence(providerDigest, providerDigest, providerDigest, realId)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async normal() {
      const root = temp('pkg-normal-')
      try {
        const source = join(root, 'source')
        const cache = join(root, 'snapshots')
        writePackageTree(source, 'acme.tools', '1.0.0', 'staged')
        const provider = create({ cacheDir: cache, localRoots: { local: source }, providerId: realId })
        const refreshed = await provider.refreshCatalog({
          sourceId: 'local',
          requirements: [requirement('local')],
        })
        assert.equal(refreshed.ok, true)
        const reads = provider.networkReads()
        const found = provider.discover({ query: 'acme.tools', cursor: null, limit: 5 })
        assert.equal(found.ok, true)
        if (!found.ok) return evidence(providerDigest, providerDigest, providerDigest, 'undiscovered')
        assert.equal(provider.networkReads(), reads)
        assert.equal(provider.processSpawns(), 0)
        const item = found.value.items[0]
        assert.ok(item)
        const metadata = provider.resolveMetadata({ packageId: 'acme.tools', version: '1.0.0' })
        assert.equal(metadata.ok, true)
        if (!metadata.ok) return evidence(providerDigest, providerDigest, providerDigest, 'unread')
        assert.deepEqual(metadata.value.provenance.trustLabels, ['content-addressed'])
        const fetched = await provider.fetch({ locator: item.locator, expectedDigest: item.digest })
        assert.equal(fetched.ok, true)
        if (!fetched.ok) return evidence(providerDigest, providerDigest, providerDigest, 'unfetched')
        assert.equal(fetched.value.verifiedDigest, item.digest)
        assert.equal(existsSync(join(cache, 'installed')), false)
        return evidence(providerDigest, metadata.value.digest, item.digest, 'staged')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async deny() {
      const root = temp('pkg-deny-')
      try {
        const source = join(root, 'source')
        const provider = create({
          cacheDir: join(root, 'snapshots'),
          localRoots: { local: source },
          providerId: realId,
        })
        writePackageTree(source, 'acme.tools', '1.0.0', 'sealed')
        assert.equal(
          (await provider.refreshCatalog({ sourceId: 'local', requirements: [requirement('local')] })).ok,
          true,
        )
        const found = provider.discover({ query: '', cursor: null, limit: 5 })
        assert.equal(found.ok, true)
        if (!found.ok) return evidence(providerDigest, providerDigest, providerDigest, 'undiscovered')
        const item = found.value.items[0]
        assert.ok(item)
        const refused = await provider.fetch({ locator: item.locator, expectedDigest: 'b'.repeat(64) })
        assert.equal(refused.ok, false)
        if (refused.ok) return evidence(providerDigest, providerDigest, providerDigest, 'accepted')
        assert.equal(refused.detailCode, 'digest_mismatch')
        const digest = sha256(refused.detailCode)
        return evidence(providerDigest, digest, item.digest, refused.detailCode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async cancel() {
      const root = temp('pkg-cancel-')
      try {
        const source = join(root, 'source')
        const cache = join(root, 'snapshots')
        writePackageTree(source, 'acme.tools', '1.0.0', 'partial')
        const admitted = create({ cacheDir: cache, localRoots: { local: source }, providerId: realId })
        assert.equal(
          (await admitted.refreshCatalog({ sourceId: 'local', requirements: [requirement('local')] })).ok,
          true,
        )
        const found = admitted.discover({ query: '', cursor: null, limit: 5 })
        assert.equal(found.ok, true)
        if (!found.ok) return evidence(providerDigest, providerDigest, providerDigest, 'undiscovered')
        const item = found.value.items[0]
        assert.ok(item)
        rmSync(join(cache, 'staging'), { recursive: true, force: true })
        const limited = create({
          cacheDir: cache,
          localRoots: { local: source },
          providerId: realId,
          stageByteLimit: 8,
        })
        const interrupted = await limited.fetch({ locator: item.locator, expectedDigest: item.digest })
        assert.equal(interrupted.ok, false)
        if (interrupted.ok) return evidence(providerDigest, providerDigest, providerDigest, 'completed')
        assert.equal(interrupted.detailCode, 'operation_cancelled')
        assert.equal(existsSync(join(cache, 'staging', item.digest, 'PARTIAL')), true)
        assert.equal(existsSync(join(cache, 'staging', item.digest, 'archive.tar')), false)
        assert.equal(existsSync(join(cache, 'installed')), false)
        const digest = sha256(interrupted.detailCode)
        return evidence(providerDigest, digest, item.digest, interrupted.detailCode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async recover() {
      const root = temp('pkg-recover-')
      try {
        const source = join(root, 'source')
        const cache = join(root, 'snapshots')
        writePackageTree(source, 'acme.tools', '1.0.0', 'again')
        const admitted = create({ cacheDir: cache, localRoots: { local: source }, providerId: realId })
        assert.equal(
          (await admitted.refreshCatalog({ sourceId: 'local', requirements: [requirement('local')] })).ok,
          true,
        )
        const found = admitted.discover({ query: '', cursor: null, limit: 5 })
        assert.equal(found.ok, true)
        if (!found.ok) return evidence(providerDigest, providerDigest, providerDigest, 'undiscovered')
        const item = found.value.items[0]
        assert.ok(item)
        rmSync(join(cache, 'staging'), { recursive: true, force: true })
        const limited = create({
          cacheDir: cache,
          localRoots: { local: source },
          providerId: realId,
          stageByteLimit: 8,
        })
        assert.equal((await limited.fetch({ locator: item.locator, expectedDigest: item.digest })).ok, false)
        const recovered = create({ cacheDir: cache, localRoots: { local: source }, providerId: realId })
        const fetched = await recovered.fetch({ locator: item.locator, expectedDigest: item.digest })
        assert.equal(fetched.ok, true)
        if (!fetched.ok) return evidence(providerDigest, providerDigest, providerDigest, 'unrecovered')
        assert.equal(fetched.value.verifiedDigest, item.digest)
        assert.equal(recovered.networkReads(), 0)
        assert.equal(existsSync(join(cache, 'staging', item.digest, 'archive.tar')), true)
        assert.equal(existsSync(join(cache, 'staging', item.digest, 'PARTIAL')), false)
        assert.equal(existsSync(join(cache, 'installed')), false)
        return evidence(providerDigest, sha256('recovered'), item.digest, 'recovered')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async dispose() {
      const root = temp('pkg-dispose-')
      try {
        const provider = create({
          cacheDir: join(root, 'snapshots'),
          localRoots: { local: join(root, 'source') },
          providerId: realId,
        })
        const sibling = create({
          cacheDir: join(root, 'sibling'),
          localRoots: { local: join(root, 'source') },
          providerId: realId,
        })
        provider.dispose()
        const denied = provider.discover({ query: '', cursor: null, limit: 1 })
        assert.equal(denied.ok, false)
        if (denied.ok) return evidence(providerDigest, providerDigest, providerDigest, 'still open')
        assert.equal(denied.detailCode, 'provider_disposed')
        const open = sibling.discover({ query: '', cursor: null, limit: 1 })
        assert.equal(open.ok, true)
        sibling.dispose()
        return evidence(providerDigest, sha256(denied.detailCode), sha256('sibling'), denied.detailCode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

function resolverEvidence(
  providerDigest: string,
  configDigest: string,
  releaseSetDigest: string,
  detail: string,
): PackageResolverEvidence {
  return { passed: true, providerDigest, configDigest, releaseSetDigest, detail }
}

function resolverPort(
  createSource: SourceFactory,
  createResolver: ResolverFactory,
  kind: Kind,
): PackageResolverPort {
  const realId = RESOLVER_ID[kind]
  const providerDigest = sha256(realId)
  const publish = async (cache: string, roots: Record<string, string>, sourceId: string) => {
    const source = createSource({ cacheDir: cache, localRoots: roots, providerId: SOURCE_ID[kind] })
    const refreshed = await source.refreshCatalog({ sourceId, requirements: [requirement(sourceId)] })
    assert.equal(refreshed.ok, true)
    source.dispose()
  }
  return {
    recipe: 'lock',
    async select() {
      const root = temp('resolve-select-')
      try {
        const resolver = createResolver({ cacheDir: join(root, 'snapshots'), providerId: realId })
        assert.equal(resolver.providerId, realId)
        assert.equal(resolver.contract, 'agh.package-resolver')
        assert.equal(resolver.networkReads(), 0)
        return resolverEvidence(providerDigest, providerDigest, providerDigest, realId)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async normal() {
      const root = temp('resolve-normal-')
      try {
        const source = join(root, 'source')
        const cache = join(root, 'snapshots')
        writePackageTree(source, 'acme.tools', '1.0.0', 'locked')
        await publish(cache, { local: source }, 'local')
        const resolver = createResolver({ cacheDir: cache, providerId: realId })
        const resolved = resolver.resolve({
          requirements: [requirement('local')],
          installedLock: emptyPackageLock(),
          allowedSources: ['local'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(resolved.ok, true)
        if (!resolved.ok)
          return resolverEvidence(providerDigest, providerDigest, providerDigest, 'unresolved')
        assert.deepEqual(resolved.value.conflicts, [])
        assert.equal(resolved.value.lockGraph.entries[0]?.packageId, 'acme.tools')
        assert.equal(resolver.networkReads(), 0)
        assert.equal(resolver.processSpawns(), 0)
        assert.equal(existsSync(join(cache, 'installed')), false)
        return resolverEvidence(
          providerDigest,
          resolved.value.configDigest,
          resolved.value.lockGraph.digest,
          'locked',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async deny() {
      const root = temp('resolve-deny-')
      try {
        const left = join(root, 'left')
        const right = join(root, 'right')
        const cache = join(root, 'snapshots')
        writePackageTree(left, 'acme.tools', '1.0.0', 'left')
        writePackageTree(right, 'acme.tools', '1.0.0', 'right')
        await publish(cache, { left, right }, 'left')
        await publish(cache, { left, right }, 'right')
        const resolver = createResolver({ cacheDir: cache, providerId: realId })
        const resolved = resolver.resolve({
          requirements: [{ packageId: 'acme.tools', versionRange: '1.0.0', sourceIds: [] }],
          installedLock: emptyPackageLock(),
          allowedSources: ['left', 'right'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(resolved.ok, true)
        if (!resolved.ok)
          return resolverEvidence(providerDigest, providerDigest, providerDigest, 'unresolved')
        assert.equal(
          resolved.value.conflicts.some((item) => item.reason.includes('content identity mismatch')),
          true,
        )
        assert.equal(resolved.value.lockGraph.entries.length, 0)
        const digest = sha256(resolved.value.conflicts.map((item) => item.reason).join('\n'))
        return resolverEvidence(
          providerDigest,
          resolved.value.configDigest,
          digest,
          'content identity mismatch',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async cancel() {
      const root = temp('resolve-cancel-')
      try {
        const resolver = createResolver({ cacheDir: join(root, 'snapshots'), providerId: realId })
        resolver.cancel()
        const resolved = resolver.resolve({
          requirements: [],
          installedLock: emptyPackageLock(),
          allowedSources: [],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(resolved.ok, false)
        if (resolved.ok) return resolverEvidence(providerDigest, providerDigest, providerDigest, 'completed')
        assert.equal(resolved.detailCode, 'operation_cancelled')
        const digest = sha256(resolved.detailCode)
        return resolverEvidence(providerDigest, digest, digest, resolved.detailCode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async recover() {
      const root = temp('resolve-recover-')
      try {
        const source = join(root, 'source')
        const cache = join(root, 'snapshots')
        writePackageTree(source, 'acme.tools', '1.0.0', 'durable')
        await publish(cache, { local: source }, 'local')
        const first = createResolver({ cacheDir: cache, providerId: realId })
        const resolved = first.resolve({
          requirements: [requirement('local')],
          installedLock: emptyPackageLock(),
          allowedSources: ['local'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(resolved.ok, true)
        if (!resolved.ok)
          return resolverEvidence(providerDigest, providerDigest, providerDigest, 'unresolved')
        const stored = JSON.parse(
          readFileSync(join(cache, 'runtime-package-lock.json'), 'utf8'),
        ) as ReturnType<typeof emptyPackageLock>
        const second = createResolver({ cacheDir: cache, providerId: realId })
        const restored = second.resolve({
          requirements: [requirement('local')],
          installedLock: stored,
          allowedSources: ['local'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(restored.ok, true)
        if (!restored.ok)
          return resolverEvidence(providerDigest, providerDigest, providerDigest, 'unrestored')
        assert.equal(restored.value.lockGraph.digest, resolved.value.lockGraph.digest)
        assert.equal(second.networkReads(), 0)
        assert.equal(second.processSpawns(), 0)
        return resolverEvidence(
          providerDigest,
          restored.value.configDigest,
          restored.value.lockGraph.digest,
          'recovered',
        )
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    async dispose() {
      const root = temp('resolve-dispose-')
      try {
        const cache = join(root, 'snapshots')
        writePackageTree(join(root, 'source'), 'acme.tools', '1.0.0', 'sibling')
        await publish(cache, { local: join(root, 'source') }, 'local')
        const resolver = createResolver({ cacheDir: cache, providerId: realId })
        const sibling = createResolver({ cacheDir: cache, providerId: realId })
        resolver.dispose()
        const denied = resolver.resolve({
          requirements: [requirement('local')],
          installedLock: emptyPackageLock(),
          allowedSources: ['local'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(denied.ok, false)
        if (denied.ok) return resolverEvidence(providerDigest, providerDigest, providerDigest, 'still open')
        assert.equal(denied.detailCode, 'provider_disposed')
        const open = sibling.resolve({
          requirements: [requirement('local')],
          installedLock: emptyPackageLock(),
          allowedSources: ['local'],
          platform: 'test',
          apiVersions: [],
        })
        assert.equal(open.ok, true)
        sibling.dispose()
        const digest = sha256(denied.detailCode)
        return resolverEvidence(providerDigest, digest, digest, denied.detailCode)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  }
}

function sourceToken(token: string): Kind | null {
  if (token === 'default' || token === SOURCE_ID.default) return 'default'
  if (token === 'reference' || token === SOURCE_ID.reference) return 'reference'
  return null
}

function resolverToken(token: string): Kind | null {
  if (token === 'default' || token === RESOLVER_ID.default) return 'default'
  if (token === 'reference' || token === RESOLVER_ID.reference) return 'reference'
  return null
}

export async function bindPackageContracts(
  harness: ConformanceHarness,
  command: string,
  providers: readonly string[],
  selected: { readonly source: boolean; readonly resolver: boolean },
): Promise<void> {
  assert.notEqual(command, '')
  const build = createBuild()
  const sources: Record<Kind, SourceFactory> = {
    default: createDefaultSource,
    reference: createReferenceSource,
  }
  const resolvers: Record<Kind, ResolverFactory> = {
    default: createDefaultResolver,
    reference: createReferenceResolver,
  }
  for (const token of providers) {
    const sourceKind = sourceToken(token)
    if (selected.source && sourceKind !== null) {
      registerPackageSourceContract(harness, {
        command,
        build,
        providerId: token,
        sources: [sourcePort(sources[sourceKind], sourceKind)],
      })
    }
    const resolverKind = resolverToken(token)
    if (selected.resolver && resolverKind !== null) {
      registerPackageResolverContract(harness, {
        command,
        build,
        providerId: token,
        sources: [resolverPort(sources[resolverKind], resolvers[resolverKind], resolverKind)],
      })
    }
  }
}

export interface PackageAcceptanceReport {
  readonly ok: true
  readonly sources: {
    readonly local: { readonly digest: string; readonly reused: boolean; readonly installed: false }
    readonly npm: { readonly digest: string; readonly verified: boolean; readonly installed: false }
    readonly git: {
      readonly commit: string
      readonly digest: string
      readonly head: string
      readonly installed: false
    }
  }
  readonly resolvers: { readonly digest: string; readonly sameLock: true }
}

async function stageInterrupt(
  create: SourceFactory,
  providerId: string,
  cache: string,
  options: PackageSourceOptions,
  locator: unknown,
  digest: string,
): Promise<void> {
  rmSync(join(cache, 'staging', digest), { recursive: true, force: true })
  const limited = create({ ...options, cacheDir: cache, providerId, stageByteLimit: 8 })
  const interrupted = await limited.fetch({ locator, expectedDigest: digest })
  assert.equal(interrupted.ok, false)
  if (!interrupted.ok) assert.equal(interrupted.detailCode, 'operation_cancelled')
  assert.equal(existsSync(join(cache, 'staging', digest, 'PARTIAL')), true)
  assert.equal(existsSync(join(cache, 'installed')), false)
  const recovered = create({ ...options, cacheDir: cache, providerId })
  const fetched = await recovered.fetch({ locator, expectedDigest: digest })
  assert.equal(fetched.ok, true)
  assert.equal(existsSync(join(cache, 'staging', digest, 'archive.tar')), true)
  assert.equal(existsSync(join(cache, 'installed')), false)
}

export async function runPackageAcceptance(): Promise<PackageAcceptanceReport> {
  const root = temp('pkg-accept-')
  const registries: Array<{ close(): Promise<void> }> = []
  try {
    const sourceDir = join(root, 'local')
    writePackageTree(sourceDir, 'acme.tools', '1.0.0', 'acceptance')
    const tree = readPackageTree(join(sourceDir, 'acme.tools', '1.0.0'))
    assert.equal(tree.ok, true)
    if (!tree.ok) throw new Error('package tree was refused')
    const identified = identifyPackage(tree.value)
    assert.equal(identified.ok, true)
    if (!identified.ok) throw new Error('package identity was refused')
    const registry = await startNpmRegistry(
      'acme.tools',
      identified.value.archive,
      `sha256-${sha256Hex(identified.value.archive)}`,
    )
    registries.push(registry)
    const gitPackage = initGitPackage(join(root, 'git'), 'from-git')
    const report = { local: '', npm: '', git: '' }
    let lockDigest = ''
    for (const kind of ['default', 'reference'] as const) {
      const create = kind === 'default' ? createDefaultSource : createReferenceSource
      const createResolver = kind === 'default' ? createDefaultResolver : createReferenceResolver
      const cache = join(root, kind)
      const localOptions: PackageSourceOptions = {
        cacheDir: cache,
        localRoots: { local: sourceDir },
        providerId: SOURCE_ID[kind],
      }
      const local = create(localOptions)
      assert.equal(
        (await local.refreshCatalog({ sourceId: 'local', requirements: [requirement('local')] })).ok,
        true,
      )
      const found = local.discover({ query: '', cursor: null, limit: 5 })
      assert.equal(found.ok, true)
      if (!found.ok) throw new Error('local package was not discovered')
      const item = found.value.items[0]
      assert.ok(item)
      if (report.local === '') report.local = item.digest
      else assert.equal(item.digest, report.local)
      const fetched = await local.fetch({ locator: item.locator, expectedDigest: item.digest })
      assert.equal(fetched.ok, true)
      const reads = local.networkReads()
      const reused = await local.fetch({ locator: item.locator, expectedDigest: item.digest })
      assert.equal(reused.ok, true)
      assert.equal(local.networkReads(), reads)
      await stageInterrupt(create, SOURCE_ID[kind], cache, localOptions, item.locator, item.digest)

      const npmOptions: PackageSourceOptions = {
        cacheDir: join(cache, 'npm'),
        npmRegistries: { npm: registry.url },
        providerId: SOURCE_ID[kind],
        transport: {
          async get(url: string) {
            const response = await fetch(url.startsWith('/') ? `${registry.url}${url}` : url)
            return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
          },
        },
      }
      const npm = create(npmOptions)
      assert.equal(
        (await npm.refreshCatalog({ sourceId: 'npm', requirements: [requirement('npm')] })).ok,
        true,
      )
      const npmFound = npm.discover({ query: '', cursor: null, limit: 5 })
      assert.equal(npmFound.ok, true)
      if (!npmFound.ok) throw new Error('npm package was not discovered')
      const npmItem = npmFound.value.items[0]
      assert.ok(npmItem)
      assert.equal(npmItem.digest, item.digest)
      report.npm = npmItem.digest
      await stageInterrupt(
        create,
        SOURCE_ID[kind],
        npmOptions.cacheDir,
        npmOptions,
        npmItem.locator,
        npmItem.digest,
      )

      const gitOptions: PackageSourceOptions = {
        cacheDir: join(cache, 'git'),
        gitRepositories: { origin: gitPackage.repo },
        providerId: SOURCE_ID[kind],
      }
      const gitSource = create(gitOptions)
      assert.equal(
        (await gitSource.refreshCatalog({ sourceId: 'origin', requirements: [requirement('origin')] })).ok,
        true,
      )
      const gitFound = gitSource.discover({ query: '', cursor: null, limit: 5 })
      assert.equal(gitFound.ok, true)
      if (!gitFound.ok) throw new Error('git package was not discovered')
      const gitItem = gitFound.value.items[0]
      assert.ok(gitItem)
      assert.equal(gitItem.locator.kind === 'git' ? gitItem.locator.commit : '', gitPackage.commit)
      report.git = gitItem.digest
      await stageInterrupt(
        create,
        SOURCE_ID[kind],
        gitOptions.cacheDir,
        gitOptions,
        gitItem.locator,
        gitItem.digest,
      )

      const resolver = createResolver({ cacheDir: cache, providerId: RESOLVER_ID[kind] })
      const resolved = resolver.resolve({
        requirements: [requirement('local')],
        installedLock: emptyPackageLock(),
        allowedSources: ['local'],
        platform: 'test',
        apiVersions: [],
      })
      assert.equal(resolved.ok, true)
      if (!resolved.ok) throw new Error('resolver refused a single package')
      assert.deepEqual(resolved.value.conflicts, [])
      if (lockDigest === '') lockDigest = resolved.value.lockGraph.digest
      else assert.equal(resolved.value.lockGraph.digest, lockDigest)
      assert.equal(resolver.networkReads(), 0)
      assert.equal(existsSync(join(cache, 'installed')), false)
    }
    const head = gitPackage.advance()
    assert.notEqual(head, gitPackage.commit)
    const reread = createDefaultSource({
      cacheDir: join(root, 'default', 'git'),
      gitRepositories: { origin: gitPackage.repo },
      providerId: SOURCE_ID.default,
    })
    const stable = reread.discover({ query: '', cursor: null, limit: 5 })
    assert.equal(stable.ok, true)
    if (!stable.ok) throw new Error('snapshot was not readable after head moved')
    const pinned = stable.value.items.find((entry) => entry.locator.kind === 'git')
    assert.equal(pinned?.digest, report.git)
    assert.equal(pinned?.locator.kind === 'git' ? pinned.locator.commit : '', gitPackage.commit)
    return {
      ok: true,
      sources: {
        local: { digest: report.local, reused: true, installed: false },
        npm: { digest: report.npm, verified: true, installed: false },
        git: { commit: gitPackage.commit, digest: report.git, head, installed: false },
      },
      resolvers: { digest: lockDigest, sameLock: true },
    }
  } finally {
    await Promise.all(registries.map((registry) => registry.close()))
    rmSync(root, { recursive: true, force: true })
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (invokedDirectly()) {
  runPackageAcceptance().then(
    (report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`)
      process.exitCode = report.ok ? 0 : 1
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'package acceptance failed'}\n`)
      process.exitCode = 1
    },
  )
}
