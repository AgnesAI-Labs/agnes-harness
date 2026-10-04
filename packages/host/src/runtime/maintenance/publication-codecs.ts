import { createHash } from 'node:crypto'
import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type DataRef,
  type JsonValue,
  type MaintenanceStoreCommitRequest,
  RuntimeSchemaRefs,
  RuntimeSchemas,
  type RuntimeWireTypes,
  validateOwnedAuthorSchemaSource,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { readLocatorRoute } from '../assembly/inputs.js'
import { equal, readWire, requireRelease } from '../assembly/primitives.js'
import {
  appliedSourceSource,
  currentHeadSource,
  releaseRouteSource,
  releaseSnapshotSource,
} from './publication-schema-sources.js'

interface CurrentHead {
  directoryJson: string
  jointDomainsJson: string
  migrationsJson: '[]'
  stateAuthorityRefJson: string
}
interface ReleaseRoute {
  routeId: string
  activeReleaseSetId: string
  authorityEpoch: number
  cutoverId: string
}
interface ReleaseSnapshot {
  canonicalJson: string
  contentDigest: string
}
export interface RetainedPublicationContent {
  role: string
  kind: 'json' | 'bytes'
  digest: string
  bytes: number
  packageId: string | null
  path: string | null
  schemaJson: string | null
}
export interface AppliedPublicationSource {
  formatVersion: 1
  transactionId: string
  maintenanceAuthorityJson: string
  stateAuthorityJson: string
  producerJson: string
  scopeJson: string
  issuerCodeDigest: string
  releaseSetId: string
  bindingId: string
  planDigest: string
  sourceFingerprint: string
  observedAt: string
  contextDeadline: string
  identityExpiresAt: string
  planExpiresAt: string
  protectedUntil: string | null
  qualifiedUntil: string
  memberFingerprints: string[]
  content: RetainedPublicationContent[]
  requiredDigests: string[]
}
interface Payloads {
  head: CurrentHead
  route: ReleaseRoute
  release: ReleaseSnapshot
  source: AppliedPublicationSource
}
export type PublicationPayloadKind = keyof Payloads
const outerCodecs = {
  head: defineGeneratedAuthorSchema<CurrentHead>(currentHeadSource),
  route: defineGeneratedAuthorSchema<ReleaseRoute>(releaseRouteSource),
  release: defineGeneratedAuthorSchema<ReleaseSnapshot>(releaseSnapshotSource),
  source: defineGeneratedAuthorSchema<AppliedPublicationSource>(appliedSourceSource),
}
export const publicationSchemaRefs = Object.freeze({
  head: outerCodecs.head.ref,
  route: outerCodecs.route.ref,
  release: outerCodecs.release.ref,
  source: outerCodecs.source.ref,
})
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const canonical = (value: unknown) => jcs(readWire('JsonValue', value))
const jsonDigest = (value: unknown) => hash(canonical(value))
function check(condition: unknown, path: string): asserts condition {
  requireRelease(condition, 'publication_content_invalid', path)
}
function readJson(text: string): JsonValue {
  const value = readWire('JsonValue', JSON.parse(text))
  check(jcs(value) === text, '/canonicalJson')
  return value
}
function inner<K extends keyof RuntimeWireTypes>(name: K, text: string): RuntimeWireTypes[K] {
  return readWire(name, readJson(text))
}
function dig(value: string): void {
  readWire('Digest', value)
  check(/^[a-f0-9]{64}$/.test(value), '/digest')
}
function timestamp(value: string): number {
  readWire('Timestamp', value)
  const at = Date.parse(value)
  check(Number.isFinite(at), '/timestamp')
  return at
}
function location(row: RetainedPublicationContent): string {
  return canonical([row.role, row.packageId, row.path])
}
function validateSource(source: AppliedPublicationSource): void {
  readWire('Id', source.transactionId)
  readWire('Id', source.releaseSetId)
  readWire('Id', source.bindingId)
  check(
    new Set(
      source.content
        .filter((row) => row.packageId !== null && row.role === 'package-manifest')
        .map((row) => row.packageId),
    ).size <= 32,
    '/packages/size',
  )
  const authority = inner('StateAuthorityRef', source.maintenanceAuthorityJson)
  const state = inner('StateAuthorityRef', source.stateAuthorityJson)
  const producer = inner('BindingRef', source.producerJson)
  const scope = inner('ScopeRef', source.scopeJson)
  check(authority.tenantId === state.tenantId && producer.contract === 'agh.assembly', '/producer')
  check(scope.kind === 'runtime' || scope.kind === 'workspace' || scope.kind === 'session', '/scope')
  for (const value of [source.planDigest, source.sourceFingerprint, source.issuerCodeDigest]) dig(value)
  check(source.transactionId === `publish:${source.releaseSetId}`, '/transactionId')
  // The initial local publication has a real protected deadline, not an unavailable source.
  check(source.protectedUntil !== null, '/protectedUntil')
  const original = [
    source.contextDeadline,
    source.identityExpiresAt,
    source.planExpiresAt,
    source.protectedUntil,
  ]
  const until = Math.min(...original.map(timestamp))
  check(timestamp(source.qualifiedUntil) === until && timestamp(source.observedAt) < until, '/qualifiedUntil')
  for (const value of source.memberFingerprints) dig(value)
  const digests = source.requiredDigests
  digests.forEach(dig)
  check(equal(digests, [...new Set(digests)].sort()), '/requiredDigests')
  const locations = source.content.map(location)
  check(
    new Set(locations).size === locations.length &&
      equal(source.content, [...source.content].sort(compareLocations)),
    '/content/order',
  )
  let total = 0
  const retained = new Set<string>()
  for (const row of source.content) {
    dig(row.digest)
    if (row.packageId !== null) readWire('Id', row.packageId)
    if (row.schemaJson !== null) inner('SchemaRef', row.schemaJson)
    check(row.kind !== 'json' || row.bytes <= 1048576, '/content/bytes')
    if (row.path !== null && row.role !== 'referenced-json')
      check(!row.path.startsWith('/') && !row.path.split(/[\\/]/).includes('..'), '/content/path')
    const key = `${row.kind}:${row.digest}`
    if (!retained.has(key)) {
      total += row.bytes
      retained.add(key)
    }
  }
  check(total <= 67108864, '/content/total')
}

/** Validates immutable data; it does not prove a selected issuer, permission, or a database commit. */
export function readPublicationPayload<K extends PublicationPayloadKind>(
  kind: K,
  value: unknown,
): Payloads[K] {
  check(Buffer.byteLength(canonical(value)) <= 65536, '/payload/bytes')
  if (kind === 'head') {
    const parsed = outerCodecs.head.parse(value)
    requireRelease(parsed.ok, 'publication_schema_invalid', '/head')
    const directory = readLocatorRoute(readJson(parsed.value.directoryJson))
    check(directory.routeRevision === 1 && directory.releaseSetId !== null, '/head/directory')
    const domains = readJson(parsed.value.jointDomainsJson)
    check(Array.isArray(domains), '/head/domains')
    const ids = domains.map((row) => readWire('DispatchAtomicDomain', row).domainId)
    check(new Set(ids).size === ids.length, '/head/domains')
    inner('StateAuthorityRef', parsed.value.stateAuthorityRefJson)
    return parsed.value as Payloads[K]
  }
  if (kind === 'route') {
    const parsed = outerCodecs.route.parse(value)
    requireRelease(parsed.ok, 'publication_schema_invalid', '/route')
    for (const id of [parsed.value.routeId, parsed.value.activeReleaseSetId, parsed.value.cutoverId])
      readWire('Id', id)
    readWire('UInt53', parsed.value.authorityEpoch)
    return parsed.value as Payloads[K]
  }
  if (kind === 'release') {
    const parsed = outerCodecs.release.parse(value)
    requireRelease(parsed.ok, 'publication_schema_invalid', '/release')
    inner('ReleaseSet', parsed.value.canonicalJson)
    dig(parsed.value.contentDigest)
    check(hash(parsed.value.canonicalJson) === parsed.value.contentDigest, '/release/digest')
    return parsed.value as Payloads[K]
  }
  const parsed = outerCodecs.source.parse(value)
  requireRelease(parsed.ok, 'publication_schema_invalid', '/source')
  validateSource(parsed.value)
  return parsed.value as Payloads[K]
}
export function encodePublicationPayload<K extends PublicationPayloadKind>(
  kind: K,
  value: Payloads[K],
): DataRef {
  const fixed = readPublicationPayload(kind, value)
  // Every encoder consumes its matching complete decoder before the original generated encoder.
  const codec = outerCodecs[kind]
  const encoded = codec.encode(
    fixed as CurrentHead & ReleaseRoute & ReleaseSnapshot & AppliedPublicationSource,
  )
  requireRelease(encoded.ok, 'publication_inline_budget', `/${kind}`)
  return encoded.value
}
export function readPublicationDataRef<K extends PublicationPayloadKind>(
  kind: K,
  value: unknown,
): Payloads[K] {
  const ref = readWire('DataRef', value)
  check(ref.kind === 'inline' && equal(ref.schema, publicationSchemaRefs[kind]), '/schema')
  check(
    ref.digest === jsonDigest(ref.value) && ref.bytes === Buffer.byteLength(canonical(ref.value)),
    '/dataRef',
  )
  check(ref.bytes <= 65536, '/dataRef/bytes')
  return readPublicationPayload(kind, ref.value)
}
export function publicationSourceDigest(source: AppliedPublicationSource): string {
  return jsonDigest({
    schema: publicationSchemaRefs.source,
    payload: readPublicationPayload('source', source),
  })
}

const singleRoles = [
  'config-request',
  'config-result',
  'package-request',
  'package-result',
  'release-plan',
  'release-set',
  'run-binding',
  'assembly-graph',
  'protected-config',
  'protected-package',
  'protected-lock',
  'protected-policy',
] as const
const jsonRoles = {
  'config-request': 'ConfigResolveRequest',
  'config-result': 'ConfigResolveResult',
  'package-request': 'PackageResolverResolveRequest',
  'package-result': 'PackageResolverResolveResult',
  'package-metadata': 'PackageSourceResolveMetadataResult',
  'package-fetch': 'PackageSourceFetchResult',
  'package-manifest': 'RuntimePluginManifest',
  'release-plan': 'ReleasePlan',
  'release-set': 'ReleaseSet',
  'run-binding': 'RunBinding',
  'assembly-graph': 'AssemblyGraph',
} as const satisfies Partial<Record<string, keyof RuntimeWireTypes>>
export interface PublicationContentBytes {
  readonly kind: 'json' | 'bytes'
  readonly digest: string
  readonly body: Uint8Array
}
/** Full bytes and references are required. Successful decoding is not provenance or current authority. */
export function verifyPublicationContents(
  sourceValue: unknown,
  requestValue: unknown,
  contentBytes: readonly PublicationContentBytes[],
) {
  const source = readPublicationPayload('source', sourceValue)
  const request = readWire('MaintenanceStoreCommitRequest', requestValue)
  const pool = new Map<string, Buffer>()
  for (const row of contentBytes) {
    check(row.body instanceof Uint8Array, '/contents/body')
    const bytes = Buffer.from(row.body)
    check(hash(bytes) === row.digest && !pool.has(`${row.kind}:${row.digest}`), '/contents/digest')
    pool.set(`${row.kind}:${row.digest}`, bytes)
  }
  const decoded = new Map<string, JsonValue>()
  for (const row of source.content) {
    const body = pool.get(`${row.kind}:${row.digest}`)
    check(body && body.length === row.bytes, '/contents/missing')
    if (row.kind === 'json') {
      const text = body.toString('utf8')
      check(Buffer.from(text).equals(body), '/contents/utf8')
      const json = readJson(text)
      if (Object.hasOwn(jsonRoles, row.role)) readWire(jsonRoles[row.role as keyof typeof jsonRoles], json)
      decoded.set(location(row), json)
    } else if (row.role.startsWith('protected-')) {
      const text = body.toString('utf8')
      check(Buffer.from(text).equals(body), '/contents/utf8')
      decoded.set(location(row), readWire('JsonValue', JSON.parse(text)))
    }
  }
  check(
    pool.size === new Set(source.content.map((row) => `${row.kind}:${row.digest}`)).size,
    '/contents/extra',
  )
  function role(name: string, packageId: string | null = null, path: string | null = null): JsonValue {
    const rows = source.content.filter(
      (row) => row.role === name && row.packageId === packageId && row.path === path,
    )
    check(rows.length === 1 && rows[0], `/content/${name}`)
    const value = decoded.get(location(rows[0]))
    check(value !== undefined, `/content/${name}`)
    return value
  }
  for (const name of singleRoles) {
    const rows = source.content.filter((row) => row.role === name)
    check(rows.length === 1 && rows[0]?.packageId === null, `/content/${name}`)
    const row = rows[0]
    check(row !== undefined, '/content')
    if (name.startsWith('protected-'))
      check(row.kind === 'bytes' && row.schemaJson === null, '/content/protected')
    else check(row.kind === 'json' && row.path === null && row.schemaJson === null, '/content/json')
  }
  const configuration = readWire('ConfigResolveResult', role('config-result'))
  const configRequest = readWire('ConfigResolveRequest', role('config-request'))
  const packages = readWire('PackageResolverResolveResult', role('package-result'))
  const plan = readWire('ReleasePlan', role('release-plan'))
  const release = readWire('ReleaseSet', role('release-set'))
  const binding = readWire('RunBinding', role('run-binding'))
  const graph = readWire('AssemblyGraph', role('assembly-graph'))
  check(plan.operation === 'install' && plan.expectedRouteRevision === null, '/plan')
  check(equal(plan.targetReleaseSet, release) && jsonDigest(plan) === source.planDigest, '/plan/digest')
  check(
    configuration.status === 'candidate' &&
      binding.profileDigest === configuration.profileDigest &&
      binding.presetDigest === configuration.presetDigest,
    '/configuration',
  )
  check(
    binding.bindingId === source.bindingId &&
      binding.releaseSetId === release.releaseSetId &&
      source.releaseSetId === release.releaseSetId,
    '/binding',
  )
  check(
    equal(binding.stateAuthorityAtCreation, inner('StateAuthorityRef', source.stateAuthorityJson)) &&
      equal(binding.providers, release.bindings),
    '/binding/authority',
  )
  check(equal(binding.filesystemPolicy.scope, inner('ScopeRef', source.scopeJson)), '/binding/scope')
  const producer = inner('BindingRef', source.producerJson)
  check(
    release.bindings.some((row) => equal(row.binding, producer)),
    '/producer/selection',
  )
  check(
    equal(graph.lock, packages.lockGraph) && packages.conflicts.length === 0 && release.packages.length <= 32,
    '/packages',
  )
  check(timestamp(plan.expiresAt) === timestamp(source.planExpiresAt), '/plan/expiry')
  verifyProtected(source, pool, configRequest, plan, graph, binding)
  verifyPackages(source, role, pool, packages, release)
  verifyMembers(source, request, plan.routeId, release)
  const head = request.mutations[0]
  check(
    head &&
      equal(
        readJson(readPublicationPayload('head', head.next.payload).jointDomainsJson),
        binding.jointDispatchDomains,
      ),
    '/members/domains',
  )
  check(
    release.profileRef.digest === configuration.profileDigest &&
      release.presetRef.digest === configuration.presetDigest,
    '/configuration/refs',
  )
  check(
    equal(graph.configRef, release.configSnapshotRef) && equal(graph.bindings, release.bindings),
    '/graph/selection',
  )
  verifyReferencedContents(source, decoded)
  const needed = collectRequiredDigests(source, decoded, release)
  check(equal(source.requiredDigests, [...needed].sort()), '/requiredDigests/exact')
  return Object.freeze({ source, request, configuration, packages, plan, release, binding, graph })
}
function verifyProtected(
  source: AppliedPublicationSource,
  pool: ReadonlyMap<string, Buffer>,
  config: RuntimeWireTypes['ConfigResolveRequest'],
  plan: RuntimeWireTypes['ReleasePlan'],
  graph: RuntimeWireTypes['AssemblyGraph'],
  binding: RuntimeWireTypes['RunBinding'],
) {
  const paths = {
    'protected-config': 'config-request.json',
    'protected-package': 'package-request.json',
    'protected-lock': 'release-lock.json',
    'protected-policy': 'binding-policy.json',
  } as const
  function raw(role: keyof typeof paths, names?: string[]): JsonValue {
    const row = source.content.find((item) => item.role === role)
    check(row?.path === paths[role], '/protected/path')
    const bytes = pool.get(`bytes:${row.digest}`)
    check(bytes, '/protected/missing')
    const text = bytes.toString('utf8')
    check(Buffer.from(text).equals(bytes), '/protected/utf8')
    const value = readWire('JsonValue', JSON.parse(text))
    if (names) {
      check(value !== null && typeof value === 'object' && !Array.isArray(value), '/protected/object')
      check(equal(Object.keys(value).sort(), [...names].sort()), '/protected/fields')
    }
    return value
  }
  check(equal(readWire('ConfigResolveRequest', raw('protected-config')), config), '/protected/config')
  const packages = raw('protected-package', ['request', 'sources'])
  const lock = raw('protected-lock', ['plan', 'graph', 'directory', 'contents', 'qualifiedUntil'])
  const policy = raw('protected-policy', [
    'bindingId',
    'createdAt',
    'filesystemPolicy',
    'telemetryConsent',
    'jointDispatchDomains',
  ])
  check(packages && typeof packages === 'object' && !Array.isArray(packages), '/protected/package')
  const original = source.content.find((row) => row.role === 'package-request')
  check(
    original && jsonDigest(readWire('PackageResolverResolveRequest', packages.request)) === original.digest,
    '/protected/package',
  )
  check(lock && typeof lock === 'object' && !Array.isArray(lock), '/protected/lock')
  check(
    equal(readWire('ReleasePlan', lock.plan), plan) && equal(readWire('AssemblyGraph', lock.graph), graph),
    '/protected/lock',
  )
  check(
    timestamp(readWire('Timestamp', lock.qualifiedUntil)) === timestamp(source.protectedUntil ?? ''),
    '/protected/expiry',
  )
  check(Array.isArray(lock.contents), '/protected/contents')
  for (const value of lock.contents) {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), '/protected/content')
    check(equal(Object.keys(value).sort(), ['ref', 'value']), '/protected/content/fields')
    const ref = readWire('DataRef', value.ref)
    const original = readWire('JsonValue', value.value)
    const digest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
    const bytes = Buffer.from(canonical(original))
    check(
      hash(bytes) === digest && bytes.length === (ref.kind === 'inline' ? ref.bytes : ref.blob.bytes),
      '/protected/content/ref',
    )
    if (ref.kind === 'inline') check(equal(ref.value, original), '/protected/content/value')
    check(pool.get(`json:${digest}`)?.equals(bytes), '/protected/content/retained')
  }
  const directory = readLocatorRoute(lock.directory)
  check(
    directory.routeRevision === null && directory.releaseSetId === null && directory.routeId === plan.routeId,
    '/protected/directory',
  )
  check(policy && typeof policy === 'object' && !Array.isArray(policy), '/protected/policy')
  check(
    policy.bindingId === binding.bindingId &&
      policy.createdAt === binding.createdAt &&
      equal(policy.filesystemPolicy, binding.filesystemPolicy) &&
      equal(policy.telemetryConsent, binding.telemetryConsent) &&
      equal(policy.jointDispatchDomains, binding.jointDispatchDomains),
    '/protected/policy',
  )
}
function verifyPackages(
  source: AppliedPublicationSource,
  role: (name: string, packageId?: string | null, path?: string | null) => JsonValue,
  pool: ReadonlyMap<string, Buffer>,
  packages: RuntimeWireTypes['PackageResolverResolveResult'],
  release: RuntimeWireTypes['ReleaseSet'],
) {
  const ids = packages.lockGraph.entries.map((row) => row.packageId)
  check(
    new Set(ids).size === ids.length &&
      equal([...ids].sort(), release.packages.map((row) => row.packageId).sort()),
    '/packages/ids',
  )
  for (const category of ['package-metadata', 'package-fetch', 'package-manifest']) {
    const rows = source.content.filter((row) => row.role === category)
    check(
      equal(rows.map((row) => row.packageId).sort(), [...ids].sort()) &&
        rows.every((row) => row.kind === 'json' && row.path === null && row.schemaJson === null),
      '/packages/count',
    )
  }
  const expectedFiles = new Set<string>()
  for (const locked of packages.lockGraph.entries) {
    const metadata = readWire(
      'PackageSourceResolveMetadataResult',
      role('package-metadata', locked.packageId),
    )
    const fetch = readWire('PackageSourceFetchResult', role('package-fetch', locked.packageId))
    const manifest = readWire('RuntimePluginManifest', role('package-manifest', locked.packageId))
    check(
      metadata.digest === locked.digest &&
        fetch.verifiedDigest === locked.digest &&
        equal(metadata.manifestRef, locked.manifestRef),
      '/package/digest',
    )
    check(
      manifest.id === locked.packageId &&
        manifest.version === locked.version &&
        manifest.packageDigest === locked.digest,
      '/package/manifest',
    )
    const manifestRow = source.content.find(
      (row) => row.role === 'package-manifest' && row.packageId === locked.packageId,
    )
    check(manifestRow, '/package/manifest')
    const manifestRef = readWire('DataRef', metadata.manifestRef)
    check(
      (manifestRef.kind === 'inline' ? manifestRef.digest : manifestRef.blob.digest) === manifestRow.digest,
      '/package/manifestRef',
    )
    const packaged = release.packages.find((row) => row.packageId === locked.packageId)
    check(packaged?.digest === locked.digest, '/package/release')
    for (const file of manifest.files) {
      const rows = source.content.filter(
        (row) => row.role === 'package-file' && row.packageId === locked.packageId && row.path === file.path,
      )
      check(
        file.path.startsWith('./') &&
          rows.length === 1 &&
          rows[0]?.kind === 'bytes' &&
          rows[0].schemaJson === null &&
          rows[0].digest === file.digest &&
          rows[0].bytes === file.bytes,
        '/package/file',
      )
      const row = rows[0]
      check(row && pool.has(`bytes:${row.digest}`), '/package/file')
      expectedFiles.add(location(row))
    }
    for (const declaration of manifest.schemas) {
      const retained = source.content.filter(
        (row) => row.role === 'schema-source' && row.schemaJson === canonical(declaration.ref),
      )
      check(retained.length === 1 && retained[0], '/package/schema/source')
      const declaredFile = manifest.files.find((file) => file.path === declaration.path)
      check(declaredFile, '/package/schema/file')
      const sourceBytes = pool.get(`json:${retained[0].digest}`)
      const packageBytes = pool.get(`bytes:${declaredFile.digest}`)
      check(sourceBytes && packageBytes && sourceBytes.equals(packageBytes), '/package/schema/body')
      const generated = validateOwnedAuthorSchemaSource(readJson(sourceBytes.toString('utf8')))
      check(equal(generated.ref, declaration.ref), '/package/schema/ref')
    }
    for (const [name, artifact] of Object.entries(packaged.entries)) {
      const entry = manifest.entries[(name === 'backend' ? 'runtime' : name) as keyof typeof manifest.entries]
      check(
        entry && manifest.files.some((row) => row.path === entry && row.digest === artifact.digest),
        '/package/entry',
      )
    }
    for (const selected of release.bindings.filter((row) => row.descriptor.packageDigest === locked.digest)) {
      const declared = manifest.providers.find(
        (row) => row.descriptor.providerId === selected.descriptor.providerId,
      )
      check(declared && equal(declared.descriptor, selected.descriptor), '/package/provider')
      check(
        manifest.files.some((row) => row.path === declared.factory.entry),
        '/package/factory',
      )
      if (equal(selected.binding, inner('BindingRef', source.producerJson)))
        check(
          manifest.files.some(
            (row) => row.path === declared.factory.entry && row.digest === source.issuerCodeDigest,
          ),
          '/package/issuer',
        )
    }
  }
  check(
    source.content
      .filter((row) => row.role === 'package-file')
      .every((row) => expectedFiles.has(location(row))),
    '/package/extraFile',
  )
}
function verifyMembers(
  source: AppliedPublicationSource,
  request: MaintenanceStoreCommitRequest,
  routeId: string,
  release: RuntimeWireTypes['ReleaseSet'],
) {
  check(
    request.expectedWriterEpoch > 0 &&
      request.transactionId === source.transactionId &&
      equal(request.authority, inner('StateAuthorityRef', source.maintenanceAuthorityJson)) &&
      request.outbox.length === 0 &&
      request.mutations.length === 3,
    '/request',
  )
  const [head, route, snapshot] = request.mutations
  check(head && route && snapshot, '/members')
  const current = readPublicationPayload('head', head.next.payload)
  const routed = readPublicationPayload('route', route.next.payload)
  const retained = readPublicationPayload('release', snapshot.next.payload)
  const directory = readLocatorRoute(readJson(current.directoryJson))
  check(
    directory.routeId === routeId &&
      directory.releaseSetId === release.releaseSetId &&
      routed.routeId === routeId &&
      routed.activeReleaseSetId === release.releaseSetId &&
      routed.cutoverId === source.transactionId,
    '/members/route',
  )
  const authority = inner('StateAuthorityRef', source.stateAuthorityJson)
  check(
    equal(inner('StateAuthorityRef', current.stateAuthorityRefJson), authority) &&
      routed.authorityEpoch === authority.authorityEpoch,
    '/members/authority',
  )
  check(equal(inner('ReleaseSet', retained.canonicalJson), release), '/members/release')
  check(
    route.recordId === `release-route:${routeId}` &&
      snapshot.recordId === `release:${release.releaseSetId}` &&
      new Set(request.mutations.map((row) => row.recordId)).size === 3,
    '/members/id',
  )
  for (const [i, member] of request.mutations.entries()) {
    const kind = (['head', 'route', 'release'] as const)[i]
    check(
      kind &&
        equal(member.next.schema, publicationSchemaRefs[kind]) &&
        member.expectedRevision === null &&
        member.next.revision === 1 &&
        member.next.writerEpoch === request.expectedWriterEpoch &&
        member.recordId === member.next.recordId,
      '/member/header',
    )
    check(
      member.next.createdAt === source.observedAt &&
        member.next.updatedAt === source.observedAt &&
        member.next.fingerprint === jsonDigest(member.next.payload) &&
        source.memberFingerprints[i] === jsonDigest(member),
      '/member/fingerprint',
    )
  }
}
function compareLocations(a: RetainedPublicationContent, b: RetainedPublicationContent): number {
  for (const [left, right] of [
    [a.role, b.role],
    [a.packageId, b.packageId],
    [a.path, b.path],
  ]) {
    if (left === right) continue
    if (left === null) return -1
    if (right === null) return 1
    check(left !== undefined && right !== undefined, '/location')
    return Buffer.compare(Buffer.from(left), Buffer.from(right))
  }
  return 0
}
function verifyReferencedContents(source: AppliedPublicationSource, decoded: ReadonlyMap<string, JsonValue>) {
  const sources = new Map<string, ReturnType<typeof validateOwnedAuthorSchemaSource>>()
  for (const row of source.content.filter((item) => item.role === 'schema-source')) {
    const value = decoded.get(location(row))
    const generated = validateOwnedAuthorSchemaSource(value)
    check(
      row.kind === 'json' &&
        row.packageId === generated.source.ownerPackageId &&
        row.path === generated.ref.typeId &&
        row.schemaJson === canonical(generated.ref),
      '/schema/source',
    )
    check(!sources.has(canonical(generated.ref)), '/schema/duplicate')
    sources.set(canonical(generated.ref), generated)
  }
  const refs = new Map<string, DataRef>()
  const pointerToken = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1')
  function discover(value: JsonValue, pointer: string, packageId: string | null): void {
    if (value === null || typeof value !== 'object') return
    const parsed = validateRuntime('DataRef', value)
    if (parsed.ok) {
      const ref = parsed.value
      check(pointer.length <= 1024, '/reference/path/unsupported')
      const key = canonical([packageId, pointer])
      check(!refs.has(key), '/reference/duplicate')
      refs.set(key, ref)
      const retained = source.content.filter(
        (row) => row.role === 'referenced-json' && row.packageId === packageId && row.path === pointer,
      )
      check(retained.length === 1 && retained[0], '/reference/occurrence')
      const row = retained[0]
      const digest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
      check(
        row.kind === 'json' &&
          row.digest === digest &&
          row.bytes === (ref.kind === 'inline' ? ref.bytes : ref.blob.bytes) &&
          row.schemaJson === canonical(ref.schema),
        '/reference/source',
      )
      const body = decoded.get(location(row))
      check(body !== undefined, '/reference/bytes')
      if (ref.kind === 'inline') {
        check(
          ref.digest === jsonDigest(ref.value) &&
            ref.bytes === Buffer.byteLength(canonical(ref.value)) &&
            equal(body, ref.value),
          '/reference/inline',
        )
      }
      discover(body, `${pointer}/value`, packageId)
      return
    }
    for (const [key, item] of Object.entries(value))
      discover(item, `${pointer}/${pointerToken(key)}`, packageId)
  }
  for (const row of source.content) {
    if (row.role === 'referenced-json' || row.role === 'schema-source') continue
    const value = decoded.get(location(row))
    if (value !== undefined) discover(value, `/retained/${pointerToken(location(row))}`, row.packageId)
  }
  for (const row of source.content.filter((item) => item.role === 'referenced-json')) {
    check(row.kind === 'json' && row.schemaJson !== null && row.path !== null, '/reference/role')
    const schema = inner('SchemaRef', row.schemaJson)
    check(refs.has(canonical([row.packageId, row.path])), '/reference/position')
    const value = decoded.get(location(row))
    check(value !== undefined, '/reference/bytes')
    const owned = sources.get(canonical(schema))
    if (owned) check(owned.validate(value).ok, '/reference/codec')
    else {
      // Every otherwise unsupported referenced author value remains refused.
      const matches = Object.keys(RuntimeSchemas).filter((name) => {
        const type = name as keyof RuntimeWireTypes
        const schemaRef = RuntimeSchemaRefs[type as keyof typeof RuntimeSchemaRefs]
        return schemaRef !== undefined && equal(schemaRef, schema) && validateRuntime(type, value).ok
      })
      check(matches.length > 0, '/reference/codec')
    }
  }
}
function collectOfficialDigests(name: keyof RuntimeWireTypes, value: JsonValue, target: Set<string>) {
  const root = RuntimeSchemas[name]
  const definitions: Record<string, TSchema> = {
    ...RuntimeSchemas,
    ...(root.$defs as Record<string, TSchema> | undefined),
  }
  const seen = new WeakSet<object>()
  function register(node: unknown): void {
    if (node === null || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const schema = node as TSchema
    if (typeof schema.$id === 'string') definitions[schema.$id] = schema
    for (const child of Object.values(node)) register(child)
  }
  register(root)
  let work = 0
  function visit(schema: TSchema, data: unknown, depth: number): void {
    check(++work <= 100000 && depth <= 128, '/references/work')
    if (schema.$defs) Object.assign(definitions, schema.$defs)
    if (schema.$ref) {
      const key = schema.$ref.replace(/^#\/\$defs\//, '')
      const next = definitions[key]
      check(next, '/references/schema')
      if (key === 'Digest') {
        check(typeof data === 'string', '/references/digest')
        dig(data)
        target.add(data)
        return
      }
      visit(next, data, depth + 1)
      return
    }
    if (schema.$id === 'Digest') {
      check(typeof data === 'string', '/references/digest')
      dig(data)
      target.add(data)
      return
    }
    if (schema.anyOf) {
      const branch = (schema.anyOf as TSchema[]).find((item) =>
        Value.Check(item, Object.values(definitions), data),
      )
      check(branch, '/references/union')
      visit(branch, data, depth + 1)
      return
    }
    if (schema.type === 'array' && Array.isArray(data)) {
      for (const item of data) visit(schema.items as TSchema, item, depth + 1)
    } else if (schema.type === 'object' && data !== null && typeof data === 'object') {
      const properties = schema.properties as Record<string, TSchema> | undefined
      for (const [key, child] of Object.entries(data)) {
        const declared = properties?.[key]
        if (declared) visit(declared, child, depth + 1)
        else if (typeof schema.additionalProperties === 'object')
          visit(schema.additionalProperties as TSchema, child, depth + 1)
        else
          for (const [pattern, definition] of Object.entries(schema.patternProperties ?? {}))
            if (new RegExp(pattern).test(key)) visit(definition as TSchema, child, depth + 1)
      }
    }
  }
  visit(root, value, 0)
}

function collectRequiredDigests(
  source: AppliedPublicationSource,
  decoded: ReadonlyMap<string, JsonValue>,
  release: RuntimeWireTypes['ReleaseSet'],
): Set<string> {
  const needed = new Set(source.content.map((row) => row.digest))
  for (const row of source.content) {
    const value = decoded.get(location(row))
    if (value !== undefined && Object.hasOwn(jsonRoles, row.role))
      collectOfficialDigests(jsonRoles[row.role as keyof typeof jsonRoles], value, needed)
    if (row.schemaJson !== null) needed.add(inner('SchemaRef', row.schemaJson).digest)
  }
  for (const pkg of release.packages) {
    needed.add(pkg.digest)
    for (const entry of Object.values(pkg.entries)) needed.add(entry.digest)
  }
  return needed
}
/** Computes a data inventory, never an installation or permission proof. */
export function publicationRequiredDigests(
  sourceValue: unknown,
  contents: readonly PublicationContentBytes[],
): readonly string[] {
  const source = readPublicationPayload('source', sourceValue)
  const decoded = new Map<string, JsonValue>()
  for (const row of source.content.filter((item) => item.kind === 'json')) {
    const matches = contents.filter((item) => item.kind === row.kind && item.digest === row.digest)
    check(matches.length === 1 && matches[0] && matches[0].body instanceof Uint8Array, '/contents/missing')
    const bytes = Buffer.from(matches[0].body)
    check(hash(bytes) === row.digest && bytes.length === row.bytes, '/contents/digest')
    const text = bytes.toString('utf8')
    check(Buffer.from(text).equals(bytes), '/contents/utf8')
    decoded.set(location(row), readJson(text))
  }
  const releaseRow = source.content.find((row) => row.role === 'release-set')
  check(releaseRow, '/contents/release')
  const release = readWire('ReleaseSet', decoded.get(location(releaseRow)))
  return Object.freeze([...collectRequiredDigests(source, decoded, release)].sort())
}
