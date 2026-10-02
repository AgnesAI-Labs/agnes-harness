import { jcs } from '@agnes/protocol'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  MAX_AUTHOR_INLINE_BYTES,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'

/** Ephemeral inputs are decoded against the selected operation's exact source identity. */
export function decodeIdentityData<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  ref: DataRef,
): RuntimeWireTypes[K] | null {
  if (ref.kind !== 'inline' || jcs(ref.schema) !== jcs(schema)) return null
  const safe = boundedCanonicalJson(ref.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 64,
    maxMembers: 10000,
  })
  if (!safe.ok || safe.value.bytes !== ref.bytes || canonicalJsonDigest(safe.value.json) !== ref.digest)
    return null
  const result = validateRuntime(name, safe.value.json)
  return result.ok ? result.value : null
}

export function encodeIdentityData<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
): DataRef {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new Error('invalid identity owner output')
  const safe = boundedCanonicalJson(result.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: 64,
    maxMembers: 10000,
  })
  if (!safe.ok) throw new Error('identity output exceeds inline limit')
  return Object.freeze({
    kind: 'inline',
    schema: Object.freeze({ ...schema }),
    value: safe.value.json,
    bytes: safe.value.bytes,
    digest: canonicalJsonDigest(safe.value.json),
  })
}
