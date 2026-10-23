import { ExtendsUndefinedCheck, FormatRegistry, Kind, type TSchema } from '@sinclair/typebox'
import { TypeSystemPolicy } from '@sinclair/typebox/system'
import { Hash, Value } from '@sinclair/typebox/value'

type Check = (value: unknown) => boolean
const generated = new WeakMap<TSchema, ReadonlySet<string>>()
const plans = new WeakMap<TSchema, Check>()
const JSON_KINDS = new Set([
  'Any',
  'Array',
  'Boolean',
  'Import',
  'Integer',
  'Intersect',
  'Literal',
  'Never',
  'Not',
  'Null',
  'Number',
  'Object',
  'Record',
  'Ref',
  'String',
  'This',
  'Tuple',
  'Undefined',
  'Union',
  'Unknown',
  'Void',
])
function sameDefinition(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  // TypeBox's optional/readonly/transform symbols are annotations for Check; object requiredness
  // lives in the parent's required array. Kind is the only symbol used by this validator.
  const keys = Reflect.ownKeys(left).filter((key) => typeof key !== 'symbol' || key === Kind)
  const otherKeys = Reflect.ownKeys(right).filter((key) => typeof key !== 'symbol' || key === Kind)
  if (keys.length !== otherKeys.length) return false
  return keys.every((key) => {
    const a = Object.getOwnPropertyDescriptor(left, key)
    const b = Object.getOwnPropertyDescriptor(right, key)
    return (
      a !== undefined && b !== undefined && 'value' in a && 'value' in b && sameDefinition(a.value, b.value)
    )
  })
}

// Same FNV-1a 64 byte stream as TypeBox's `Hash` (value/hash/hash.mjs), computed on 32-bit halves
// instead of BigInt generators. uniqueItems only compares these hashes, so equal streams give equal
// verdicts; test/validate.test.ts pins bit-for-bit equality with `Hash`.
let hashHi = 0
let hashLo = 0
const f64 = new Float64Array(1)
const f64View = new DataView(f64.buffer)
const f64Bytes = new Uint8Array(f64.buffer)
function fnvByte(byte: number): void {
  const lo = (hashLo ^ byte) >>> 0
  const product = lo * 0x1b3
  hashHi = (Math.imul(hashHi, 0x1b3) + (lo << 8) + Math.floor(product / 4294967296)) >>> 0
  hashLo = product >>> 0
}
function hashVisit(value: unknown, root: unknown): void {
  if (Array.isArray(value) && !ArrayBuffer.isView(value)) {
    fnvByte(6)
    for (const item of value) hashVisit(item, root)
  } else if (typeof value === 'boolean') {
    fnvByte(2)
    fnvByte(value ? 1 : 0)
  } else if (typeof value === 'bigint') {
    fnvByte(10)
    f64View.setBigInt64(0, value)
    for (const byte of f64Bytes) fnvByte(byte)
  } else if (value instanceof Date && Number.isFinite(value.getTime())) {
    fnvByte(7)
    hashVisit(value.getTime(), root)
  } else if (value === null) fnvByte(1)
  else if (typeof value === 'number') {
    fnvByte(3)
    f64View.setFloat64(0, value)
    for (const byte of f64Bytes) fnvByte(byte)
  } else if (typeof value === 'object') {
    // Typed arrays below are objects too; TypeBox tests Uint8Array only after plain objects.
    fnvByte(5)
    for (const key of Object.getOwnPropertyNames(value).sort()) {
      hashVisit(key, root)
      hashVisit((value as Record<string, unknown>)[key], root)
    }
  } else if (typeof value === 'string') {
    fnvByte(4)
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code > 0xff) fnvByte(code >> 8)
      fnvByte(code & 0xff)
    }
  } else if (typeof value === 'symbol') {
    fnvByte(9)
    hashVisit(value.description, root)
  } else if (value === undefined) fnvByte(0)
  else Hash(root) // functions: TypeBox throws its own ValueHashError
}
function allUnique(items: unknown[]): boolean {
  const seen = new Set<string>()
  for (const item of items) {
    hashHi = 0xcbf29ce4
    hashLo = 0x84222325
    hashVisit(item, item)
    const key = `${hashHi}:${hashLo}`
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/** Every non-module reference must be reached through its declaration, as with recursive This.
 * Otherwise an optional, unvisited declaration could incorrectly make a reference available. */
function boundReferences(root: TSchema, referenced: ReadonlySet<string>): boolean {
  const initial = new Map<string, TSchema>()
  for (const schema of Object.values(root.$defs ?? {}) as TSchema[])
    if (typeof schema?.$id === 'string' && !initial.has(schema.$id)) initial.set(schema.$id, schema)
  if (typeof root.$id === 'string' && !initial.has(root.$id)) initial.set(root.$id, root)
  const start = root[Kind] === 'Import' ? root.$defs?.[root.$ref] : root
  if (!start) return false
  for (const id of referenced) {
    if (initial.has(id)) continue
    const seen = new WeakSet<object>()
    const reachesUnbound = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return false
      seen.add(value)
      const schema = value as TSchema
      if (schema[Kind] && schema.$id === id) return false
      if (schema[Kind] === 'Ref' || schema[Kind] === 'This') {
        if (schema.$ref === id) return true
        const target = initial.get(schema.$ref)
        return target !== undefined && reachesUnbound(target)
      }
      return Object.entries(value).some(
        ([key, child]) => !(typeof schema[Kind] === 'string' && key === '$defs') && reachesUnbound(child),
      )
    }
    if (reachesUnbound(start)) return false
  }
  return true
}

/** Generated protocol definitions are immutable; payloads and caller-owned schemas are untouched. */
export function prepareValidationSchemas(schemas: readonly TSchema[]): void {
  const seen = new WeakSet<object>()
  const roots = new Set(schemas)
  const identifiers = new Map<string, TSchema>()
  const referenced = new Set<string>()
  let unambiguous = true
  function freeze(value: unknown): void {
    if (typeof value === 'function') {
      unambiguous = false
      return
    }
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype)
      unambiguous = false
    if (Kind in value) {
      const schema = value as TSchema
      if (!JSON_KINDS.has(schema[Kind])) unambiguous = false
      if (schema[Kind] === 'Ref' || schema[Kind] === 'This') {
        if (typeof schema.$ref === 'string') referenced.add(schema.$ref)
        else unambiguous = false
      }
      if (schema[Kind] === 'Literal' && !['string', 'number', 'boolean'].includes(typeof schema.const))
        unambiguous = false
      // Nested imports have lexical reference environments; keep those with the interpreter.
      if (schema[Kind] === 'Import' && !roots.has(schema)) unambiguous = false
      if (typeof schema.$id === 'string') {
        const previous = identifiers.get(schema.$id)
        if (previous && previous !== schema && !sameDefinition(previous, schema)) unambiguous = false
        else identifiers.set(schema.$id, schema)
      }
    }
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor && 'value' in descriptor) freeze(descriptor.value)
      else unambiguous = false
    }
    Object.freeze(value)
  }
  for (const schema of schemas) freeze(schema)
  // Conflicting ids depend on which branch the value visits first. Never flatten that semantics.
  if (!unambiguous) return
  for (const schema of schemas) generated.set(schema, referenced)
}

/** CSP-safe reference plan. Unregistered/mutable schemas retain the interpreter. */
export function checkWithPlan(schema: TSchema, value: unknown): boolean | undefined {
  const referenced = generated.get(schema)
  if (!referenced) return undefined
  let plan = plans.get(schema)
  if (!plan) {
    // Most exported roots are never needed at ready. Prove their reference scope on first use,
    // before compiling or checking any value, rather than walking every unused export at boot.
    let safe = false
    try {
      safe = boundReferences(schema, referenced)
    } catch {
      /* Keep malformed metadata interpreted. */
    }
    if (!safe) {
      generated.delete(schema)
      return undefined
    }
    plan = build(schema, Object.values(schema.$defs ?? {}))
    plans.set(schema, plan)
  }
  return plan(value)
}

function build(root: TSchema, initial: TSchema[]): Check {
  // Match TypeBox's first-reference-wins resolution, including recursive $ids. Plans are local to
  // a root: the same Ref can resolve differently in another module's definition environment.
  const references = [...initial]
  const memo = new Map<TSchema, Check>()
  function compile(schema: TSchema): Check {
    const found = memo.get(schema)
    if (found) return found
    if (typeof schema.$id === 'string' && !references.some((ref) => ref.$id === schema.$id))
      references.push(schema)
    let check: Check = (value) => Value.Check(schema, references, value)
    const forward: Check = (value) => check(value)
    memo.set(schema, forward)
    const kind = schema[Kind]
    if (kind === 'Import') {
      references.push(...Object.values(schema.$defs as Record<string, TSchema>))
      check = compile(schema.$defs[schema.$ref])
    } else if (kind === 'Ref' || kind === 'This') {
      // Resolve on first use, preserving refusal/throw timing for an unvisited invalid branch.
      let target: Check | undefined
      check = (value) => {
        if (!target) {
          const ref = references.find((ref) => ref.$id === schema.$ref)
          if (!ref) return Value.Check(schema, references, value)
          target = compile(ref)
        }
        return target(value)
      }
    } else if (kind === 'Union') {
      const choices = (schema.anyOf as TSchema[]).map(compile)
      check = (value) => choices.some((choice) => choice(value))
    } else if (kind === 'Object') {
      const keys = Object.getOwnPropertyNames(schema.properties)
      const known = new Set(keys)
      const fields = keys.map((key) => {
        const property = schema.properties[key] as TSchema
        return {
          key,
          check: compile(property),
          required: (schema.required as string[] | undefined)?.includes(key),
          presence: ExtendsUndefinedCheck(property) || ['Any', 'Unknown'].includes(property[Kind]),
        }
      })
      const additional =
        typeof schema.additionalProperties === 'object' ? compile(schema.additionalProperties) : undefined
      check = (value) => {
        if (!TypeSystemPolicy.IsObjectLike(value)) return false
        const object = value as Record<string, unknown>
        if (
          schema.minProperties !== undefined &&
          !(Object.getOwnPropertyNames(object).length >= schema.minProperties)
        )
          return false
        if (
          schema.maxProperties !== undefined &&
          !(Object.getOwnPropertyNames(object).length <= schema.maxProperties)
        )
          return false
        for (const field of fields) {
          if (field.required) {
            if (!field.check(object[field.key])) return false
            if (field.presence && !(field.key in object)) return false
          } else if (
            TypeSystemPolicy.IsExactOptionalProperty(object, field.key) &&
            !field.check(object[field.key])
          )
            return false
        }
        if (schema.additionalProperties === false) {
          const own = Object.getOwnPropertyNames(object)
          if (schema.required?.length === keys.length && own.length === keys.length) return true
          return own.every((key) => known.has(key))
        }
        return (
          !additional ||
          Object.getOwnPropertyNames(object).every((key) => known.has(key) || additional(object[key]))
        )
      }
    } else if (kind === 'Record') {
      const entry = Object.entries(schema.patternProperties as Record<string, TSchema>)[0]
      if (!entry) return forward
      const [pattern, property] = entry
      const regex = new RegExp(pattern)
      const item = compile(property)
      const additional =
        typeof schema.additionalProperties === 'object' ? compile(schema.additionalProperties) : undefined
      check = (value) => {
        if (!TypeSystemPolicy.IsRecordLike(value)) return false
        const object = value as Record<string, unknown>
        if (
          schema.minProperties !== undefined &&
          !(Object.getOwnPropertyNames(object).length >= schema.minProperties)
        )
          return false
        if (
          schema.maxProperties !== undefined &&
          !(Object.getOwnPropertyNames(object).length <= schema.maxProperties)
        )
          return false
        const entries = Object.entries(object)
        const matching = entries.every(([key, value]) => !regex.test(key) || item(value))
        const extra =
          !additional || Object.entries(object).every(([key, value]) => regex.test(key) || additional(value))
        const closed =
          schema.additionalProperties !== false ||
          Object.getOwnPropertyNames(object).every((key) => regex.test(key))
        return matching && extra && closed
      }
    } else if (
      kind === 'Array' &&
      schema.contains === undefined &&
      schema.minContains === undefined &&
      schema.maxContains === undefined
    ) {
      const item = compile(schema.items)
      check = (value) =>
        Array.isArray(value) &&
        (schema.minItems === undefined || value.length >= schema.minItems) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every(item) &&
        (schema.uniqueItems !== true || allUnique(value))
    } else if (kind === 'String') {
      const pattern = schema.pattern === undefined ? undefined : new RegExp(schema.pattern)
      check = (value) =>
        typeof value === 'string' &&
        (schema.minLength === undefined || value.length >= schema.minLength) &&
        (schema.maxLength === undefined || value.length <= schema.maxLength) &&
        (!pattern || pattern.test(value)) &&
        (schema.format === undefined || (FormatRegistry.Get(schema.format)?.(value) ?? false))
    } else if (kind === 'Literal') check = (value) => value === schema.const
    else if (kind === 'Null') check = (value) => value === null
    else if (kind === 'Boolean') check = (value) => typeof value === 'boolean'
    else if (kind === 'Any' || kind === 'Unknown') check = () => true
    // Constraints and uncommon kinds remain with TypeBox, including record/intersection semantics.
    return forward
  }
  return compile(root)
}
