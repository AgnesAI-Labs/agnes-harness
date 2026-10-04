import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPackageResolverProvider } from '@agnes/package-manager/runtime/package-resolver'
import { createPackageSourceProvider } from '@agnes/package-manager/runtime/package-source'
import type {
  BindingRef,
  ConfigResolveRequest,
  ConfigResolveResult,
  PackageResolverResolveRequest,
  PackageResolverResolveResult,
  PackageSourceFetchResult,
  PackageSourceResolveMetadataResult,
  ReleaseSet,
  RunBinding,
  ScopeRef,
} from '@agnes/protocol/runtime'
import { validateOwnedAuthorSchemaSource } from '@agnes/protocol/runtime'
import { createFileConfigProvider, createSchemaCatalog } from '../providers/config.js'
import { APPLIED_CONFIGURATION_KIND, readAppliedConfiguration } from './applied-configuration.js'
import { type ResolvedReleaseInputs, readLocatorRoute } from './inputs.js'
import { array, digest, equal, fields, freeze, readContent, readWire, requireRelease } from './primitives.js'
import { ProtectedDeployment } from './protected-deployment.js'
import { validateResolvedRelease } from './release-set.js'

export const producerSourceFiles = [
  'release-lock.json',
  'config-request.json',
  'package-request.json',
  'binding-policy.json',
] as const
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

/** Fixed private facts only; the installer must supply original receipt/native source authentication. */
export interface ReleaseProducerFacts {
  configuration: { request: ConfigResolveRequest; result: ConfigResolveResult }
  packages: {
    request: PackageResolverResolveRequest
    result: PackageResolverResolveResult
    verified: {
      packageId: string
      metadata: PackageSourceResolveMetadataResult
      snapshot: PackageSourceFetchResult
    }[]
  }
  release: ReleaseSet
  binding: RunBinding
  observations: ResolvedReleaseInputs['observations']
  sourceFingerprint: string
  requiredDigests: string[]
  qualifiedUntil: string
  producer: BindingRef
  scope: ScopeRef
}

const resolvedOriginals = new WeakMap<
  ReleaseProducerFacts,
  {
    source: ReturnType<typeof readProducerDeployment>
    config: ReturnType<typeof createFileConfigProvider>['provider']
    resolver: ReturnType<typeof createPackageResolverProvider>
    packageSource: ReturnType<typeof createPackageSourceProvider>
    configurationResult: ConfigResolveResult
    packageResult: PackageResolverResolveResult
    verified: {
      packageId: string
      metadataRequest: object
      fetchRequest: object
      metadata: PackageSourceResolveMetadataResult
      snapshot: PackageSourceFetchResult
      archive: Buffer
    }[]
  }
>()

export function captureResolvedProducerSource(facts: ReleaseProducerFacts) {
  const original = resolvedOriginals.get(facts)
  requireRelease(original, 'producer_original_resolution_missing', '/publication/source')
  original.source.deployment.preClock()
  return original
}
export function releaseResolvedProducerSource(facts: ReleaseProducerFacts): void {
  const original = resolvedOriginals.get(facts)
  if (!original) return
  resolvedOriginals.delete(facts)
  original.config.dispose()
  original.resolver.dispose()
  original.packageSource.dispose()
}

export function readProducerDeployment(directory: string) {
  const deployment = new ProtectedDeployment(directory)
  const lock = fields(
    deployment.json(producerSourceFiles[0]),
    ['plan', 'graph', 'directory', 'contents', 'qualifiedUntil'],
    '/deployment/release',
  )
  const configRequest = readWire('ConfigResolveRequest', deployment.json(producerSourceFiles[1]))
  const packages = fields(
    deployment.json(producerSourceFiles[2]),
    ['request', 'sources'],
    '/deployment/packages',
  )
  const packageRequest = readWire('PackageResolverResolveRequest', packages.request)
  const policy = fields(
    deployment.json(producerSourceFiles[3]),
    ['bindingId', 'createdAt', 'filesystemPolicy', 'telemetryConsent', 'jointDispatchDomains'],
    '/deployment/binding',
  )
  const plan = readWire('ReleasePlan', lock.plan),
    graph = readWire('AssemblyGraph', lock.graph)
  const contents = array(lock.contents, '/deployment/contents').map((raw) => {
    const row = fields(raw, ['ref', 'value'], '/deployment/contents')
    return { ref: readWire('DataRef', row.ref), value: readWire('JsonValue', row.value) }
  })
  const sources = packages.sources
  requireRelease(
    sources && typeof sources === 'object' && !Array.isArray(sources),
    'package_source_missing',
    '/deployment/packages',
  )
  const roots: Record<string, string> = {}
  const relativeRoots: Record<string, string> = {}
  for (const sourceId of packageRequest.allowedSources) {
    const name = (sources as Record<string, unknown>)[sourceId]
    requireRelease(typeof name === 'string', 'package_source_missing', '/deployment/packages')
    roots[sourceId] = deployment.path(name)
    relativeRoots[sourceId] = name
    deployment.scan(name)
  }
  requireRelease(
    Object.keys(sources).length === Object.keys(roots).length,
    'package_source_mismatch',
    '/deployment/packages',
  )
  return {
    deployment,
    plan,
    graph,
    configRequest,
    packageRequest,
    policy,
    roots,
    relativeRoots,
    contents,
    directory: readLocatorRoute(lock.directory),
    qualifiedUntil: readWire('Timestamp', lock.qualifiedUntil),
    sourceFingerprint: deployment.fingerprint([...deployment.files.keys()].sort()),
  }
}

/** Resolves actual protected local sources. This does not qualify a native installer for production. */
export async function resolveProducerSource(
  source: ReturnType<typeof readProducerDeployment>,
  stateAuthority: RunBinding['stateAuthorityAtCreation'],
  now: string,
  deadline: string,
  producer: BindingRef,
  scope: ScopeRef,
): Promise<ReleaseProducerFacts> {
  const { deployment, plan, graph, configRequest, packageRequest, contents } = source
  requireRelease(
    plan.operation === 'install' &&
      source.directory.routeRevision === null &&
      source.directory.releaseSetId === null,
    'producer_initial_publication_only',
    '/deployment/release',
  )
  const release = plan.targetReleaseSet
  const cacheDir = mkdtempSync(join(deployment.root, '.release-producer-cache-'))
  const catalog = createSchemaCatalog()
  const materials = fields(
    readContent(release.schemasRef, '/schemasRef', contents),
    ['schemas', 'builtinContracts', 'contracts'],
    '/schemasRef',
  )
  const materialRefs = new Set<string>()
  const packageSchemaRefs = new Set<string>()
  for (const raw of array(materials.schemas, '/schemasRef/schemas')) {
    const row = fields(
      raw,
      ['ownerPackageId', 'name', 'typeId', 'revision', 'document'],
      '/schemasRef/schemas',
    )
    const checked = validateOwnedAuthorSchemaSource({
      ownerPackageId: readWire('Id', row.ownerPackageId),
      name: readWire('Id', row.name),
      typeId: readWire('TypeId', row.typeId),
      revision: readWire('UInt53', row.revision),
      document: readWire('JsonValue', row.document),
    })
    const refusal = catalog.admitSchema(checked.ref, row.document)
    requireRelease(!refusal, refusal?.code ?? 'schema_missing', '/schemasRef')
    materialRefs.add(digest(checked.ref))
  }
  const packageSource = createPackageSourceProvider({ cacheDir, localRoots: source.roots })
  const resolver = createPackageResolverProvider({ cacheDir })
  const config = createFileConfigProvider(() => null, catalog).provider
  let retained = false
  const originalVerified: NonNullable<ReturnType<typeof resolvedOriginals.get>>['verified'] = []
  try {
    for (const sourceId of packageRequest.allowedSources) {
      const refreshed = await packageSource.refreshCatalog({
        sourceId,
        requirements: packageRequest.requirements,
      })
      requireRelease(refreshed.ok, refreshed.ok ? '' : refreshed.detailCode, '/packages/source')
      requireRelease(
        refreshed.value.diagnosticIds.length === 0,
        'package_snapshot_invalid',
        '/packages/source',
      )
    }
    const resolved = resolver.resolve(packageRequest)
    requireRelease(resolved.ok, resolved.ok ? '' : resolved.detailCode, '/packages/resolver')
    const resolution = readWire('PackageResolverResolveResult', resolved.value)
    requireRelease(
      resolution.conflicts.length === 0 && equal(resolution.lockGraph, graph.lock),
      'package_lock_mismatch',
      '/packages/lock',
    )
    const verified: ReleaseProducerFacts['packages']['verified'] = []
    const permissions: ResolvedReleaseInputs['observations']['packagePermissions'] = []
    const codeDigests: string[] = []
    for (const entry of resolution.lockGraph.entries) {
      requireRelease(entry.locator.kind === 'local', 'package_source_not_local', '/packages/locator')
      const metadataRequest = { packageId: entry.packageId, version: entry.version }
      const metadataResult = packageSource.resolveMetadata(metadataRequest)
      requireRelease(
        metadataResult.ok,
        metadataResult.ok ? '' : metadataResult.detailCode,
        '/packages/metadata',
      )
      const metadata = readWire('PackageSourceResolveMetadataResult', metadataResult.value)
      requireRelease(
        metadata.digest === entry.digest && equal(metadata.manifestRef, entry.manifestRef),
        'package_metadata_mismatch',
        '/packages/metadata',
      )
      const manifest = readWire(
        'RuntimePluginManifest',
        readContent(metadata.manifestRef, '/packages/manifest', contents),
      )
      requireRelease(
        manifest.id === entry.packageId &&
          manifest.version === entry.version &&
          manifest.packageDigest === entry.digest,
        'package_metadata_mismatch',
        '/packages/manifest',
      )
      for (const declaration of manifest.providers) {
        const refusal = catalog.admitProvider(manifest.id, declaration.descriptor)
        requireRelease(!refusal, refusal?.code ?? 'descriptor_mismatch', '/packages/provider')
      }
      const root = source.relativeRoots[entry.locator.sourceId]
      requireRelease(root, 'package_source_missing', '/packages/source')
      const versionRoot = join(root, entry.packageId, entry.version)
      const readEntry = (path: string) => {
        requireRelease(
          path.startsWith('./') && !path.split('/').includes('..'),
          'package_entry_missing',
          '/packages/entry',
        )
        return deployment.read(join(versionRoot, path))
      }
      for (const declaration of manifest.schemas) {
        const originalSchema = JSON.parse(readEntry(declaration.path).toString('utf8'))
        const document = originalSchema.ownerPackageId
          ? validateOwnedAuthorSchemaSource(originalSchema).source.document
          : originalSchema
        const material = array(materials.schemas, '/schemasRef/schemas').find((raw) => {
          const row = fields(
            raw,
            ['ownerPackageId', 'name', 'typeId', 'revision', 'document'],
            '/schemasRef/schemas',
          )
          return row.ownerPackageId === manifest.id && row.typeId === declaration.ref.typeId
        })
        const name = readWire('Id', (material as Record<string, unknown> | undefined)?.name)
        const checked = validateOwnedAuthorSchemaSource({
          ownerPackageId: manifest.id,
          name,
          typeId: declaration.ref.typeId,
          revision: declaration.ref.revision,
          document,
        })
        requireRelease(
          equal(checked.ref, declaration.ref) &&
            array(materials.schemas, '/schemasRef/schemas').some((raw) => {
              const row = fields(
                raw,
                ['ownerPackageId', 'name', 'typeId', 'revision', 'document'],
                '/schemasRef/schemas',
              )
              return (
                row.ownerPackageId === manifest.id &&
                row.typeId === declaration.ref.typeId &&
                equal(row.document, document)
              )
            }),
          'schema_source_mismatch',
          '/packages/schema',
        )
        packageSchemaRefs.add(digest(checked.ref))
      }
      for (const file of manifest.files) {
        const bytes = readEntry(file.path)
        requireRelease(
          bytes.length === file.bytes && sha(bytes) === file.digest,
          'package_entry_digest_mismatch',
          '/packages/files',
        )
        codeDigests.push(file.digest)
      }
      const packaged = release.packages.find((pkg) => pkg.packageId === manifest.id)
      requireRelease(packaged, 'package_lock_mismatch', '/packages/release')
      for (const [name, artifact] of Object.entries(packaged.entries)) {
        const path = manifest.entries[name as keyof typeof manifest.entries]
        requireRelease(
          path && sha(readEntry(path)) === artifact.digest,
          'package_entry_digest_mismatch',
          '/packages/entry',
        )
      }
      for (const selected of release.bindings.filter(
        (row) => row.descriptor.packageDigest === entry.digest,
      )) {
        const original = manifest.providers.find(
          (row) => row.descriptor.providerId === selected.descriptor.providerId,
        )
        requireRelease(
          original && equal(original.descriptor, selected.descriptor),
          'selected_descriptor_mismatch',
          '/packages/descriptor',
        )
        const bytes = readEntry(original.factory.entry)
        requireRelease(
          Object.values(packaged.entries).some((row) => row.digest === sha(bytes)),
          'selected_code_missing',
          '/packages/code',
        )
      }
      permissions.push({ packageId: manifest.id, capabilities: manifest.permissions.runtime })
      const fetchRequest = { locator: entry.locator, expectedDigest: entry.digest }
      const snapshotResult = await packageSource.fetch(fetchRequest)
      requireRelease(
        snapshotResult.ok,
        snapshotResult.ok ? '' : snapshotResult.detailCode,
        '/packages/snapshot',
      )
      const snapshot = readWire('PackageSourceFetchResult', snapshotResult.value)
      requireRelease(
        snapshot.verifiedDigest === entry.digest,
        'package_snapshot_mismatch',
        '/packages/snapshot',
      )
      const archive = readFileSync(join(cacheDir, 'staging', entry.digest, 'archive.tar'))
      const archiveRef = snapshot.stagedPackageRef
      requireRelease(
        archiveRef.kind === 'blob' &&
          sha(archive) === archiveRef.blob.digest &&
          archive.length === archiveRef.blob.bytes,
        'producer_original_bytes_missing',
        '/packages/archive',
      )
      originalVerified.push({
        packageId: entry.packageId,
        metadataRequest,
        fetchRequest,
        metadata: metadataResult.value,
        snapshot: snapshotResult.value,
        archive,
      })
      verified.push({ packageId: entry.packageId, metadata, snapshot })
    }
    requireRelease(
      [...materialRefs].every((ref) => packageSchemaRefs.has(ref)),
      'schema_source_mismatch',
      '/packages/schema',
    )
    const configured = config.resolve(configRequest)
    requireRelease(configured.ok, configured.ok ? '' : configured.refusal.code, '/configuration/resolver')
    const configuration = readWire('ConfigResolveResult', configured.result)
    readAppliedConfiguration(release.configSnapshotRef, configuration, release.schemasRef, contents)
    for (const pkg of configuration.profile.packages.filter((row) => row.enabled)) {
      const entry = resolution.lockGraph.entries.find((row) => row.packageId === pkg.id)
      requireRelease(
        entry &&
          pkg.source.kind === 'local' &&
          entry.locator.kind === 'local' &&
          pkg.source.packageDigest === entry.digest &&
          pkg.manifestDigest ===
            (entry.manifestRef.kind === 'inline'
              ? entry.manifestRef.digest
              : entry.manifestRef.blob.digest) &&
          pkg.source.path ===
            join(source.roots[entry.locator.sourceId] ?? '', entry.packageId, entry.version),
        'configuration_package_mismatch',
        '/configuration/packages',
      )
    }
    const observations: ResolvedReleaseInputs['observations'] = {
      now: readWire('Timestamp', now),
      contents,
      previousRelease: null,
      previousConfiguration: null,
      directory: source.directory,
      jointDomains: [],
      migrations: [],
      packagePermissions: permissions,
    }
    validateResolvedRelease(
      { plan, graph, configuration, resolution, observations },
      APPLIED_CONFIGURATION_KIND,
      configRequest,
    )
    const minimumRecovery =
      configuration.profile.policy.minimumRecovery >
      (configuration.preset.restrictions.minimumRecovery ?? 'R0')
        ? configuration.profile.policy.minimumRecovery
        : (configuration.preset.restrictions.minimumRecovery ?? 'R0')
    const binding = readWire('RunBinding', {
      ...source.policy,
      releaseSetId: release.releaseSetId,
      profileDigest: configuration.profileDigest,
      presetDigest: configuration.presetDigest,
      minimumRecovery,
      stateAuthorityAtCreation: stateAuthority,
      providers: release.bindings,
    })
    requireRelease(
      equal(binding.jointDispatchDomains, observations.jointDomains),
      'joint_dispatch_incompatible',
      '/binding',
    )
    requireRelease(
      equal(binding.filesystemPolicy.scope, scope) &&
        release.bindings.some(
          (row) => equal(row.binding, producer) && row.descriptor.contract === 'agh.assembly',
        ),
      'producer_binding_mismatch',
      '/publication/producer',
    )
    const qualifiedUntil = [source.qualifiedUntil, plan.expiresAt, deadline].sort(
      (a, b) => Date.parse(a) - Date.parse(b),
    )[0]
    requireRelease(
      qualifiedUntil &&
        Date.parse(qualifiedUntil) > Date.parse(now) &&
        Date.parse(binding.createdAt) <= Date.parse(now),
      'producer_qualification_expired',
      '/publication',
    )
    deployment.preClock()
    const fixed = {
      configuration: { request: configRequest, result: configuration },
      packages: { request: packageRequest, result: resolution, verified },
      release,
      binding,
      observations,
      sourceFingerprint: source.sourceFingerprint,
      qualifiedUntil,
      producer,
      scope,
    }
    const requiredDigests = new Set<string>()
    // Raw verified asset inventory only; the native issuer computes the official exact Digest set.
    for (const pkg of release.packages) requiredDigests.add(pkg.digest)
    for (const d of codeDigests) requiredDigests.add(d)
    for (const row of deployment.files.values()) requiredDigests.add(sha(row.bytes))
    const facts = freeze({ ...fixed, requiredDigests: [...requiredDigests].sort() })
    resolvedOriginals.set(facts, {
      source,
      config,
      resolver,
      packageSource,
      configurationResult: configured.result,
      packageResult: resolved.value,
      verified: originalVerified,
    })
    retained = true
    return facts
  } finally {
    if (!retained) {
      config.dispose()
      resolver.dispose()
      packageSource.dispose()
    }
  }
}
