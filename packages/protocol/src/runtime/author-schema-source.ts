import { boundedCanonicalJson, utf8ByteLength } from '../../../protocol-validation/src/byte-budget.js'
import type { ValidationResult } from '../../../protocol-validation/src/index.js'
import {
  AUTHOR_SCHEMA_LIMITS,
  SCHEMA_NAME,
  schemaObject,
  validateAuthorSchemaGraph,
  validateAuthorSchemaValue,
} from './author-schema-subset.js'
import { canonicalJsonDigest } from './jcs-digest.js'
import {
  type Id,
  type JsonValue,
  type SchemaRef,
  type TypeId,
  type UInt53,
  validateRuntime,
} from './public.js'
import { runtimeSchemaDocument, type SchemaDocument } from './schema-document.js'

export type GeneratedAuthorSchemaSource = {
  readonly ownerPackageId: Id
  readonly name: string
  readonly typeId: TypeId
  readonly revision: UInt53
  readonly document: JsonValue
}
export type CheckedAuthorSchemaSource = {
  readonly source: GeneratedAuthorSchemaSource
  readonly document: SchemaDocument
  readonly ref: SchemaRef
  validate(value: JsonValue): ValidationResult<JsonValue>
}
const reservedNames = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
])
function invalid(message: string): never {
  throw new TypeError(`Invalid generated author schema: ${message}`)
}
function nonemptyId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    ![...value].some(
      (character) =>
        character.charCodeAt(0) <= 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) &&
    utf8ByteLength(value, 256).ok
  )
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
}

export function validateAuthorSchemaIdentity(identity: {
  ownerPackageId?: unknown
  name?: unknown
  typeId?: unknown
  revision?: unknown
}): { ownerPackageId: string; name: string; typeId: string; revision: number } {
  if (
    !nonemptyId(identity.ownerPackageId) ||
    identity.ownerPackageId === 'agh' ||
    /^agh[./]/.test(identity.ownerPackageId)
  )
    invalid('reserved or invalid owner')
  if (!nonemptyId(identity.name) || !SCHEMA_NAME.test(identity.name) || reservedNames.has(identity.name))
    invalid('invalid source name')
  if (
    !nonemptyId(identity.typeId) ||
    !positive(identity.revision) ||
    !validateRuntime('TypeId', identity.typeId).ok
  )
    invalid('invalid schema identity')
  const slash = identity.typeId.lastIndexOf('/'),
    at = identity.typeId.lastIndexOf('@')
  if (
    slash < 1 ||
    at < slash ||
    identity.typeId.slice(0, slash) !== identity.ownerPackageId ||
    !/^[a-z][a-z0-9-]*$/.test(identity.typeId.slice(slash + 1, at)) ||
    !/^[1-9][0-9]*$/.test(identity.typeId.slice(at + 1)) ||
    !positive(Number(identity.typeId.slice(at + 1)))
  )
    invalid('schema namespace does not match owner')
  return {
    ownerPackageId: identity.ownerPackageId,
    name: identity.name,
    typeId: identity.typeId,
    revision: identity.revision,
  }
}

/** This checks schema consistency. Installation ownership is checked by the package builder. */
export function validateOwnedAuthorSchemaSource(input: unknown): CheckedAuthorSchemaSource {
  const safe = boundedCanonicalJson(input, {
    maxBytes: AUTHOR_SCHEMA_LIMITS.documentBytes + 4096,
    maxDepth: 128,
    maxMembers: 100000,
  })
  if (!safe.ok || !schemaObject(safe.value.json)) invalid('source must be bounded JSON data')
  const source = safe.value.json
  if (Object.keys(source).sort().join(',') !== 'document,name,ownerPackageId,revision,typeId')
    invalid('source fields must be closed')
  const identity = validateAuthorSchemaIdentity(source)
  const encoded = boundedCanonicalJson(source.document, {
    maxBytes: AUTHOR_SCHEMA_LIMITS.documentBytes,
    maxDepth: 128,
    maxMembers: 100000,
  })
  if (!encoded.ok || !schemaObject(encoded.value.json)) invalid('invalid schema document')
  const document = encoded.value.json
  if (
    Object.keys(document).sort().join(',') !== '$defs,$ref,$schema' ||
    document.$schema !== 'https://json-schema.org/draft/2020-12/schema' ||
    typeof document.$ref !== 'string' ||
    !/^#\/\$defs\/[A-Za-z_$][A-Za-z0-9_$]*$/.test(document.$ref) ||
    !schemaObject(document.$defs) ||
    !Object.values(document.$defs).every(schemaObject)
  )
    invalid('document must be a closed resolved graph')
  const graph = document as SchemaDocument
  validateAuthorSchemaGraph(graph)
  const canonical = runtimeSchemaDocument(graph, graph.$ref.slice(8))
  const closed = boundedCanonicalJson(canonical, {
    maxBytes: AUTHOR_SCHEMA_LIMITS.documentBytes,
    maxDepth: 128,
    maxMembers: 100000,
  })
  if (!closed.ok || closed.value.canonical !== encoded.value.canonical)
    invalid('document contains unreachable definitions')
  const ref: SchemaRef = {
    typeId: identity.typeId,
    revision: identity.revision,
    digest: canonicalJsonDigest(encoded.value.json),
  }
  source.document = encoded.value.json
  freeze(source)
  Object.freeze(ref)
  return Object.freeze({
    source: source as GeneratedAuthorSchemaSource,
    document: graph,
    ref,
    validate: (value: JsonValue) => validateAuthorSchemaValue(graph, value),
  })
}
