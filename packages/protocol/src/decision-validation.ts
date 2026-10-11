import { Ajv2020 } from 'ajv/dist/2020.js'
import type { JsonValue } from '../gen/ts/session-v1.js'
import { inspectJsonData } from './json-data.js'

const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'oneOf'])

/** The decision form language is data only, bounded and has no remote references or executable widgets. */
export function compileDecisionSchema(schema: Readonly<Record<string, JsonValue>>): (value: unknown) => boolean {
  const data = inspectJsonData(schema, 32768)
  if (!data.ok) throw new Error('DECISION_INVALID_SPEC: invalid schema data')
  let nodes = 0
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 1024 || depth > 16 || !value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('DECISION_INVALID_SPEC: unsupported schema')
    const s = value as Record<string, unknown>
    if (Object.keys(s).some(key => !keywords.has(key))) throw new Error('DECISION_INVALID_SPEC: unsupported schema keyword')
    if (s.type === 'object') {
      if (s.additionalProperties !== false || !s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))
        throw new Error('DECISION_INVALID_SPEC: object schema must be closed')
      for (const child of Object.values(s.properties)) walk(child, depth + 1)
    }
    if (s.type === 'array') {
      if (!Number.isSafeInteger(s.maxItems) || Number(s.maxItems) < 0) throw new Error('DECISION_INVALID_SPEC: unbounded array')
      walk(s.items, depth + 1)
    }
    if (s.type === 'string' && (!Number.isSafeInteger(s.maxLength) || Number(s.maxLength) < 0))
      throw new Error('DECISION_INVALID_SPEC: unbounded string')
    if (s.oneOf !== undefined) {
      if (!Array.isArray(s.oneOf) || s.oneOf.length === 0) throw new Error('DECISION_INVALID_SPEC: invalid branches')
      for (const child of s.oneOf) walk(child, depth + 1)
    }
  }
  walk(data.value, 0)
  const ajv = new Ajv2020({ strictSchema: true, strictTypes: false, strictTuples: false, ownProperties: true })
  const check = ajv.compile(data.value as object)
  return value => {
    const json = inspectJsonData(value, 65536)
    return json.ok && check(json.value) === true
  }
}
