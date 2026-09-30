// generated from schema/runtime/prototype.json by tools/gen-runtime.ts — do not edit
import type { TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { type ValidationResult, validateAgainst } from '../../../protocol-validation/src/validate.js'
import { jcs } from '../jcs.js'

function validUInt53(schema: TSchema, value: unknown, references: Record<string, TSchema> = {}): boolean {
  const refs = { ...references, ...(schema.$defs as Record<string, TSchema> | undefined) }
  if (schema.$id) refs[schema.$id] = schema
  if (schema.$id === 'UInt53' || schema.$ref === 'UInt53') return !Object.is(value, -0)
  if (schema.$ref) {
    const target = refs[schema.$ref]
    if (!target) throw new Error('unresolved runtime schema reference')
    return validUInt53(target, value, refs)
  }
  if (schema.anyOf) {
    return (schema.anyOf as TSchema[]).some(
      (branch) => Value.Check(branch, Object.values(refs), value) && validUInt53(branch, value, refs),
    )
  }
  if (schema.allOf) return (schema.allOf as TSchema[]).every((branch) => validUInt53(branch, value, refs))
  if (schema.type === 'array' && Array.isArray(value) && schema.items)
    return value.every((item) => validUInt53(schema.items, item, refs))
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    const props = schema.properties as Record<string, TSchema> | undefined
    for (const [key, item] of Object.entries(value)) {
      const property = props?.[key]
      if (property && !validUInt53(property, item, refs)) return false
      const patterns = schema.patternProperties as Record<string, TSchema> | undefined
      for (const [pattern, rule] of Object.entries(patterns ?? {}))
        if (new RegExp(pattern).test(key) && !validUInt53(rule, item, refs)) return false
      if (!property && typeof schema.additionalProperties === 'object') {
        if (!validUInt53(schema.additionalProperties, item, refs)) return false
      }
    }
  }
  return true
}

export function validateRuntimeValue<T>(schema: TSchema, value: unknown): ValidationResult<T> {
  try {
    jcs(value)
  } catch {
    return { ok: false, errors: [{ path: '', message: 'invalid JSON wire value', code: 'TYPE' }] }
  }
  const result = validateAgainst<T>(schema, value)
  if (result.ok && !validUInt53(schema, value))
    return { ok: false, errors: [{ path: '', message: 'UInt53 rejects negative zero', code: 'RANGE' }] }
  return result
}
