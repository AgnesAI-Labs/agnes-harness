import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPackageResolverProvider,
  emptyPackageLock,
} from '@agnes/package-manager/runtime/package-resolver'
import { createPackageSourceProvider } from '@agnes/package-manager/runtime/package-source'
import type { AssemblyGraph, ConfigResolveRequest, ReleasePlan, ReleaseSet } from '@agnes/protocol/runtime'
import {
  assemblyFixture,
  fixtureHash,
  fixtureRef,
  fixtureWire,
} from '../../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import {
  APPLIED_CONFIGURATION_KIND,
  appliedConfigurationRef,
} from '../../../src/runtime/assembly/applied-configuration.js'
import {
  assemblyGraphDigest,
  releasePlanFingerprint,
  releaseSetDigest,
} from '../../../src/runtime/assembly/release-set.js'
import { createFileConfigProvider, createSchemaCatalog } from '../../../src/runtime/providers/config.js'
import { assemblyMaintenanceContext } from './assembly-maintenance.js'

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export const producerTestContext = () => ({
  ...assemblyMaintenanceContext(),
  bindingId: 'binding:agh.assembly',
})
export const producerTestAuthority = {
  authorityId: 'fixture-state',
  tenantId: 'fixture-tenant',
  authorityEpoch: 1,
}
export function protectTree(directory: string): void {
  chmodSync(directory, 0o700)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) protectTree(path)
    else chmodSync(path, 0o600)
  }
}
export function writeProducerJson(directory: string, file: string, value: unknown) {
  writeFileSync(join(directory, file), JSON.stringify(value), { mode: 0o600 })
}

/** Real local packages/config algorithms; synthetic authority and submission ports remain test-only. */
export async function producerDeploymentFixture(directory: string) {
  const input = assemblyFixture(),
    originalRelease = input.plan.targetReleaseSet
  const uiBase = new URL('../../../../../examples/packages/runtime-ui-bundle/v1/', import.meta.url)
  const uiManifest = JSON.parse(readFileSync(new URL('agnes.plugin.json', uiBase), 'utf8'))
  const backendRoot = join(directory, 'packages/backend'),
    uiRoot = join(directory, 'packages/ui')
  const backend = join(backendRoot, 'acme.release/1.0.0')
  mkdirSync(backend, { recursive: true, mode: 0o700 })
  const bytes = Buffer.from('export const factories = {};\n')
  const schemaSource = originalRelease.schemasRef.value.schemas[0]
  if (!schemaSource) throw new Error('fixture schema missing')
  const schemaBytes = Buffer.from(JSON.stringify(schemaSource.document))
  const { clientAssets: _clientAssets, ...backendBase } = uiManifest
  const manifest = {
    ...backendBase,
    id: 'acme.release',
    packageDigest: '0'.repeat(64),
    entries: { runtime: './runtime.js' },
    schemas: [{ ref: input.configuration.preset.parameters.schema, path: './empty.schema.json' }],
    providers: originalRelease.bindings.map((row, index) => ({
      descriptor: { ...row.descriptor, packageDigest: '0'.repeat(64) },
      factory: { entry: './runtime.js', export: `factory${index}` },
    })),
    renderers: [],
    clientServices: [],
    permissions: {
      ...uiManifest.permissions,
      runtime: input.fixture.packagePermissions[0]?.capabilities ?? [],
    },
    files: [
      { path: './runtime.js', bytes: bytes.length, digest: sha(bytes) },
      { path: './empty.schema.json', bytes: schemaBytes.length, digest: sha(schemaBytes) },
    ],
  }
  fixtureWire('RuntimePluginManifest', manifest)
  writeFileSync(join(backend, 'runtime.js'), bytes)
  writeFileSync(join(backend, 'empty.schema.json'), schemaBytes)
  writeProducerJson(backend, 'agnes.plugin.json', manifest)
  cpSync(uiBase, join(uiRoot, uiManifest.id, uiManifest.version), { recursive: true })
  protectTree(join(directory, 'packages'))
  const cacheDir = join(directory, '.fixture-package-cache')
  const source = createPackageSourceProvider({
    cacheDir,
    localRoots: { 'fixture-source': backendRoot, 'fixture-ui-source': uiRoot },
  })
  const request = fixtureWire('PackageResolverResolveRequest', {
    requirements: [
      { packageId: 'acme.release', versionRange: '1.0.0', sourceIds: ['fixture-source'] },
      { packageId: uiManifest.id, versionRange: '1.0.0', sourceIds: ['fixture-ui-source'] },
    ],
    installedLock: emptyPackageLock(),
    allowedSources: ['fixture-source', 'fixture-ui-source'],
    platform: 'node',
    apiVersions: [],
  })
  for (const sourceId of request.allowedSources) {
    const refreshed = await source.refreshCatalog({ sourceId, requirements: request.requirements })
    if (!refreshed.ok || refreshed.value.diagnosticIds.length)
      throw new Error(`fixture source ${JSON.stringify(refreshed)}`)
  }
  const resolver = createPackageResolverProvider({ cacheDir })
  const resolved = resolver.resolve(request)
  if (!resolved.ok) throw new Error(resolved.detailCode)
  const catalog = createSchemaCatalog()
  for (const item of originalRelease.schemasRef.value.schemas) {
    const ref =
      item.ownerPackageId === 'acme.release'
        ? input.configuration.preset.parameters.schema
        : originalRelease.clientBundlesRef.value.bundles[0]?.schemas[0]
    if (!ref) throw new Error('fixture schema ref missing')
    const denied = catalog.admitSchema(ref, item.document)
    if (denied) throw new Error(JSON.stringify(denied))
  }
  for (const entry of resolved.value.lockGraph.entries) {
    const metadata = source.resolveMetadata({ packageId: entry.packageId, version: entry.version })
    if (!metadata.ok || metadata.value.manifestRef.kind !== 'inline')
      throw new Error('fixture metadata missing')
    const lockedManifest = fixtureWire('RuntimePluginManifest', metadata.value.manifestRef.value)
    const packaged = originalRelease.packages.find((row) => row.packageId === entry.packageId)
    if (!packaged) throw new Error('fixture release package missing')
    packaged.digest = entry.digest
    packaged.integrityRef = metadata.value.manifestRef.digest
    if (entry.packageId === 'acme.release') {
      ;(packaged as ReleaseSet['packages'][number]).entries = {
        runtime: { digest: sha(bytes), platform: 'node' },
      }
      for (const row of originalRelease.bindings) {
        const declaration = lockedManifest.providers.find(
          (item) => item.descriptor.providerId === row.binding.providerId,
        )
        if (!declaration) throw new Error('fixture descriptor missing')
        row.descriptor = structuredClone(declaration.descriptor)
        row.schemaRefs = []
        const denied = catalog.admitProvider(entry.packageId, row.descriptor)
        if (denied) throw new Error(JSON.stringify(denied))
      }
      const profilePackage = input.configuration.profile.packages[0]
      if (!profilePackage) throw new Error('fixture profile package missing')
      profilePackage.manifestDigest = metadata.value.manifestRef.digest
      profilePackage.source = { kind: 'local', path: backend, packageDigest: entry.digest }
    }
  }
  const snapshot = <T>(sourceRef: string, document: T) => ({
    source: { sourceRef, revision: 1, digest: fixtureHash(document) },
    document,
  })
  const basePreset = { ...input.configuration.preset, id: 'protected-base-preset' }
  const preset = {
    ...input.configuration.preset,
    extends: { presetId: basePreset.id, digest: fixtureHash(basePreset) },
  }
  input.configuration.preset = preset
  for (const allowed of input.configuration.profile.presets.allowed) allowed.digest = fixtureHash(preset)
  const baseProfile = { ...input.configuration.profile, id: 'protected-base-profile' }
  const profile = {
    ...input.configuration.profile,
    extends: { profileId: baseProfile.id, digest: fixtureHash(baseProfile) },
  }
  const makeRequest = (): ConfigResolveRequest =>
    fixtureWire('ConfigResolveRequest', {
      algorithm: 'agh.config/resolve-v1',
      defaults: {
        profile: snapshot('protected-default-profile', baseProfile),
        preset: snapshot('protected-default-preset', basePreset),
      },
      profiles: [snapshot('protected-profile', profile)],
      presets: [snapshot('protected-preset', preset)],
      managed: null,
      workspace: null,
      session: null,
    })
  const config = createFileConfigProvider(() => null, catalog).provider
  const configRequest = makeRequest()
  const configuration = config.resolve(configRequest)
  if (!configuration.ok) throw new Error(JSON.stringify(configuration.refusal))
  input.configuration = structuredClone(configuration.result)
  input.resolution = structuredClone(resolved.value)
  const release: ReleaseSet = structuredClone(input.plan.targetReleaseSet)
  const effective = input.plan.targetReleaseSet.configSnapshotRef
  if (
    effective.kind !== 'inline' ||
    !effective.value ||
    typeof effective.value !== 'object' ||
    Array.isArray(effective.value)
  )
    throw new Error('fixture effective config missing')
  release.profileRef = {
    id: configuration.result.profile.id,
    revision: configuration.result.profile.revision,
    digest: configuration.result.profileDigest,
    data: fixtureRef(configuration.result.profile),
  }
  release.presetRef = {
    id: configuration.result.preset.id,
    revision: configuration.result.preset.revision,
    digest: configuration.result.presetDigest,
    data: fixtureRef(configuration.result.preset),
  }
  release.configSnapshotRef = appliedConfigurationRef({
    ...effective.value,
    configuration: configuration.result,
    kind: APPLIED_CONFIGURATION_KIND,
  })
  release.releaseSetId = releaseSetDigest(release)
  input.graph.lock = resolved.value.lockGraph
  input.plan.permissionDifference.afterProfileDigest = configuration.result.profileDigest
  input.fixture.contents = []
  for (const change of input.plan.permissionDifference.policyChanges) {
    const key = change.path.slice(1) as 'policy' | 'selectionPolicy' | 'limits'
    const ref = fixtureRef(configuration.result.profile[key])
    change.after = {
      kind: 'blob',
      schema: ref.schema,
      blob: {
        authorityId: 'fixture-content',
        blobId: ref.digest,
        digest: ref.digest,
        bytes: ref.bytes,
        mediaType: 'application/json',
        pinId: ref.digest,
      },
    }
    input.fixture.contents.push({ ref: change.after, value: ref.value })
  }
  const graph: AssemblyGraph = {
    ...input.graph,
    bindings: release.bindings,
    configRef: release.configSnapshotRef,
  }
  graph.digest = assemblyGraphDigest(graph)
  const plan: ReleasePlan = {
    ...input.plan,
    targetReleaseSet: release,
    configDigest:
      release.configSnapshotRef.kind === 'inline'
        ? release.configSnapshotRef.digest
        : release.configSnapshotRef.blob.digest,
  }
  plan.planFingerprint = releasePlanFingerprint(plan)
  const policy = {
    bindingId: 'producer-run-binding',
    createdAt: input.fixture.now,
    filesystemPolicy: {
      policyId: 'protected-fs',
      digest: fixtureHash('protected-fs'),
      scope: producerTestContext().scope,
      compilerVersion: 'fixture',
      roots: [],
      rules: [],
    },
    telemetryConsent: {
      sessionId: 'fixture-session',
      level: 'LOCAL',
      sourceDigest: fixtureHash('local-consent'),
      profileId: configuration.result.profile.id,
      recordedAt: input.fixture.now,
      explicitFull: false,
      evidence: 'trusted-config',
    },
    jointDispatchDomains: [],
  }
  writeProducerJson(directory, 'release-lock.json', {
    plan,
    graph,
    directory: input.fixture.directory,
    contents: input.fixture.contents,
    qualifiedUntil: '2030-01-01T00:00:00Z',
  })
  writeProducerJson(directory, 'config-request.json', configRequest)
  writeProducerJson(directory, 'package-request.json', {
    request,
    sources: { 'fixture-source': 'packages/backend', 'fixture-ui-source': 'packages/ui' },
  })
  writeProducerJson(directory, 'binding-policy.json', policy)
  config.dispose()
  resolver.dispose()
  source.dispose()
  return {
    release,
    plan,
    graph,
    configuration: configuration.result,
    resolution: resolved.value,
    configRequest,
    policy,
    context: producerTestContext(),
    directory,
    input,
  }
}
