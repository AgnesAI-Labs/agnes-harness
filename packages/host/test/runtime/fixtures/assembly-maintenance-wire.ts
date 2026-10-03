import { jcs } from '@agnes/protocol'
import type { DataRef, RuntimeWireTypes } from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  validateRuntime,
} from '@agnes/protocol/runtime'

export function fixtureWire<K extends keyof RuntimeWireTypes>(name: K, value: unknown): RuntimeWireTypes[K] {
  const result = validateRuntime(name, value)
  if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.errors)}`)
  return result.value
}
function fixtureJson(value: unknown) {
  const policy = RuntimeAuthorCodecPolicy.payload
  const checked = boundedCanonicalJson(value, {
    maxBytes: policy.maxCanonicalJsonBytes,
    maxDepth: policy.maxDepth,
    maxMembers: policy.maxMembers,
  })
  if (!checked.ok) throw new Error(`JsonValue: ${JSON.stringify(checked.errors)}`)
  return checked.value.json
}
export const fixtureHash = (value: unknown) => canonicalJsonDigest(fixtureJson(value))
export function fixtureRef(value: unknown) {
  const json = fixtureJson(value),
    typeId = 'acme.release/fixture@1'
  // QueryReply/commit decode the complete public boundary, including this already checked JSON.
  const ref: DataRef = {
    kind: 'inline',
    schema: { typeId, revision: 1, digest: fixtureHash({ typeId }) },
    value: json,
    digest: canonicalJsonDigest(json),
    bytes: Buffer.byteLength(jcs(json)),
  }
  return ref
}
