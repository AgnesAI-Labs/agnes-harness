import { createHash } from 'node:crypto'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import { type GeneratedAuthorSchemaSource, type JsonValue, validateRuntime } from '@agnes/protocol/runtime'
import {
  assemblyFixture,
  fixtureWire,
} from '../../../../extension-api/testkit/runtime/contracts/assembly-fixture.js'
import {
  type AppliedPublicationSource,
  encodePublicationPayload,
  type PublicationContentBytes,
  publicationRequiredDigests,
  type RetainedPublicationContent,
} from '../../../src/runtime/maintenance/publication-codecs.js'

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown) => jcs(fixtureWire('JsonValue', value))
function exactShape(value: JsonValue): JsonValue {
  if (value === null) return { type: 'null' }
  if (typeof value === 'string') return { type: 'string', maxLength: 65536 }
  if (typeof value === 'number') return { type: 'number' }
  if (typeof value === 'boolean') return { type: 'boolean' }
  if (Array.isArray(value)) {
    const alternatives = [
      ...new Map(
        value.map((child) => {
          const schema = exactShape(child)
          return [canonical(schema), schema]
        }),
      ).values(),
    ]
    return {
      type: 'array',
      minItems: value.length,
      maxItems: Math.max(1, value.length),
      items:
        alternatives.length === 0
          ? { type: 'null' }
          : alternatives.length === 1
            ? (alternatives[0] ?? { type: 'null' })
            : { anyOf: alternatives },
    }
  }
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, exactShape(child)])),
    required: Object.keys(value),
    additionalProperties: false,
  }
}
function generated(name: string, value: unknown) {
  const source: GeneratedAuthorSchemaSource = {
    ownerPackageId: 'codec.fixture',
    name,
    typeId: `codec.fixture/${name.toLowerCase()}@1`,
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: `#/$defs/${name}`,
      $defs: { [name]: exactShape(fixtureWire('JsonValue', value)) },
    },
  }
  const codec = defineGeneratedAuthorSchema<JsonValue>(source)
  const ref = codec.encode(fixtureWire('JsonValue', value))
  if (!ref.ok) throw new Error(ref.error.detailCode)
  return { source, ref: ref.value }
}
/** Synthetic byte/official DTO consistency only; no installation, current identity, or publication. */
export function publicationCodecFixture() {
  const input = assemblyFixture()
  const plan = fixtureWire('ReleasePlan', input.plan)
  const graph = fixtureWire('AssemblyGraph', input.graph)
  const empty = generated('Empty', {})
  const selected = plan.targetReleaseSet.bindings.find((row) => row.binding.contract === 'agh.assembly')
  if (!selected) throw new Error('assembly binding missing')
  selected.descriptor.configSchema = empty.ref.schema
  selected.config = empty.ref
  selected.configDigest = empty.ref.kind === 'inline' ? empty.ref.digest : empty.ref.blob.digest
  const packageId = 'acme.release'
  const code = Buffer.from('export const assembly = {}\n')
  const schemaBytes = Buffer.from(canonical(empty.source))
  const tree = selected.descriptor.packageDigest
  const manifest = fixtureWire('RuntimePluginManifest', {
    $schema: 'https://agnes.ai/schema/runtime/v1/plugin-manifest.schema.json',
    kind: 'agh.plugin',
    schemaVersion: '1.0',
    id: packageId,
    version: '1.0.0',
    runtimeApiMajor: 1,
    packageDigest: tree,
    entries: { runtime: './runtime.js' },
    schemas: [{ ref: empty.ref.schema, path: './empty.json' }],
    providers: [{ descriptor: selected.descriptor, factory: { entry: './runtime.js', export: 'assembly' } }],
    domains: [],
    tools: [],
    renderers: [],
    clientServices: [],
    permissions: { runtime: [], web: [], tui: [], im: [], sdk: [] },
    dependencies: [],
    files: [
      { path: './runtime.js', digest: hash(code), bytes: code.length },
      { path: './empty.json', digest: hash(schemaBytes), bytes: schemaBytes.length },
    ],
    build: {
      generatorVersion: '1.0.0',
      sourceDigest: tree,
      authorDefinitionDigest: tree,
      reproducible: true,
    },
  })
  const manifested = generated('Manifest', manifest)
  input.resolution.lockGraph.entries = [
    fixtureWire('PackageLockEntry', {
      ...input.resolution.lockGraph.entries[0],
      packageId,
      version: '1.0.0',
      digest: tree,
      dependencies: [],
      manifestRef: manifested.ref,
    }),
  ]
  plan.permissionDifference.policyChanges = []
  const release = plan.targetReleaseSet
  release.packages = [
    {
      packageId,
      version: '1.0.0',
      digest: tree,
      sourceRef: 'source',
      integrityRef: 'integrity',
      entries: { backend: { digest: hash(code), platform: 'node' } },
    },
  ]
  release.bindings = [selected]
  const profileData = generated('Profile', input.configuration.profile)
  const presetData = generated('Preset', input.configuration.preset)
  release.profileRef = { ...release.profileRef, data: profileData.ref }
  release.presetRef = { ...release.presetRef, data: presetData.ref }
  release.configSnapshotRef = empty.ref
  release.schemasRef = empty.ref
  release.clientBundlesRef = empty.ref
  release.recoveryManifestRef = empty.ref
  release.resourceClaimsRef = empty.ref
  graph.bindings = [selected]
  graph.lock = input.resolution.lockGraph
  graph.configRef = empty.ref
  graph.dependencies = []
  const profile = {
    source: { sourceRef: 'profile', revision: 1, digest: hash(canonical(input.configuration.profile)) },
    document: input.configuration.profile,
  }
  const preset = {
    source: { sourceRef: 'preset', revision: 1, digest: hash(canonical(input.configuration.preset)) },
    document: input.configuration.preset,
  }
  const configRequest = fixtureWire('ConfigResolveRequest', {
    algorithm: 'agh.config/resolve-v1',
    defaults: { profile, preset },
    profiles: [profile],
    presets: [preset],
    managed: null,
    workspace: null,
    session: null,
  })
  const state = { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 }
  const scope = { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' }
  const binding = fixtureWire('RunBinding', {
    bindingId: 'run-binding',
    releaseSetId: release.releaseSetId,
    profileDigest: input.configuration.profileDigest,
    presetDigest: input.configuration.presetDigest,
    createdAt: '2026-10-04T00:00:00Z',
    minimumRecovery: 'R0',
    stateAuthorityAtCreation: state,
    providers: [selected],
    filesystemPolicy: { policyId: 'policy', digest: tree, scope, compilerVersion: '1', roots: [], rules: [] },
    telemetryConsent: {
      sessionId: 'session',
      level: 'LOCAL',
      sourceDigest: tree,
      profileId: input.configuration.profile.id,
      recordedAt: '2026-10-04T00:00:00Z',
      explicitFull: false,
      evidence: 'trusted-config',
    },
    jointDispatchDomains: [],
  })
  const rows: RetainedPublicationContent[] = [],
    contents: PublicationContentBytes[] = []
  function retain(
    role: string,
    value: unknown,
    packageId: string | null = null,
    path: string | null = null,
    schemaJson: string | null = null,
    kind: 'json' | 'bytes' = 'json',
  ) {
    const body =
      kind === 'bytes' && value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(canonical(value))
    const digest = hash(body)
    rows.push({ role, kind, digest, bytes: body.length, packageId, path, schemaJson })
    if (!contents.some((row) => row.kind === kind && row.digest === digest))
      contents.push({ kind, digest, body })
  }
  retain('config-request', configRequest)
  retain('config-result', input.configuration)
  retain('package-request', {
    requirements: [],
    installedLock: input.resolution.lockGraph,
    allowedSources: ['fixture-source'],
    platform: 'node',
    apiVersions: [],
  })
  retain('package-result', input.resolution)
  retain('release-plan', plan)
  retain('release-set', release)
  retain('run-binding', binding)
  retain('assembly-graph', graph)
  retain('package-manifest', manifest, packageId)
  retain(
    'package-metadata',
    {
      manifestRef: manifested.ref,
      digest: tree,
      provenance: { sourceRefs: ['source'], producer: selected.binding, trustLabels: [] },
    },
    packageId,
  )
  retain('package-fetch', { stagedPackageRef: empty.ref, verifiedDigest: tree }, packageId)
  retain(
    'schema-source',
    profileData.source,
    'codec.fixture',
    profileData.ref.schema.typeId,
    canonical(profileData.ref.schema),
  )
  retain(
    'schema-source',
    presetData.source,
    'codec.fixture',
    presetData.ref.schema.typeId,
    canonical(presetData.ref.schema),
  )
  retain('schema-source', empty.source, 'codec.fixture', empty.ref.schema.typeId, canonical(empty.ref.schema))
  retain(
    'schema-source',
    manifested.source,
    'codec.fixture',
    manifested.ref.schema.typeId,
    canonical(manifested.ref.schema),
  )
  retain('package-file', code, packageId, './runtime.js', null, 'bytes')
  retain('package-file', schemaBytes, packageId, './empty.json', null, 'bytes')
  retain('protected-config', configRequest, null, 'config-request.json', null, 'bytes')
  const packageRequest = JSON.parse(
    contents
      .find((row) => row.digest === rows.find((row) => row.role === 'package-request')?.digest)
      ?.body.toString() ?? 'null',
  )
  retain(
    'protected-package',
    { request: packageRequest, sources: { 'fixture-source': 'packages' } },
    null,
    'package-request.json',
    null,
    'bytes',
  )
  retain(
    'protected-lock',
    {
      plan: plan,
      graph: graph,
      directory: input.fixture.directory,
      contents: [],
      qualifiedUntil: '2026-10-04T00:01:00Z',
    },
    null,
    'release-lock.json',
    null,
    'bytes',
  )
  retain(
    'protected-policy',
    {
      bindingId: binding.bindingId,
      createdAt: binding.createdAt,
      filesystemPolicy: binding.filesystemPolicy,
      telemetryConsent: binding.telemetryConsent,
      jointDispatchDomains: [],
    },
    null,
    'binding-policy.json',
    null,
    'bytes',
  )
  const pointerToken = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
  function references(value: JsonValue, pointer: string, owner: string | null): void {
    if (value === null || typeof value !== 'object') return
    const result = validateRuntime('DataRef', value)
    if (result.ok) {
      if (result.value.kind !== 'inline') throw new Error('Fixture requires original inline bytes')
      retain('referenced-json', result.value.value, owner, pointer, canonical(result.value.schema))
      references(result.value.value, `${pointer}/value`, owner)
      return
    }
    for (const [key, child] of Object.entries(value))
      references(child, `${pointer}/${pointerToken(key)}`, owner)
  }
  for (const row of [...rows]) {
    if (row.role === 'schema-source' || row.role === 'package-file') continue
    const retained = contents.find((content) => content.kind === row.kind && content.digest === row.digest)
    if (!retained) throw new Error('Original fixture bytes are missing')
    references(
      fixtureWire('JsonValue', JSON.parse(Buffer.from(retained.body).toString())),
      `/retained/${pointerToken(canonical([row.role, row.packageId, row.path]))}`,
      row.packageId,
    )
  }
  rows.sort((a, b) => {
    for (const key of ['role', 'packageId', 'path'] as const) {
      if (a[key] !== b[key])
        return a[key] === null
          ? -1
          : b[key] === null
            ? 1
            : Buffer.compare(Buffer.from(a[key] ?? ''), Buffer.from(b[key] ?? ''))
    }
    return 0
  })
  const at = '2026-10-04T00:00:00Z'
  const source: AppliedPublicationSource = {
    formatVersion: 1,
    transactionId: `publish:${release.releaseSetId}`,
    maintenanceAuthorityJson: canonical(state),
    stateAuthorityJson: canonical(state),
    producerJson: canonical(selected.binding),
    scopeJson: canonical(scope),
    issuerCodeDigest: hash(code),
    releaseSetId: release.releaseSetId,
    bindingId: binding.bindingId,
    planDigest: hash(canonical(plan)),
    sourceFingerprint: tree,
    observedAt: at,
    contextDeadline: '2026-10-04T00:02:00Z',
    identityExpiresAt: '2026-10-04T00:03:00Z',
    planExpiresAt: plan.expiresAt,
    protectedUntil: '2026-10-04T00:01:00Z',
    qualifiedUntil: '2026-10-04T00:01:00Z',
    memberFingerprints: [tree, tree, tree],
    content: rows,
    requiredDigests: [],
  }
  fixtureWire('ReleaseSet', release)
  const values = [
    encodePublicationPayload('head', {
      directoryJson: canonical({
        ...input.fixture.directory,
        routeRevision: 1,
        releaseSetId: release.releaseSetId,
      }),
      jointDomainsJson: '[]',
      migrationsJson: '[]',
      stateAuthorityRefJson: canonical(state),
    }),
    encodePublicationPayload('route', {
      routeId: plan.routeId,
      activeReleaseSetId: release.releaseSetId,
      authorityEpoch: 1,
      cutoverId: source.transactionId,
    }),
    encodePublicationPayload('release', {
      canonicalJson: canonical(release),
      contentDigest: hash(canonical(release)),
    }),
  ]
  const request = fixtureWire('MaintenanceStoreCommitRequest', {
    transactionId: source.transactionId,
    authority: state,
    expectedWriterEpoch: 1,
    mutations: values.map((ref, i) => {
      if (ref.kind !== 'inline') throw new Error('inline required')
      const recordId = ['current-head', `release-route:${plan.routeId}`, `release:${release.releaseSetId}`][i]
      return {
        recordId,
        expectedRevision: null,
        next: {
          recordId,
          revision: 1,
          writerEpoch: 1,
          createdAt: at,
          updatedAt: at,
          schema: ref.schema,
          payload: ref.value,
          fingerprint: ref.digest,
        },
      }
    }),
    outbox: [],
  })
  source.memberFingerprints = request.mutations.map((row) => hash(canonical(row)))
  source.requiredDigests = [...publicationRequiredDigests(source, contents)]
  return { source, contents, request, release, binding, manifest, empty, manifested }
}
