import { createHash } from 'node:crypto'
import {
  canonicalizePluginRow,
  createTreeSnapshot,
  type TreeSnapshot,
  verifyTreeSnapshot,
} from './convergence.js'
import type { PluginRow } from './plugin-row.js'
import { isResourceOwnedRowId, RESOURCE_OWNED_ROW_IDS, type ResourceOwnedRowId } from './resource-owned.js'

export type { ResourceOwnedRowId }
export { RESOURCE_OWNED_ROW_IDS }

type JsonPrimitive = null | boolean | number | string
export type CanonicalJsonValue =
  | JsonPrimitive
  | readonly CanonicalJsonValue[]
  | Readonly<{ [key: string]: CanonicalJsonValue }>

export type DeepReadonly<T> = unknown extends T
  ? T
  : T extends JsonPrimitive
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T

/** Layer-neutral canonical snapshots; worker adapters refine these to their existing domain types. */
export type McpResourceBootstrap = readonly CanonicalJsonValue[]
export type SkillResourceBootstrap = Readonly<Record<string, CanonicalJsonValue>>
export type ResourceOwnedRowSpec = Readonly<PluginRow>

export type RuntimeTargetIdentity = Readonly<{
  treeHash: string
  resourceRevision: string
  compositeRevision: string
}>

export type ResourceGenerationInput = DeepReadonly<{
  target: RuntimeTargetIdentity
  resources: { mcp: McpResourceBootstrap; skills: SkillResourceBootstrap }
  rows: Record<ResourceOwnedRowId, ResourceOwnedRowSpec | null>
}>

export type RuntimeTarget = DeepReadonly<{
  tree: TreeSnapshot
  resource: ResourceGenerationInput
}>

export type RuntimeTargetArtifact = Readonly<{
  encoding: 'base64'
  canonicalBase64: string
  digest: string
  identity: RuntimeTargetIdentity
}>

export type RuntimeTargetBuildInput = Readonly<{
  rows: readonly Readonly<PluginRow>[]
  resourceRevision: string
  compositeRevision: string
  resources: Readonly<{ mcp: unknown; skills: unknown }>
}>

const SHA256 = /^sha256-[a-f0-9]{64}$/
const REVISION = /^[a-f0-9]{64}$/
// Kept dependency-neutral, but intentionally equal to Protocol's
// MAX_RUNTIME_TARGET_ARTIFACT_BASE64_LENGTH: one complete runtime.stale envelope must fit a frame.
const MAX_CANONICAL_BASE64_LENGTH = 16_776_788
const SORTED_RESOURCE_OWNED_ROW_IDS = Object.freeze([...RESOURCE_OWNED_ROW_IDS].sort(compareCodePoints))

function invalidTarget(code: string, reason: string): never {
  throw new Error(`${code}: ${reason}`)
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]()
  const rightPoints = right[Symbol.iterator]()
  while (true) {
    const leftPoint = leftPoints.next()
    const rightPoint = rightPoints.next()
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done && rightPoint.done) return 0
      return leftPoint.done ? -1 : 1
    }
    const difference = (leftPoint.value.codePointAt(0) ?? 0) - (rightPoint.value.codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
}

function revision(value: unknown, field: string): string {
  if (typeof value !== 'string' || !REVISION.test(value)) {
    invalidTarget('E_RUNTIME_TARGET_IDENTITY', `${field} must be 64 lowercase hexadecimal characters`)
  }
  return value
}

function canonicalJson(
  value: unknown,
  path: string,
  ancestors: ReadonlySet<object> = new Set(),
): CanonicalJsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidTarget('E_RUNTIME_TARGET', `${path} must be finite`)
    return Object.is(value, -0) ? 0 : value
  }
  if (!value || typeof value !== 'object') {
    invalidTarget('E_RUNTIME_TARGET', `${path} must contain only JSON values`)
  }
  if (ancestors.has(value)) invalidTarget('E_RUNTIME_TARGET', `${path} must not be cyclic`)
  const nextAncestors = new Set(ancestors).add(value)
  if (Array.isArray(value)) {
    const output = Array.from({ length: value.length }, (_, index) =>
      Object.hasOwn(value, index) ? canonicalJson(value[index], `${path}[${index}]`, nextAncestors) : null,
    )
    return Object.freeze(output)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    invalidTarget('E_RUNTIME_TARGET', `${path} must contain only plain JSON objects`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidTarget('E_RUNTIME_TARGET', `${path} must not contain symbol keys`)
  }
  const output: Record<string, CanonicalJsonValue> = Object.create(null)
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const item = (value as Record<string, unknown>)[key]
    if (item === undefined) invalidTarget('E_RUNTIME_TARGET', `${path}.${key} cannot be undefined`)
    output[key] = canonicalJson(item, `${path}.${key}`, nextAncestors)
  }
  return Object.freeze(output)
}

function canonicalMcpResource(value: unknown): McpResourceBootstrap {
  const snapshot = canonicalJson(value, 'resources.mcp')
  if (!Array.isArray(snapshot)) {
    invalidTarget('E_RUNTIME_TARGET', 'resources.mcp must be an array')
  }
  return snapshot
}

function canonicalSkillResource(value: unknown): SkillResourceBootstrap {
  const snapshot = canonicalJson(value, 'resources.skills')
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    invalidTarget('E_RUNTIME_TARGET', 'resources.skills must be an object')
  }
  return snapshot as SkillResourceBootstrap
}

function sameIdentity(left: RuntimeTargetIdentity, right: RuntimeTargetIdentity): boolean {
  return (
    left.treeHash === right.treeHash &&
    left.resourceRevision === right.resourceRevision &&
    left.compositeRevision === right.compositeRevision
  )
}

function artifactIdentity(value: unknown): RuntimeTargetIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidTarget('E_RUNTIME_TARGET_IDENTITY', 'identity must be an object')
  }
  const identity = value as Record<string, unknown>
  if (
    Object.keys(identity).sort(compareCodePoints).join('\0') !==
    ['compositeRevision', 'resourceRevision', 'treeHash'].join('\0')
  ) {
    invalidTarget('E_RUNTIME_TARGET_IDENTITY', 'identity has an invalid shape')
  }
  return Object.freeze({
    treeHash: revision(identity.treeHash, 'identity.treeHash'),
    resourceRevision: revision(identity.resourceRevision, 'identity.resourceRevision'),
    compositeRevision: revision(identity.compositeRevision, 'identity.compositeRevision'),
  })
}

/** The only builder that splits resource-owned rows away from the ordinary tree. */
export function buildRuntimeTarget(input: RuntimeTargetBuildInput): RuntimeTarget {
  if (!Array.isArray(input.rows)) invalidTarget('E_RUNTIME_TARGET', 'rows must be an array')
  const seen = new Set<string>()
  const ordinaryRows: Readonly<PluginRow>[] = []
  const resourceRows = Object.create(null) as Record<ResourceOwnedRowId, ResourceOwnedRowSpec | null>
  for (const id of SORTED_RESOURCE_OWNED_ROW_IDS) resourceRows[id] = null

  for (let index = 0; index < input.rows.length; index += 1) {
    if (!Object.hasOwn(input.rows, index)) invalidTarget('E_RUNTIME_TARGET', 'rows must not be sparse')
    const row = canonicalizePluginRow(input.rows[index])
    if (seen.has(row.id)) invalidTarget('E_RUNTIME_TARGET', `duplicate row id: ${row.id}`)
    seen.add(row.id)
    if (isResourceOwnedRowId(row.id)) resourceRows[row.id] = row
    else ordinaryRows.push(row)
  }

  const tree = createTreeSnapshot(ordinaryRows)
  const identity = Object.freeze({
    treeHash: tree.hash,
    resourceRevision: revision(input.resourceRevision, 'resourceRevision'),
    compositeRevision: revision(input.compositeRevision, 'compositeRevision'),
  })
  const resources = Object.freeze({
    mcp: canonicalMcpResource(input.resources?.mcp),
    skills: canonicalSkillResource(input.resources?.skills),
  })
  const resource = Object.freeze({
    target: identity,
    resources,
    rows: Object.freeze(resourceRows),
  })
  return Object.freeze({ tree, resource })
}

function verifyTarget(value: unknown): RuntimeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidTarget('E_RUNTIME_TARGET', 'target must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).sort(compareCodePoints).join('\0') !== ['resource', 'tree'].join('\0')) {
    invalidTarget('E_RUNTIME_TARGET', 'target has an invalid shape')
  }
  const tree = verifyTreeSnapshot(candidate.tree)
  const resourceValue = candidate.resource
  if (!resourceValue || typeof resourceValue !== 'object' || Array.isArray(resourceValue)) {
    invalidTarget('E_RUNTIME_TARGET', 'resource must be an object')
  }
  const resource = resourceValue as Record<string, unknown>
  if (
    Object.keys(resource).sort(compareCodePoints).join('\0') !== ['resources', 'rows', 'target'].join('\0')
  ) {
    invalidTarget('E_RUNTIME_TARGET', 'resource has an invalid shape')
  }
  const suppliedIdentity = artifactIdentity(resource.target)
  const slots = resource.rows
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
    invalidTarget('E_RUNTIME_TARGET', 'resource.rows must be an object')
  }
  if (Object.keys(slots).sort(compareCodePoints).join('\0') !== SORTED_RESOURCE_OWNED_ROW_IDS.join('\0')) {
    invalidTarget('E_RUNTIME_TARGET', 'resource.rows must contain exactly the resource-owned ids')
  }
  const allRows: Readonly<PluginRow>[] = [...tree.rows]
  for (const id of RESOURCE_OWNED_ROW_IDS) {
    const slot = (slots as Record<string, unknown>)[id]
    if (slot === null) continue
    const row = canonicalizePluginRow(slot)
    if (row.id !== id) invalidTarget('E_RUNTIME_TARGET', `resource row slot ${id} contains ${row.id}`)
    allRows.push(row)
  }
  const resourcesValue = resource.resources
  if (!resourcesValue || typeof resourcesValue !== 'object' || Array.isArray(resourcesValue)) {
    invalidTarget('E_RUNTIME_TARGET', 'resource.resources must be an object')
  }
  const resourceKeys = Object.keys(resourcesValue).sort(compareCodePoints)
  if (resourceKeys.join('\0') !== ['mcp', 'skills'].join('\0')) {
    invalidTarget('E_RUNTIME_TARGET', 'resource.resources must contain exactly mcp and skills')
  }
  const built = buildRuntimeTarget({
    rows: allRows,
    resourceRevision: suppliedIdentity.resourceRevision,
    compositeRevision: suppliedIdentity.compositeRevision,
    resources: resourcesValue as { mcp: unknown; skills: unknown },
  })
  if (tree.hash !== built.tree.hash || !sameIdentity(suppliedIdentity, built.resource.target)) {
    invalidTarget('E_RUNTIME_TARGET_IDENTITY', 'embedded identity does not match target content')
  }
  return built
}

function canonicalBytes(target: RuntimeTarget): Uint8Array {
  const snapshot = canonicalJson(target, 'target')
  const bytes = Buffer.from(JSON.stringify(snapshot), 'utf8')
  if (bytes.byteLength > (MAX_CANONICAL_BASE64_LENGTH / 4) * 3) {
    invalidTarget('E_RUNTIME_TARGET_CANONICAL', 'target exceeds the canonical artifact size limit')
  }
  return bytes
}

function isBase64Alphabet(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  )
}

function hasCanonicalBase64Shape(value: string): boolean {
  if (value.length < 4 || value.length > MAX_CANONICAL_BASE64_LENGTH || value.length % 4 !== 0) {
    return false
  }
  let contentLength = value.length
  if (value.charCodeAt(contentLength - 1) === 0x3d) contentLength -= 1
  if (value.charCodeAt(contentLength - 1) === 0x3d) contentLength -= 1
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Alphabet(value.charCodeAt(index))) return false
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false
  }
  return true
}

function strictBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !hasCanonicalBase64Shape(value)) {
    invalidTarget('E_RUNTIME_TARGET_BASE64', 'canonicalBase64 is not canonical base64')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) {
    invalidTarget('E_RUNTIME_TARGET_BASE64', 'canonicalBase64 is not canonical base64')
  }
  return new Uint8Array(bytes)
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`
}

/** Validates exact canonical target bytes read by a worker or probe. */
export function decodeCanonicalRuntimeTargetBytes(bytes: Uint8Array): RuntimeTarget {
  const owned = new Uint8Array(bytes)
  if (owned.byteLength > (MAX_CANONICAL_BASE64_LENGTH / 4) * 3) {
    invalidTarget('E_RUNTIME_TARGET_CANONICAL', 'target exceeds the canonical artifact size limit')
  }
  const text = Buffer.from(owned).toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(owned))) {
    invalidTarget('E_RUNTIME_TARGET_CANONICAL', 'target bytes are not valid UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    invalidTarget('E_RUNTIME_TARGET_CANONICAL', 'target bytes are not valid JSON')
  }
  const target = verifyTarget(parsed)
  if (!Buffer.from(canonicalBytes(target)).equals(Buffer.from(owned))) {
    invalidTarget('E_RUNTIME_TARGET_CANONICAL', 'target bytes are not in canonical form')
  }
  return target
}

/** Encodes a verified target once into the sole durable artifact representation. */
export function encodeRuntimeTargetArtifact(value: RuntimeTarget): RuntimeTargetArtifact {
  const target = verifyTarget(value)
  const bytes = canonicalBytes(target)
  const identity = Object.freeze({ ...target.resource.target })
  return Object.freeze({
    encoding: 'base64',
    canonicalBase64: Buffer.from(bytes).toString('base64'),
    digest: digestBytes(bytes),
    identity,
  })
}

function verifiedArtifactBytes(value: unknown): Readonly<{ bytes: Uint8Array; target: RuntimeTarget }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidTarget('E_RUNTIME_TARGET', 'artifact must be an object')
  }
  const artifact = value as Record<string, unknown>
  if (
    Object.keys(artifact).sort(compareCodePoints).join('\0') !==
    ['canonicalBase64', 'digest', 'encoding', 'identity'].join('\0')
  ) {
    invalidTarget('E_RUNTIME_TARGET', 'artifact has an invalid shape')
  }
  if (artifact.encoding !== 'base64') invalidTarget('E_RUNTIME_TARGET', 'artifact encoding must be base64')
  if (typeof artifact.digest !== 'string' || !SHA256.test(artifact.digest)) {
    invalidTarget('E_RUNTIME_TARGET_DIGEST', 'artifact digest has an invalid shape')
  }
  const bytes = strictBase64(artifact.canonicalBase64)
  if (digestBytes(bytes) !== artifact.digest) {
    invalidTarget('E_RUNTIME_TARGET_DIGEST', 'artifact digest does not match canonical bytes')
  }
  const target = decodeCanonicalRuntimeTargetBytes(bytes)
  const identity = artifactIdentity(artifact.identity)
  if (!sameIdentity(identity, target.resource.target)) {
    invalidTarget('E_RUNTIME_TARGET_IDENTITY', 'artifact identity does not match canonical bytes')
  }
  return Object.freeze({ bytes, target })
}

/** Verifies an artifact and returns a fresh, deeply frozen target. */
export function decodeRuntimeTargetArtifact(value: unknown): RuntimeTarget {
  return verifiedArtifactBytes(value).target
}

/** Verifies an artifact and returns a fresh copy of its exact canonical bytes. */
export function decodeRuntimeTargetBytes(value: unknown): Uint8Array {
  return new Uint8Array(verifiedArtifactBytes(value).bytes)
}
