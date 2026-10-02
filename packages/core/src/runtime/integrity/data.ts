import { jcs } from '@agnes/protocol'
import {
  boundedCanonicalJson,
  type DataRef,
  type JsonValue,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeAuthorCodecPolicy,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { sha256Hex } from '../../request/hash.js'
import { failIntegrity } from './validation.js'

export const sameIntegrityValue = (a: unknown, b: unknown): boolean => jcs(a) === jcs(b)
export function freezeIntegrityValue(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeIntegrityValue(child)
    Object.freeze(value)
  }
}
function snapshot(value: unknown) {
  const result = boundedCanonicalJson(value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: RuntimeAuthorCodecPolicy.payload.maxDepth,
    maxMembers: RuntimeAuthorCodecPolicy.payload.maxMembers,
  })
  if (!result.ok)
    failIntegrity(
      result.errors.some((error) => error.code === 'RANGE') ? 'quota' : 'invalid_input',
      'integrity_input_invalid',
    )
  return result.value
}
export function unwrapIntegrityData(ref: DataRef, schema: SchemaRef): JsonValue {
  if (ref.kind !== 'inline' || !sameIntegrityValue(ref.schema, schema))
    failIntegrity('invalid_input', 'schema_mismatch')
  const value = snapshot(ref.value)
  if (ref.bytes !== value.bytes || ref.digest !== sha256Hex(value.canonical))
    failIntegrity('invalid_input', 'integrity_mismatch')
  return value.json
}
export function decodeIntegrityData<K extends keyof RuntimeWireTypes>(
  ref: DataRef,
  schema: SchemaRef,
  name: K,
): RuntimeWireTypes[K] {
  const result = validateRuntime(name, unwrapIntegrityData(ref, schema))
  if (!result.ok) failIntegrity('invalid_input', 'integrity_input_invalid')
  return result.value
}
export function encodeIntegrityData<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
): DataRef {
  if (!validateRuntime(name, value).ok) failIntegrity('invalid_input', 'integrity_output_invalid')
  const safe = snapshot(value)
  freezeIntegrityValue(safe.json)
  return Object.freeze({
    kind: 'inline',
    schema,
    value: safe.json,
    bytes: safe.bytes,
    digest: sha256Hex(safe.canonical),
  })
}
