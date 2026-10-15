import { inspectJsonData } from '@agnes/protocol'
import { BatchError, type Json, type Spec } from './contracts.js'

export const MAX_RESULT_BYTES = 32 * 1024
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown) =>
  v === null ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v))
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'uniqueItems',
  'title',
  'description',
  '$schema',
])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/** A deliberately bounded JSON Schema subset: no regex, references, combinators or quadratic rules. */
export function compileSchema(input: unknown): (value: Json) => boolean {
  const inspected = inspectJsonData(input, 32 * 1024)
  if (!inspected.ok) throw new BatchError('E_BATCH_SCHEMA')
  const schema = inspected.value
  let nodes = 0
  function inspect(s: unknown, depth: number): void {
    if (++nodes > 2048 || depth > 16 || !object(s)) throw new BatchError('E_BATCH_SCHEMA')
    if (Object.keys(s).some((k) => !keywords.has(k)))
      throw new BatchError(
        'E_BATCH_SCHEMA_KEYWORD',
        'Unsupported schema keyword: references, patterns and advanced combinators are refused',
      )
    if (!types.has(String(s.type))) throw new BatchError('E_BATCH_SCHEMA')
    if (s.properties !== undefined) {
      if (s.type !== 'object' || !object(s.properties)) throw new BatchError('E_BATCH_SCHEMA')
      for (const v of Object.values(s.properties)) inspect(v, depth + 1)
    }
    for (const [key, allowed] of [
      ['required', ['object']],
      ['additionalProperties', ['object']],
      ['minLength', ['string']],
      ['maxLength', ['string']],
      ['minItems', ['array']],
      ['maxItems', ['array']],
      ['uniqueItems', ['array']],
      ['minimum', ['integer', 'number']],
      ['maximum', ['integer', 'number']],
    ] as const) {
      if (key in s && !(allowed as readonly unknown[]).includes(s.type))
        throw new BatchError('E_BATCH_SCHEMA')
    }
    for (const key of ['title', 'description', '$schema'])
      if (key in s && typeof s[key] !== 'string') throw new BatchError('E_BATCH_SCHEMA')
    if (
      s.required !== undefined &&
      (!Array.isArray(s.required) || s.required.length > 256 || s.required.some((k) => typeof k !== 'string'))
    )
      throw new BatchError('E_BATCH_SCHEMA')
    if (s.additionalProperties !== undefined && typeof s.additionalProperties !== 'boolean')
      inspect(s.additionalProperties, depth + 1)
    if ('uniqueItems' in s && s.uniqueItems !== false)
      throw new BatchError(
        'E_BATCH_SCHEMA_KEYWORD',
        'Unsupported schema keyword: references, patterns and advanced combinators are refused',
      )
    if (s.type === 'array') {
      if (s.items === undefined) throw new BatchError('E_BATCH_SCHEMA')
      inspect(s.items, depth + 1)
    } else if (s.items !== undefined) throw new BatchError('E_BATCH_SCHEMA')
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
      if (
        s[k] !== undefined &&
        (typeof s[k] !== 'number' ||
          !Number.isFinite(s[k]) ||
          (!['minimum', 'maximum'].includes(k) && (!Number.isInteger(s[k]) || s[k] < 0)))
      )
        throw new BatchError('E_BATCH_SCHEMA')
    }
    if (
      s.enum !== undefined &&
      (!Array.isArray(s.enum) || s.enum.length > 256 || s.enum.some((v) => !scalar(v)))
    )
      throw new BatchError('E_BATCH_SCHEMA')
    if ('const' in s && !scalar(s.const)) throw new BatchError('E_BATCH_SCHEMA')
  }
  inspect(schema, 0)
  if (!object(schema) || schema.type !== 'object') throw new BatchError('E_BATCH_SCHEMA')
  return (value) => {
    let work = 0
    function matches(s: Record<string, unknown>, v: Json, depth: number): boolean {
      if (++work > 100_000 || depth > 32) return false
      if ('const' in s && s.const !== v) return false
      if (Array.isArray(s.enum) && !s.enum.includes(v)) return false
      if (s.type === 'object') {
        if (!object(v)) return false
        const props = (s.properties ?? {}) as Record<string, Record<string, unknown>>
        if ((s.required as string[] | undefined)?.some((k) => !Object.hasOwn(v, k))) return false
        for (const [k, child] of Object.entries(v)) {
          if (Object.hasOwn(props, k)) {
            if (!matches(props[k]!, child as Json, depth + 1)) return false
          } else if (s.additionalProperties === false) return false
          else if (
            object(s.additionalProperties) &&
            !matches(s.additionalProperties, child as Json, depth + 1)
          )
            return false
        }
        return true
      }
      if (s.type === 'array') {
        if (
          !Array.isArray(v) ||
          v.length < Number(s.minItems ?? 0) ||
          v.length > Number(s.maxItems ?? Infinity)
        )
          return false
        return v.every((child) => matches(s.items as Record<string, unknown>, child, depth + 1))
      }
      if (s.type === 'string')
        return (
          typeof v === 'string' &&
          [...v].length >= Number(s.minLength ?? 0) &&
          [...v].length <= Number(s.maxLength ?? Infinity)
        )
      if (s.type === 'number' || s.type === 'integer')
        return (
          typeof v === 'number' &&
          Number.isFinite(v) &&
          (s.type !== 'integer' || Number.isInteger(v)) &&
          v >= Number(s.minimum ?? -Infinity) &&
          v <= Number(s.maximum ?? Infinity)
        )
      return s.type === 'null' ? v === null : typeof v === 'boolean'
    }
    return matches(schema as Record<string, unknown>, value, 0)
  }
}

export function validateSpec(input: unknown): Spec {
  const inspected = inspectJsonData(input, 64 * 1024)
  if (!inspected.ok) throw new BatchError('E_BATCH_SPEC')
  const s = inspected.value
  if (
    !object(s) ||
    typeof s.prompt !== 'string' ||
    s.prompt.length < 1 ||
    Buffer.byteLength(s.prompt) > 16_384
  )
    throw new BatchError('E_BATCH_SPEC')
  const fields: Record<string, unknown> = s
  function number(key: string, low: number, high: number, integer: boolean): number {
    const value = fields[key]
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (integer && !Number.isInteger(value)) ||
      value < low ||
      value > high
    )
      throw new BatchError('E_BATCH_SPEC')
    return value
  }
  if (s.schema !== undefined) {
    compileSchema(s.schema)
  }
  return {
    prompt: s.prompt,
    ...(typeof s.out === 'string' ? { out: s.out } : {}),
    ...(s.maxEdge !== undefined ? { maxEdge: number('maxEdge', 256, 1456, true) } : {}),
    budget: number('budget', 0.000001, Number.MAX_SAFE_INTEGER, false),
    itemBudget: number('itemBudget', 0.000001, Number.MAX_SAFE_INTEGER, false),
    concurrency: number('concurrency', 1, 8, true),
    maxRepairs: number('maxRepairs', 0, 2, true),
    failureLimit: number('failureLimit', 1, 100, true),
    itemTimeoutMs: number('itemTimeoutMs', 1000, 3_600_000, true),
    ...(s.schema !== undefined ? { schema: s.schema } : {}),
  }
}

export function parseOutput(text: string, schema?: Json): Json | undefined {
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) return undefined
  if (schema === undefined)
    return Buffer.byteLength(JSON.stringify({ text })) <= MAX_RESULT_BYTES ? { text } : undefined
  try {
    const checked = inspectJsonData(JSON.parse(text), MAX_RESULT_BYTES)
    return checked.ok && compileSchema(schema)(checked.value) ? checked.value : undefined
  } catch {
    return undefined
  }
}
