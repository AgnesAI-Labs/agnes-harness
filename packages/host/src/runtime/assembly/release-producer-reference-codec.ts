import { defineGeneratedAuthorSchema } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BlobRef,
  type DataRef,
  type PublicRef,
  RuntimeSchemas,
  type RuntimeWireTypes,
  validateOwnedAuthorSchemaSource,
} from '@agnes/protocol/runtime'
import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { AppliedPublicationSource, PublicationContentBytes } from '../maintenance/publication-codecs.js'
import { array, digest, equal, fields, readWire, requireRelease } from './primitives.js'
import { publicationBytesDigest } from './release-producer-storage.js'

// Pending the maintenance owner's formal reference codec. Private, never a production authorization.
// All provisional format handling is confined here; head and route still use the formal codecs.
const codec = defineGeneratedAuthorSchema<{ canonicalJson: string; contentDigest: string }>(
  validateOwnedAuthorSchemaSource({
    ownerPackageId: 'agnes-host',
    name: 'ExternalPublicationReferencesPending',
    typeId: 'agnes-host/external-publication-references-pending@1',
    revision: 1,
    document: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: '#/$defs/References',
      $defs: {
        References: {
          type: 'object',
          properties: {
            canonicalJson: { type: 'string', minLength: 1, maxLength: 60000, 'x-max-utf8-bytes': 60000 },
            contentDigest: { type: 'string', minLength: 64, maxLength: 64 },
          },
          required: ['canonicalJson', 'contentDigest'],
          additionalProperties: false,
        },
      },
    },
  }).source,
)
export interface RetainedPublicationObject {
  location: BlobRef
  owner: PublicRef
  retentionRevision: 1
}
export interface ExternalPublicationReferences {
  release: RetainedPublicationObject
  source: RetainedPublicationObject | null
  members: { recordId: string; fingerprint: string }[]
}
export interface ExternalPublicationManifest {
  payload: AppliedPublicationSource
  objects: { kind: 'json' | 'bytes'; reference: RetainedPublicationObject }[]
}
function object(value: unknown): RetainedPublicationObject {
  const row = fields(value, ['location', 'owner', 'retentionRevision'], '/publication/reference')
  requireRelease(row.retentionRevision === 1, 'producer_retention_missing', '/publication/reference')
  return {
    location: readWire('BlobRef', row.location),
    owner: readWire('PublicRef', row.owner),
    retentionRevision: 1,
  }
}
function references(value: unknown): ExternalPublicationReferences {
  const row = fields(value, ['release', 'source', 'members'], '/publication/reference')
  const members = array(row.members, '/publication/members').map((raw) => {
    const member = fields(raw, ['recordId', 'fingerprint'], '/publication/member')
    return { recordId: readWire('Id', member.recordId), fingerprint: readWire('Digest', member.fingerprint) }
  })
  requireRelease(
    members.length === 0 || members.length === 3,
    'producer_source_mismatch',
    '/publication/members',
  )
  return { release: object(row.release), source: row.source === null ? null : object(row.source), members }
}
export function encodeExternalPublicationReferences(value: ExternalPublicationReferences): DataRef {
  const canonicalJson = jcs(references(value))
  const payload = { canonicalJson, contentDigest: publicationBytesDigest(Buffer.from(canonicalJson)) }
  requireRelease(codec.parse(payload).ok, 'producer_source_mismatch', '/publication/reference')
  requireRelease(
    Buffer.byteLength(jcs(payload)) <= 65536,
    'publication_inline_budget',
    '/publication/reference',
  )
  return readWire('DataRef', {
    kind: 'inline',
    schema: codec.ref,
    value: payload,
    digest: digest(payload),
    bytes: Buffer.byteLength(jcs(payload)),
  })
}
export function readExternalPublicationReferences(input: DataRef): ExternalPublicationReferences {
  const ref = readWire('DataRef', input)
  requireRelease(
    ref.kind === 'inline' && equal(ref.schema, codec.ref),
    'producer_source_mismatch',
    '/publication/reference',
  )
  const parsed = codec.parse(ref.value)
  requireRelease(parsed.ok, 'producer_source_mismatch', '/publication/reference')
  const value = parsed.value
  requireRelease(
    ref.digest === digest(value) &&
      ref.bytes === Buffer.byteLength(jcs(value)) &&
      value.contentDigest === publicationBytesDigest(Buffer.from(value.canonicalJson)),
    'producer_source_mismatch',
    '/publication/reference',
  )
  const result = references(JSON.parse(value.canonicalJson))
  requireRelease(jcs(result) === value.canonicalJson, 'producer_source_mismatch', '/publication/reference')
  return result
}
export function readExternalPublicationManifest(body: Uint8Array): ExternalPublicationManifest {
  const text = Buffer.from(body).toString('utf8'),
    raw = readWire('JsonValue', JSON.parse(text))
  requireRelease(
    Buffer.from(text).equals(Buffer.from(body)) && jcs(raw) === text,
    'producer_source_mismatch',
    '/publication/manifest',
  )
  const row = fields(raw, ['payload', 'objects'], '/publication/manifest')
  const payload = fields(
    row.payload,
    [
      'formatVersion',
      'transactionId',
      'maintenanceAuthorityJson',
      'stateAuthorityJson',
      'producerJson',
      'scopeJson',
      'issuerCodeDigest',
      'releaseSetId',
      'bindingId',
      'planDigest',
      'sourceFingerprint',
      'observedAt',
      'contextDeadline',
      'identityExpiresAt',
      'planExpiresAt',
      'protectedUntil',
      'qualifiedUntil',
      'memberFingerprints',
      'content',
      'requiredDigests',
    ],
    '/publication/source',
  )
  requireRelease(payload.formatVersion === 1, 'producer_source_mismatch', '/publication/source')
  for (const key of [
    'observedAt',
    'contextDeadline',
    'identityExpiresAt',
    'planExpiresAt',
    'qualifiedUntil',
  ] as const)
    readWire('Timestamp', payload[key])
  for (const key of ['maintenanceAuthorityJson', 'stateAuthorityJson'] as const)
    readWire('StateAuthorityRef', JSON.parse(String(payload[key])))
  readWire('BindingRef', JSON.parse(String(payload.producerJson)))
  readWire('ScopeRef', JSON.parse(String(payload.scopeJson)))
  const content = array(payload.content, '/publication/content').map((raw) => {
    const entry = fields(
      raw,
      ['role', 'kind', 'digest', 'bytes', 'packageId', 'path', 'schemaJson'],
      '/publication/content',
    )
    requireRelease(
      typeof entry.role === 'string' &&
        ['json', 'bytes'].includes(String(entry.kind)) &&
        Number.isSafeInteger(entry.bytes) &&
        Number(entry.bytes) >= 0 &&
        (entry.packageId === null || typeof entry.packageId === 'string') &&
        (entry.path === null || typeof entry.path === 'string') &&
        (entry.schemaJson === null || typeof entry.schemaJson === 'string'),
      'producer_source_mismatch',
      '/publication/content',
    )
    readWire('Digest', entry.digest)
    if (entry.schemaJson !== null) readWire('SchemaRef', JSON.parse(String(entry.schemaJson)))
    return {
      role: String(entry.role),
      kind: entry.kind === 'json' ? ('json' as const) : ('bytes' as const),
      digest: readWire('Digest', entry.digest),
      bytes: Number(entry.bytes),
      packageId: entry.packageId === null ? null : String(entry.packageId),
      path: entry.path === null ? null : String(entry.path),
      schemaJson: entry.schemaJson === null ? null : String(entry.schemaJson),
    }
  })
  requireRelease(
    new Set(content.map((row) => jcs([row.role, row.packageId, row.path]))).size === content.length,
    'producer_source_mismatch',
    '/publication/content',
  )
  const objects = array(row.objects, '/publication/objects').map((raw) => {
    const entry = fields(raw, ['kind', 'reference'], '/publication/object')
    requireRelease(
      entry.kind === 'json' || entry.kind === 'bytes',
      'producer_source_mismatch',
      '/publication/object',
    )
    return {
      kind: entry.kind === 'json' ? ('json' as const) : ('bytes' as const),
      reference: object(entry.reference),
    }
  })
  const textField = (key: string) => {
    requireRelease(typeof payload[key] === 'string', 'producer_source_mismatch', '/publication/source')
    return String(payload[key])
  }
  const requiredDigests = array(payload.requiredDigests, '/publication/digests').map((item) =>
    readWire('Digest', item),
  )
  requireRelease(
    equal(requiredDigests, [...new Set(requiredDigests)].sort()),
    'producer_source_mismatch',
    '/publication/digests',
  )
  const memberFingerprints = array(payload.memberFingerprints, '/publication/members').map((item) =>
    readWire('Digest', item),
  )
  requireRelease(memberFingerprints.length === 3, 'producer_source_mismatch', '/publication/members')
  const fixed: AppliedPublicationSource = {
    formatVersion: 1,
    transactionId: readWire('Id', payload.transactionId),
    maintenanceAuthorityJson: textField('maintenanceAuthorityJson'),
    stateAuthorityJson: textField('stateAuthorityJson'),
    producerJson: textField('producerJson'),
    scopeJson: textField('scopeJson'),
    issuerCodeDigest: readWire('Digest', payload.issuerCodeDigest),
    releaseSetId: readWire('Id', payload.releaseSetId),
    bindingId: readWire('Id', payload.bindingId),
    planDigest: readWire('Digest', payload.planDigest),
    sourceFingerprint: readWire('Digest', payload.sourceFingerprint),
    observedAt: readWire('Timestamp', payload.observedAt),
    contextDeadline: readWire('Timestamp', payload.contextDeadline),
    identityExpiresAt: readWire('Timestamp', payload.identityExpiresAt),
    planExpiresAt: readWire('Timestamp', payload.planExpiresAt),
    protectedUntil: payload.protectedUntil === null ? null : readWire('Timestamp', payload.protectedUntil),
    qualifiedUntil: readWire('Timestamp', payload.qualifiedUntil),
    memberFingerprints,
    requiredDigests,
    content,
  }
  const until = [fixed.contextDeadline, fixed.identityExpiresAt, fixed.planExpiresAt, fixed.protectedUntil]
    .filter((item) => item !== null)
    .map(Date.parse)
  requireRelease(
    Date.parse(fixed.qualifiedUntil) === Math.min(...until) &&
      Date.parse(fixed.observedAt) < Date.parse(fixed.qualifiedUntil),
    'producer_source_mismatch',
    '/publication/qualification',
  )
  return { payload: fixed, objects }
}
const roles = {
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
} as const
/** Exact schema-directed Digest inventory. No field-name or hexadecimal-string heuristics. */
export function externalPublicationRequiredDigests(
  source: AppliedPublicationSource,
  contents: readonly PublicationContentBytes[],
): string[] {
  const needed = new Set(source.content.map((row) => row.digest))
  let definitions: Record<string, TSchema> = { ...RuntimeSchemas }
  let seen = new WeakSet<object>()
  function register(value: unknown): void {
    if (!value || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const node = value as TSchema
    if (typeof node.$id === 'string') definitions[node.$id] = node
    for (const child of Object.values(value)) register(child)
  }
  const opaqueJson = (schema: TSchema): boolean => {
    if (!schema.$id || !Array.isArray(schema.anyOf) || schema.anyOf.length !== 6) return false
    const branches = schema.anyOf as TSchema[]
    return (
      ['null', 'boolean', 'number', 'string'].every((type) =>
        branches.some((branch) => branch.type === type),
      ) &&
      branches.some((branch) => branch.type === 'array' && (branch.items as TSchema)?.$ref === schema.$id) &&
      branches.some(
        (branch) =>
          branch.type === 'object' &&
          Object.keys(branch.patternProperties ?? {}).length === 1 &&
          (branch.patternProperties?.['^(.*)$'] as TSchema)?.$ref === schema.$id,
      )
    )
  }
  let work = 0
  const walk = (schema: TSchema, value: unknown, depth: number): void => {
    if (schema.$defs) Object.assign(definitions, schema.$defs)
    requireRelease(++work <= 100000 && depth <= 128, 'producer_source_mismatch', '/publication/digests/work')
    // Generic recursive JSON has no schema-declared Digest leaves; its DataRefs are separately mapped.
    if (opaqueJson(schema)) return
    if (schema === RuntimeSchemas.JsonValue || schema.$ref === RuntimeSchemas.JsonValue.$id) return
    if (schema.$ref === 'JsonValue' || schema.$ref === '#/$defs/JsonValue' || schema.$id === 'JsonValue')
      return
    if (schema.$id === 'Digest' || schema.$ref === '#/$defs/Digest' || schema.$ref === 'Digest') {
      needed.add(readWire('Digest', value))
      return
    }
    if (schema.$ref) {
      const target = definitions[schema.$ref.replace(/^#\/\$defs\//, '')]
      requireRelease(target, 'producer_source_mismatch', '/publication/digests/reference')
      walk(target, value, depth + 1)
      return
    }
    if (schema.anyOf) {
      const branch = (schema.anyOf as TSchema[]).find((candidate) =>
        Value.Check(candidate, Object.values(definitions), value),
      )
      requireRelease(branch, 'producer_source_mismatch', '/publication/digests/union')
      walk(branch, value, depth + 1)
    } else if (schema.type === 'array' && Array.isArray(value)) {
      for (const item of value) walk(schema.items as TSchema, item, depth + 1)
    } else if (schema.type === 'object' && value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        const target =
          schema.properties?.[key] ??
          (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined)
        if (target) walk(target as TSchema, child, depth + 1)
        else
          for (const [pattern, target] of Object.entries(schema.patternProperties ?? {}))
            if (new RegExp(pattern).test(key)) walk(target as TSchema, child, depth + 1)
      }
    }
  }
  for (const row of source.content) {
    if (row.schemaJson !== null) needed.add(readWire('SchemaRef', JSON.parse(row.schemaJson)).digest)
    const name = roles[row.role as keyof typeof roles]
    if (row.kind === 'json' && name) {
      const body = contents.find((item) => item.kind === row.kind && item.digest === row.digest)?.body
      requireRelease(body, 'producer_original_bytes_missing', '/publication/digests')
      const value = readWire(name as keyof RuntimeWireTypes, JSON.parse(Buffer.from(body).toString('utf8')))
      work = 0
      definitions = { ...RuntimeSchemas }
      seen = new WeakSet<object>()
      register(RuntimeSchemas[name])
      walk(RuntimeSchemas[name], value, 0)
    }
  }
  return [...needed].sort()
}
