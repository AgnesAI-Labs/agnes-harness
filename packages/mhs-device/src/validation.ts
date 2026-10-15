import { Value } from '@sinclair/typebox/value'
import { type Field, type Json, type Registration, registrationSchema } from './schema.js'

export class MhsError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MhsError('invalid')
  return value as Record<string, unknown>
}
const keywords = new Set([
  'type',
  'properties',
  'required',
  'default',
  'minimum',
  'maximum',
  'maxLength',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'description',
])
export function checkParameterSchema(value: unknown, depth = 0): void {
  const schema = object(value)
  if (depth > 8 || Object.keys(schema).some((k) => !keywords.has(k))) throw new MhsError('invalid-schema')
  if (!['object', 'array', 'number', 'integer', 'string', 'boolean'].includes(String(schema.type)))
    throw new MhsError('invalid-schema')
  for (const key of ['minimum', 'maximum', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key])))
      throw new MhsError('invalid-schema')
  }
  for (const key of ['maxLength', 'minItems', 'maxItems'])
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0))
      throw new MhsError('invalid-schema')
  if (
    typeof schema.minimum === 'number' &&
    typeof schema.maximum === 'number' &&
    schema.minimum > schema.maximum
  )
    throw new MhsError('invalid-schema')
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 128)
  )
    throw new MhsError('invalid-schema')
  if (schema.type === 'object') {
    const props = object(schema.properties ?? {})
    if (Object.keys(props).some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)))
      throw new MhsError('invalid-schema')
    for (const entry of Object.values(props)) checkParameterSchema(entry, depth + 1)
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) ||
        schema.required.some((k) => typeof k !== 'string' || !Object.hasOwn(props, k)))
    )
      throw new MhsError('invalid-schema')
  }
  if (schema.type === 'array') checkParameterSchema(schema.items, depth + 1)
}
export function validateRegistration(value: unknown): Registration {
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > 65536 ||
    !Value.Check(registrationSchema, value)
  )
    throw new MhsError('invalid-description')
  const description = structuredClone(value)
  for (const entries of [
    description.tools?.map((t) => t.name),
    description.sources?.map((s) => s.id),
    description.manual?.axes.map((a) => a.id),
    description.maps?.map((m) => m.id),
  ]) {
    if (entries && new Set(entries).size !== entries.length) throw new MhsError('duplicate-id')
  }
  if (description.localization === 'fixed' && !description.placement) throw new MhsError('invalid-placement')
  for (const tool of description.tools ?? []) {
    checkParameterSchema(tool.inputSchema)
    if (
      tool.inputSchema.type !== 'object' ||
      tool.uses?.some((r) => !Object.hasOwn(description.resources ?? {}, r)) ||
      (tool.motion && tool.readOnly) ||
      tool.needs?.some((id) => !description.sources?.some((source) => source.id === id))
    )
      throw new MhsError('invalid-tool')
  }
  for (const field of Object.values(description.state ?? {}))
    if (field.min !== undefined && field.max !== undefined && field.min > field.max)
      throw new MhsError('invalid-range')
  for (const axis of description.manual?.axes ?? [])
    if (axis.min > 0 || axis.max < 0 || axis.min >= axis.max) throw new MhsError('invalid-axis')
  for (const source of description.sources ?? [])
    if (source.of && !(description.sources ?? []).some((s) => s.id === source.of && s.id !== source.id))
      throw new MhsError('invalid-source')
  for (const map of description.maps ?? []) {
    const places = map.places ?? []
    if (new Set(places.map((p) => p.id)).size !== places.length || places.some((p) => !!p.at === !!p.points))
      throw new MhsError('invalid-place')
    if (map.bounds && (map.bounds[0] >= map.bounds[2] || map.bounds[1] >= map.bounds[3]))
      throw new MhsError('invalid-map-bounds')
  }
  return description
}
/** Validate the declared subset recursively; return the effective values, never the caller object. */
export function prepareArguments(
  schema: Record<string, unknown>,
  input: unknown,
  notes: string[] = [],
  path = 'args',
  depth = 0,
): Json {
  if (depth > 8) throw new MhsError('invalid')
  let value = input === undefined ? schema.default : input
  if (schema.type === 'object') {
    const supplied = object(value)
    const props = object(schema.properties ?? {})
    const out: Record<string, Json> = Object.create(null)
    for (const [key, child] of Object.entries(props)) {
      const childSchema = object(child)
      if (!Object.hasOwn(supplied, key) && childSchema.default === undefined) {
        if ((schema.required as string[] | undefined)?.includes(key)) throw new MhsError('invalid')
      } else out[key] = prepareArguments(childSchema, supplied[key], notes, `${path}.${key}`, depth + 1)
    }
    return out
  }
  if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length > Math.min(Number(schema.maxItems ?? 1024), 1024) ||
      value.length < Number(schema.minItems ?? 0)
    )
      throw new MhsError('invalid')
    return value.map((v) => prepareArguments(object(schema.items), v, notes, path, depth + 1))
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (schema.type === 'integer' && !Number.isInteger(value))
    )
      throw new MhsError('invalid')
    const next = Math.max(
      Number(schema.minimum ?? -Infinity),
      Math.min(Number(schema.maximum ?? Infinity), value),
    )
    if (next !== value) notes.push(`${path}: clamped`)
    value = next
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new MhsError('invalid')
    const next = value.slice(0, Number(schema.maxLength ?? 4096))
    if (next !== value) notes.push(`${path}: truncated`)
    value = next
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new MhsError('invalid')
  } else throw new MhsError('invalid')
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new MhsError('invalid')
  return value as Json
}
export function fieldValue(field: Field, value: unknown): Json {
  return prepareArguments(
    {
      type: field.type,
      ...(field.min === undefined ? {} : { minimum: field.min }),
      ...(field.max === undefined ? {} : { maximum: field.max }),
      ...(field.enum ? { enum: field.enum } : {}),
    },
    value,
  )
}
