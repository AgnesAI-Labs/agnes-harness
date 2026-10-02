import type { CallContext, Outcome, RuntimeError } from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  MAX_AUTHOR_INLINE_BYTES,
  type OwnerRef,
  RuntimeAuthorCodecPolicy,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'

export function policyFailure(code: RuntimeError['code'], detailCode: string): Outcome<never> {
  return {
    ok: false,
    error: {
      code,
      detailCode,
      message: 'Policy operation refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'policy-provider',
    },
  }
}
/** This owner comes from the durable request authority; the provider does not synthesize an id. */
export function policyUnknown(ownerRef: OwnerRef): Outcome<never> {
  return {
    ok: false,
    error: {
      code: 'unknown_effect',
      detailCode: 'unknown_result',
      message: 'Policy operation result requires reconciliation',
      retryAdvice: { kind: 'reconcile', ownerRef },
      diagnosticId: 'policy-provider',
    },
  }
}
export function sameSchema(a: SchemaRef, b: SchemaRef): boolean {
  return a.typeId === b.typeId && a.revision === b.revision && a.digest === b.digest
}
function freeze(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
}
export function parsePolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  value: unknown,
): Outcome<RuntimeWireTypes[K]> {
  const budget = RuntimeAuthorCodecPolicy.payload
  const safe = boundedCanonicalJson(value, {
    maxBytes: budget.maxCanonicalJsonBytes,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!safe.ok) return policyFailure('invalid_input', 'policy_value_invalid')
  const result = validateRuntime(name, safe.value.json)
  if (!result.ok) return policyFailure('invalid_input', 'policy_schema_invalid')
  freeze(result.value)
  return { ok: true, value: result.value }
}
export function encodePolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
): Outcome<DataRef> {
  const checked = parsePolicyValue(name, value)
  if (!checked.ok) return checked
  const budget = RuntimeAuthorCodecPolicy.payload
  const encoded = boundedCanonicalJson(checked.value, {
    maxBytes: MAX_AUTHOR_INLINE_BYTES,
    maxDepth: budget.maxDepth,
    maxMembers: budget.maxMembers,
  })
  if (!encoded.ok) return policyFailure('quota', 'inline_data_bytes')
  return {
    ok: true,
    value: {
      kind: 'inline',
      schema,
      value: encoded.value.json,
      bytes: encoded.value.bytes,
      digest: canonicalJsonDigest(encoded.value.json),
    },
  }
}

export async function publishPolicyValue<K extends keyof RuntimeWireTypes>(
  name: K,
  schema: SchemaRef,
  value: RuntimeWireTypes[K],
  context: CallContext,
  publisher: {
    publish(
      schema: SchemaRef,
      value: import('@agnes/protocol/runtime').JsonValue,
      context: CallContext,
    ): Promise<Outcome<DataRef>>
  },
): Promise<Outcome<DataRef>> {
  const parsed = parsePolicyValue(name, value)
  if (!parsed.ok) return parsed
  const limits = RuntimeAuthorCodecPolicy.payload
  const canonical = boundedCanonicalJson(parsed.value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  if (!canonical.ok) return policyFailure('quota', 'policy_output_budget')
  const published = await publisher.publish(schema, canonical.value.json, context)
  if (!published.ok) return published
  const reference = parsePolicyValue('DataRef', published.value)
  if (!reference.ok) return policyFailure('internal', 'policy_output_reference_invalid')
  const data = reference.value
  const proof = data.kind === 'inline' ? data : data.blob
  if (
    !sameSchema(data.schema, schema) ||
    proof.digest !== canonicalJsonDigest(canonical.value.json) ||
    proof.bytes !== canonical.value.bytes
  )
    return policyFailure('internal', 'policy_output_reference_mismatch')
  if (
    data.kind === 'inline' &&
    (canonicalJsonDigest(data.value) !== proof.digest || !parsePolicyValue(name, data.value).ok)
  )
    return policyFailure('internal', 'policy_output_content_invalid')
  return { ok: true, value: data }
}
