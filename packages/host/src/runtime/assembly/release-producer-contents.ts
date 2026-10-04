import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { jcs } from '@agnes/protocol'
import { validateOwnedAuthorSchemaSource, validateRuntime } from '@agnes/protocol/runtime'
import type {
  AppliedPublicationSource,
  PublicationContentBytes,
  RetainedPublicationContent,
} from '../maintenance/publication-codecs.js'
import { APPLIED_CONFIGURATION_KIND } from './applied-configuration.js'
import { digest, equal, freeze, readWire, requireRelease } from './primitives.js'
import type { ReleaseProducerCommitPort } from './release-producer.js'
import { externalPublicationRequiredDigests } from './release-producer-reference-codec.js'
import { captureResolvedProducerSource, type ReleaseProducerFacts } from './release-producer-source.js'
import { validateResolvedRelease } from './release-set.js'

const sha = (body: Uint8Array) => createHash('sha256').update(body).digest('hex')
const canonical = (value: unknown) => jcs(readWire('JsonValue', value))
const token = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')

/** Captures the resolving instances' actual outputs and byte inventory, before native time. */
export function captureReleaseProducerContents(
  facts: ReleaseProducerFacts,
  request: import('@agnes/protocol/runtime').MaintenanceStoreCommitRequest | null,
  port: ReleaseProducerCommitPort,
  identityExpiresAt: string,
  contextDeadline: string,
) {
  const original = captureResolvedProducerSource(facts)
  const { source } = original
  const content: RetainedPublicationContent[] = []
  const pool = new Map<string, PublicationContentBytes>()
  const mappedFiles = new Set<string>()
  const roots: { value: unknown; pointer: string; owner: string | null }[] = []
  function retain(
    role: string,
    body: Uint8Array,
    kind: 'json' | 'bytes',
    packageId: string | null = null,
    path: string | null = null,
    schemaJson: string | null = null,
  ) {
    const bytes = Buffer.from(body)
    const row = { role, kind, digest: sha(bytes), bytes: bytes.length, packageId, path, schemaJson }
    requireRelease(
      !content.some((item) => equal([item.role, item.packageId, item.path], [role, packageId, path])),
      'producer_retained_duplicate',
      '/publication/contents',
    )
    content.push(row)
    pool.set(`${kind}:${row.digest}`, { kind, digest: row.digest, body: bytes })
    return row
  }
  function json(role: string, value: unknown, owner: string | null = null) {
    const body = Buffer.from(canonical(value))
    const row = retain(role, body, 'json', owner)
    roots.push({
      value: readWire('JsonValue', value),
      pointer: `/retained/${token(canonical([row.role, row.packageId, row.path]))}`,
      owner,
    })
  }
  json('config-request', source.configRequest)
  json('config-result', original.configurationResult)
  json('package-request', source.packageRequest)
  json('package-result', original.packageResult)
  json('release-plan', source.plan)
  json('release-set', facts.release)
  json('run-binding', facts.binding)
  json('assembly-graph', source.graph)
  const protectedRoles = ['protected-lock', 'protected-config', 'protected-package', 'protected-policy']
  for (const [index, path] of [
    'release-lock.json',
    'config-request.json',
    'package-request.json',
    'binding-policy.json',
  ].entries()) {
    const bytes = source.deployment.files.get(path)?.bytes
    const role = protectedRoles[index]
    requireRelease(bytes && role, 'producer_original_bytes_missing', '/publication/protected')
    const row = retain(role, bytes, 'bytes', null, path)
    mappedFiles.add(path)
    roots.push({
      value: JSON.parse(bytes.toString('utf8')),
      pointer: `/retained/${token(canonical([row.role, row.packageId, row.path]))}`,
      owner: null,
    })
  }
  const originalBlobs = new Map<string, Buffer>()
  for (const row of source.contents) {
    const body = Buffer.from(canonical(row.value))
    const ref = row.ref
    const expectedDigest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
    const expectedBytes = ref.kind === 'inline' ? ref.bytes : ref.blob.bytes
    requireRelease(
      sha(body) === expectedDigest &&
        body.length === expectedBytes &&
        (ref.kind !== 'inline' || equal(row.value, ref.value)),
      'producer_original_bytes_missing',
      '/publication/reference',
    )
    originalBlobs.set(expectedDigest, body)
  }
  for (const verified of original.verified) {
    const { packageId, metadata, snapshot } = verified
    json('package-metadata', metadata, packageId)
    json('package-fetch', snapshot, packageId)
    const manifest = readWire(
      'RuntimePluginManifest',
      metadata.manifestRef.kind === 'inline'
        ? metadata.manifestRef.value
        : source.contents.find((row) => equal(row.ref, metadata.manifestRef))?.value,
    )
    json('package-manifest', manifest, packageId)
    const locked = original.packageResult.lockGraph.entries.find((row) => row.packageId === packageId)
    requireRelease(locked?.locator.kind === 'local', 'package_source_not_local', '/packages')
    const root = source.relativeRoots[locked.locator.sourceId]
    requireRelease(root, 'package_source_missing', '/packages')
    for (const file of manifest.files) {
      const bytes = source.deployment.files.get(join(root, packageId, locked.version, file.path))?.bytes
      requireRelease(
        bytes && sha(bytes) === file.digest && bytes.length === file.bytes,
        'producer_original_bytes_missing',
        '/publication/package-file',
      )
      retain('package-file', bytes, 'bytes', packageId, file.path)
      mappedFiles.add(join(root, packageId, locked.version, file.path))
    }
    // Preserve the raw manifest file even when the package algorithm normalizes its self-digest.
    const manifestBytes = source.deployment.files.get(
      join(root, packageId, locked.version, 'agnes.plugin.json'),
    )?.bytes
    requireRelease(manifestBytes, 'producer_original_bytes_missing', '/publication/manifest')
    retain('package-manifest-file', manifestBytes, 'bytes', packageId, './agnes.plugin.json')
    mappedFiles.add(join(root, packageId, locked.version, 'agnes.plugin.json'))
    const ref = snapshot.stagedPackageRef
    requireRelease(
      ref.kind === 'blob' &&
        sha(verified.archive) === ref.blob.digest &&
        verified.archive.length === ref.blob.bytes,
      'producer_original_bytes_missing',
      '/packages/archive',
    )
    originalBlobs.set(ref.blob.digest, Buffer.from(verified.archive))
  }
  const materials = facts.release.schemasRef
  requireRelease(materials.kind === 'inline', 'producer_schema_source_missing', '/schemasRef')
  const schemas = (materials.value as { schemas?: unknown[] }).schemas
  requireRelease(Array.isArray(schemas), 'producer_schema_source_missing', '/schemasRef')
  for (const raw of schemas) {
    const checked = validateOwnedAuthorSchemaSource(raw)
    retain(
      'schema-source',
      Buffer.from(canonical(checked.source)),
      'json',
      checked.source.ownerPackageId,
      checked.ref.typeId,
      canonical(checked.ref),
    )
  }
  // Every protected byte is retained, including unlisted files in verified package inventories.
  for (const [path, file] of source.deployment.files) {
    if (mappedFiles.has(path)) continue
    retain('deployment-file', file.bytes, 'bytes', null, path)
  }
  function references(value: unknown, pointer: string, owner: string | null, depth = 0): void {
    requireRelease(
      depth <= 64 && pointer.length <= 1024,
      'producer_reference_unsupported',
      '/publication/reference',
    )
    if (value === null || typeof value !== 'object') return
    const parsed = validateRuntime('DataRef', value)
    if (parsed.ok) {
      const ref = parsed.value
      const body =
        ref.kind === 'inline' ? Buffer.from(canonical(ref.value)) : originalBlobs.get(ref.blob.digest)
      requireRelease(body, 'producer_original_bytes_missing', pointer)
      const expectedDigest = ref.kind === 'inline' ? ref.digest : ref.blob.digest
      const expectedBytes = ref.kind === 'inline' ? ref.bytes : ref.blob.bytes
      requireRelease(
        sha(body) === expectedDigest && body.length === expectedBytes,
        'producer_original_bytes_missing',
        pointer,
      )
      const binary = ref.kind === 'blob' && ref.blob.mediaType !== 'application/json'
      retain(
        binary ? 'referenced-bytes' : 'referenced-json',
        body,
        binary ? 'bytes' : 'json',
        owner,
        pointer,
        canonical(ref.schema),
      )
      if (!binary)
        references(
          readWire('JsonValue', JSON.parse(body.toString('utf8'))),
          `${pointer}/value`,
          owner,
          depth + 1,
        )
      return
    }
    for (const [key, child] of Object.entries(value))
      references(child, `${pointer}/${token(key)}`, owner, depth + 1)
  }
  for (const root of roots) references(root.value, root.pointer, root.owner)
  content.sort((a, b) => {
    for (const key of ['role', 'packageId', 'path'] as const) {
      const left = a[key],
        right = b[key]
      if (left !== right)
        return left === null ? -1 : right === null ? 1 : Buffer.compare(Buffer.from(left), Buffer.from(right))
    }
    return 0
  })
  const selected = facts.release.bindings.find((row) => equal(row.binding, facts.producer))
  requireRelease(selected, 'producer_binding_mismatch', '/publication')
  const verified = original.verified.find((row) => row.metadata.digest === selected.descriptor.packageDigest)
  requireRelease(
    verified?.metadata.manifestRef.kind === 'inline',
    'producer_selected_package_missing',
    '/publication',
  )
  const manifest = readWire('RuntimePluginManifest', verified.metadata.manifestRef.value)
  const declaration = manifest.providers.find((row) => equal(row.descriptor, selected.descriptor))
  const code = manifest.files.find((row) => row.path === declaration?.factory.entry)
  requireRelease(code, 'selected_code_missing', '/publication')
  const qualifiedUntil = [facts.qualifiedUntil, readWire('Timestamp', identityExpiresAt)].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  )[0]
  requireRelease(qualifiedUntil, 'producer_qualification_expired', '/publication')
  const payload: AppliedPublicationSource = {
    formatVersion: 1,
    transactionId: request?.transactionId ?? `publish:${facts.release.releaseSetId}`,
    maintenanceAuthorityJson: canonical(port.authority),
    stateAuthorityJson: canonical(port.stateAuthority),
    producerJson: canonical(facts.producer),
    scopeJson: canonical(facts.scope),
    issuerCodeDigest: code.digest,
    releaseSetId: facts.release.releaseSetId,
    bindingId: facts.binding.bindingId,
    planDigest: digest(source.plan),
    sourceFingerprint: facts.sourceFingerprint,
    observedAt: facts.observations.now,
    contextDeadline,
    identityExpiresAt,
    planExpiresAt: source.plan.expiresAt,
    protectedUntil: source.qualifiedUntil,
    qualifiedUntil,
    memberFingerprints: request?.mutations.map(digest) ?? [],
    content,
    requiredDigests: [],
  }
  const contents = [...pool.values()]
  // The complete mapping is externalized before the maintenance reference commit.
  return {
    payload,
    contents,
    original,
    selected,
    verified,
    declaration,
    code,
  }
}

export function readRetainedProducerFacts(
  source: AppliedPublicationSource,
  contents: readonly PublicationContentBytes[],
): ReleaseProducerFacts {
  const pool = new Map<string, Buffer>()
  for (const row of contents) {
    const body = Buffer.from(row.body)
    requireRelease(
      sha(body) === row.digest && !pool.has(`${row.kind}:${row.digest}`),
      'producer_source_mismatch',
      '/publication/contents',
    )
    pool.set(`${row.kind}:${row.digest}`, body)
  }
  for (const row of source.content) {
    const body = pool.get(`${row.kind}:${row.digest}`)
    requireRelease(body?.length === row.bytes, 'producer_original_bytes_missing', '/publication/contents')
  }
  requireRelease(
    pool.size === new Set(source.content.map((row) => `${row.kind}:${row.digest}`)).size &&
      equal(source.requiredDigests, externalPublicationRequiredDigests(source, contents)),
    'producer_source_mismatch',
    '/publication/contents',
  )
  function value(role: string, packageId: string | null = null): unknown {
    const rows = source.content.filter((row) => row.role === role && row.packageId === packageId)
    requireRelease(rows.length === 1 && rows[0], 'producer_source_mismatch', '/publication/contents')
    const body = pool.get(`${rows[0].kind}:${rows[0].digest}`)
    requireRelease(body, 'producer_original_bytes_missing', '/publication/contents')
    return JSON.parse(body.toString('utf8'))
  }
  const configuration = {
    request: readWire('ConfigResolveRequest', value('config-request')),
    result: readWire('ConfigResolveResult', value('config-result')),
  }
  const packages = {
    request: readWire('PackageResolverResolveRequest', value('package-request')),
    result: readWire('PackageResolverResolveResult', value('package-result')),
    verified: [] as ReleaseProducerFacts['packages']['verified'],
  }
  for (const entry of packages.result.lockGraph.entries)
    packages.verified.push({
      packageId: entry.packageId,
      metadata: readWire('PackageSourceResolveMetadataResult', value('package-metadata', entry.packageId)),
      snapshot: readWire('PackageSourceFetchResult', value('package-fetch', entry.packageId)),
    })
  const lock = value('protected-lock') as {
    directory: ReleaseProducerFacts['observations']['directory']
    contents: ReleaseProducerFacts['observations']['contents']
  }
  const permissions = packages.verified.map((row) => ({
    packageId: row.packageId,
    capabilities: readWire('RuntimePluginManifest', value('package-manifest', row.packageId)).permissions
      .runtime,
  }))
  const facts = freeze({
    configuration,
    packages,
    release: readWire('ReleaseSet', value('release-set')),
    binding: readWire('RunBinding', value('run-binding')),
    observations: {
      now: source.observedAt,
      directory: lock.directory,
      contents: lock.contents,
      previousRelease: null,
      previousConfiguration: null,
      jointDomains: [],
      migrations: [],
      packagePermissions: permissions,
    },
    sourceFingerprint: source.sourceFingerprint,
    requiredDigests: source.requiredDigests,
    qualifiedUntil: source.qualifiedUntil,
    producer: readWire('BindingRef', JSON.parse(source.producerJson)),
    scope: readWire('ScopeRef', JSON.parse(source.scopeJson)),
  })
  const plan = readWire('ReleasePlan', value('release-plan'))
  const graph = readWire('AssemblyGraph', value('assembly-graph'))
  const release = validateResolvedRelease(
    {
      plan,
      graph,
      configuration: configuration.result,
      resolution: packages.result,
      observations: facts.observations,
    },
    APPLIED_CONFIGURATION_KIND,
    configuration.request,
  )
  requireRelease(
    equal(release, facts.release) &&
      digest(plan) === source.planDigest &&
      facts.release.releaseSetId === source.releaseSetId &&
      facts.binding.bindingId === source.bindingId &&
      facts.binding.releaseSetId === facts.release.releaseSetId &&
      equal(facts.binding.providers, facts.release.bindings),
    'producer_source_mismatch',
    '/publication/source',
  )
  return facts
}
