import { boundedCanonicalJson, utf8ByteLength } from '../../../protocol-validation/src/byte-budget.js'
import type { ValidationResult } from '../../../protocol-validation/src/index.js'
import type { JsonValue } from '../../../protocol-validation/src/json-data.js'
import { RuntimeAuthorCodecPolicy } from '../../gen/ts/runtime-catalog.js'
import type { SchemaDefinition, SchemaDocument } from './schema-document.js'

export const AUTHOR_SCHEMA_LIMITS = Object.freeze({
  documentBytes: 262144,
  definitions: 256,
  nodes: 4096,
  graphDepth: 32,
  properties: 256,
  enumMembers: 256,
  unionBranches: 16,
  work: 100000,
})
export const SCHEMA_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const annotations = ['title', 'description', 'x-max-canonical-json-bytes']
const constraints: Readonly<Record<string, readonly string[]>> = {
  null: [],
  boolean: [],
  string: ['minLength', 'maxLength', 'x-max-utf8-bytes'],
  number: ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'],
  integer: ['minimum', 'maximum'],
  object: ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'],
  array: ['items', 'minItems', 'maxItems'],
}
export function schemaObject(value: unknown): value is SchemaDefinition {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function fail(message: string): never {
  throw new TypeError(`Invalid generated author schema: ${message}`)
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}
function fields(node: SchemaDefinition, keys: readonly string[]): void {
  for (const key of Object.keys(node))
    if (![...annotations, ...keys].includes(key)) fail('unsupported schema keyword')
  for (const key of ['title', 'description'])
    if (node[key] !== undefined && typeof node[key] !== 'string') fail('invalid annotation')
  const bytes = node['x-max-canonical-json-bytes']
  if (bytes !== undefined && !positive(bytes)) fail('invalid canonical byte constraint')
}
function range(node: SchemaDefinition, min: string, max: string): void {
  for (const key of [min, max]) {
    const value = node[key]
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || (value as number) < 0 || Object.is(value, -0))
    )
      fail('invalid collection or length constraint')
  }
  if (typeof node[min] === 'number' && typeof node[max] === 'number' && node[min] > node[max])
    fail('inverted range')
}
export function schemaChildren(node: SchemaDefinition): SchemaDefinition[] {
  if (schemaObject(node.properties))
    return Object.values(node.properties)
      .filter(schemaObject)
      .concat(schemaObject(node.additionalProperties) ? [node.additionalProperties] : [])
  if (schemaObject(node.items)) return [node.items]
  if (Array.isArray(node.anyOf)) return node.anyOf.filter(schemaObject)
  return []
}

/** A closed subset is checked before either a validator or TS types are created. */
export function validateAuthorSchemaGraph(document: SchemaDocument): void {
  if (Object.keys(document.$defs).length > AUTHOR_SCHEMA_LIMITS.definitions) fail('definition quota')
  let nodes = 0
  const check = (node: SchemaDefinition): void => {
    if (++nodes > AUTHOR_SCHEMA_LIMITS.nodes) fail('schema node quota')
    if (node.$ref !== undefined) {
      fields(node, ['$ref'])
      if (
        typeof node.$ref !== 'string' ||
        !/^#\/\$defs\/[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.$ref) ||
        !Object.hasOwn(document.$defs, node.$ref.slice(8))
      )
        fail('unresolved reference')
    } else if (node.const !== undefined || Object.hasOwn(node, 'const') || node.enum !== undefined) {
      fields(node, Object.hasOwn(node, 'const') ? ['const'] : ['enum'])
      if (Object.hasOwn(node, 'const')) {
        if (!scalar(node.const)) fail('const must be a JSON scalar')
      } else {
        if (
          !Array.isArray(node.enum) ||
          node.enum.length === 0 ||
          node.enum.length > AUTHOR_SCHEMA_LIMITS.enumMembers ||
          node.enum.some((value) => !scalar(value)) ||
          new Set(node.enum.map((value) => JSON.stringify(value))).size !== node.enum.length
        )
          fail('invalid enum')
      }
    } else if (node.anyOf !== undefined) {
      fields(node, ['anyOf'])
      if (
        !Array.isArray(node.anyOf) ||
        node.anyOf.length === 0 ||
        node.anyOf.length > AUTHOR_SCHEMA_LIMITS.unionBranches ||
        !node.anyOf.every(schemaObject)
      )
        fail('invalid union')
    } else {
      if (typeof node.type !== 'string' || !Object.hasOwn(constraints, node.type))
        fail('unsupported schema type')
      fields(node, ['type', ...(constraints[node.type] ?? [])])
      if (node.type === 'string') {
        range(node, 'minLength', 'maxLength')
        if (node['x-max-utf8-bytes'] !== undefined && !positive(node['x-max-utf8-bytes']))
          fail('invalid UTF-8 constraint')
      }
      if (node.type === 'number' || node.type === 'integer') {
        for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'])
          if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key])))
            fail('invalid number range')
        if (
          (node.minimum !== undefined && node.exclusiveMinimum !== undefined) ||
          (node.maximum !== undefined && node.exclusiveMaximum !== undefined)
        )
          fail('ambiguous number range')
        const min = node.minimum ?? node.exclusiveMinimum,
          max = node.maximum ?? node.exclusiveMaximum
        if (
          typeof min === 'number' &&
          typeof max === 'number' &&
          (min > max ||
            (min === max && (node.exclusiveMinimum !== undefined || node.exclusiveMaximum !== undefined)))
        )
          fail('empty number range')
        if (
          node.type === 'integer' &&
          (!Number.isSafeInteger(node.minimum) || !Number.isSafeInteger(node.maximum))
        )
          fail('integer requires explicit safe minimum and maximum')
      }
      if (node.type === 'array') {
        if (!schemaObject(node.items)) fail('array requires items')
        range(node, 'minItems', 'maxItems')
      }
      if (node.type === 'object') {
        if (
          !schemaObject(node.properties) ||
          !Object.values(node.properties).every(schemaObject) ||
          Object.keys(node.properties).length > AUTHOR_SCHEMA_LIMITS.properties
        )
          fail('invalid properties')
        if (
          !Array.isArray(node.required) ||
          !node.required.every(
            (key) => typeof key === 'string' && Object.hasOwn(node.properties as object, key),
          ) ||
          new Set(node.required).size !== node.required.length
        )
          fail('invalid required fields')
        if (
          node.additionalProperties !== false &&
          (!schemaObject(node.additionalProperties) ||
            Object.keys(node.properties).length !== 0 ||
            node.required.length !== 0)
        )
          fail('invalid dictionary')
        range(node, 'minProperties', 'maxProperties')
      }
    }
    for (const child of schemaChildren(node)) check(child)
  }
  for (const [name, node] of Object.entries(document.$defs)) {
    if (!SCHEMA_NAME.test(name) || !schemaObject(node)) fail('invalid definition')
    check(node)
  }
  const active = new Set<SchemaDefinition>(),
    memo = new Map<SchemaDefinition, number>()
  const depth = (node: SchemaDefinition): number => {
    if (active.has(node)) fail('recursive schemas are unsupported')
    const cached = memo.get(node)
    if (cached !== undefined) return cached
    active.add(node)
    const children = node.$ref
      ? [document.$defs[(node.$ref as string).slice(8)] as SchemaDefinition]
      : schemaChildren(node)
    const value = 1 + Math.max(0, ...children.map(depth))
    active.delete(node)
    memo.set(node, value)
    if (value > AUTHOR_SCHEMA_LIMITS.graphDepth) fail('schema graph depth quota')
    return value
  }
  for (const node of Object.values(document.$defs)) depth(node)
}

export function validateAuthorSchemaValue(
  document: SchemaDocument,
  value: JsonValue,
): ValidationResult<JsonValue> {
  let work = 0
  const canonicalCache = new Map<JsonValue, number>()
  const utf8Cache = new Map<string, number>()
  const error = (quota: boolean): ValidationResult<JsonValue> => ({
    ok: false,
    errors: [
      {
        path: '',
        code: quota ? 'RANGE' : 'OTHER',
        ...(quota ? { key: 'maxWork' } : {}),
        message: quota
          ? 'Schema validation work budget exceeded'
          : 'Value does not match the generated author schema',
      },
    ],
  })
  const check = (node: SchemaDefinition, item: JsonValue): boolean => {
    if (++work > AUTHOR_SCHEMA_LIMITS.work) throw new RangeError('schema work quota')
    const maxCanonical = node['x-max-canonical-json-bytes']
    if (typeof maxCanonical === 'number') {
      let bytes = canonicalCache.get(item)
      if (bytes === undefined) {
        const result = boundedCanonicalJson(item, {
          maxBytes: Number.MAX_SAFE_INTEGER,
          maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
          maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
        })
        if (!result.ok) return false
        bytes = result.value.bytes
        canonicalCache.set(item, bytes)
      }
      if (bytes > maxCanonical) return false
    }
    if (typeof node.$ref === 'string')
      return check(document.$defs[node.$ref.slice(8)] as SchemaDefinition, item)
    if (Object.hasOwn(node, 'const')) return item === node.const
    if (Array.isArray(node.enum)) return node.enum.some((value) => item === value)
    if (Array.isArray(node.anyOf)) return node.anyOf.some((branch) => check(branch as SchemaDefinition, item))
    if (node.type === 'null') return item === null
    if (node.type === 'boolean') return typeof item === 'boolean'
    if (node.type === 'string') {
      if (typeof item !== 'string') return false
      let length = 0
      for (const _character of item) length++
      if (
        (typeof node.minLength === 'number' && length < node.minLength) ||
        (typeof node.maxLength === 'number' && length > node.maxLength)
      )
        return false
      if (typeof node['x-max-utf8-bytes'] === 'number') {
        let bytes = utf8Cache.get(item)
        if (bytes === undefined) {
          const result = utf8ByteLength(item, Number.MAX_SAFE_INTEGER)
          if (!result.ok) return false
          bytes = result.value
          utf8Cache.set(item, bytes)
        }
        if (bytes > node['x-max-utf8-bytes']) return false
      }
      return true
    }
    if (node.type === 'number' || node.type === 'integer') {
      if (
        typeof item !== 'number' ||
        !Number.isFinite(item) ||
        (node.type === 'integer' && !Number.isSafeInteger(item))
      )
        return false
      return !(
        (typeof node.minimum === 'number' && item < node.minimum) ||
        (typeof node.maximum === 'number' && item > node.maximum) ||
        (typeof node.exclusiveMinimum === 'number' && item <= node.exclusiveMinimum) ||
        (typeof node.exclusiveMaximum === 'number' && item >= node.exclusiveMaximum)
      )
    }
    if (node.type === 'array') {
      if (
        !Array.isArray(item) ||
        (typeof node.minItems === 'number' && item.length < node.minItems) ||
        (typeof node.maxItems === 'number' && item.length > node.maxItems)
      )
        return false
      return item.every((child) => {
        if (++work > AUTHOR_SCHEMA_LIMITS.work) throw new RangeError('schema work quota')
        return check(node.items as SchemaDefinition, child)
      })
    }
    if (node.type === 'object') {
      if (!schemaObject(item)) return false
      const keys = Object.keys(item),
        props = node.properties as Record<string, SchemaDefinition>
      if (
        (typeof node.minProperties === 'number' && keys.length < node.minProperties) ||
        (typeof node.maxProperties === 'number' && keys.length > node.maxProperties)
      )
        return false
      if ((node.required as string[]).some((key) => !Object.hasOwn(item, key))) return false
      for (const key of keys) {
        if (++work > AUTHOR_SCHEMA_LIMITS.work) throw new RangeError('schema work quota')
        const child = Object.hasOwn(props, key) ? props[key] : node.additionalProperties
        if (!child || !check(child as SchemaDefinition, item[key] as JsonValue)) return false
      }
      return true
    }
    return false
  }
  try {
    return check(document.$defs[document.$ref.slice(8)] as SchemaDefinition, value)
      ? { ok: true, value }
      : error(false)
  } catch (cause) {
    if (cause instanceof RangeError) return error(true)
    throw cause
  }
}
