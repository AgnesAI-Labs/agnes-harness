import type { Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { boundedCanonicalJson, canonicalJsonDigest } from '@agnes/protocol/runtime'

export class DagFault extends Error {
  readonly error: W.RuntimeError
  constructor(detailCode: string, code: W.RuntimeError['code'] = 'invalid_input') {
    super(detailCode)
    this.error = {
      code,
      detailCode,
      message: 'Reference DAG refused',
      diagnosticId: 'reference-dag',
      retryAdvice: { kind: 'never' },
    }
  }
}
export function demand(value: unknown, detail: string, code?: W.RuntimeError['code']): asserts value {
  if (!value) throw new DagFault(detail, code)
}
export function unwrap<T>(result: Outcome<T>): T {
  if (result.ok) return result.value
  const fault = new DagFault(result.error.detailCode, result.error.code)
  throw fault
}
export function canonical(value: unknown) {
  const result = boundedCanonicalJson(value, { maxBytes: 65_536, maxDepth: 32, maxMembers: 8192 })
  demand(result.ok, 'dag_payload_limit', 'quota')
  return result.value
}
export function digest(value: unknown) {
  return canonicalJsonDigest(canonical(value).json)
}
export function equal(a: unknown, b: unknown) {
  return digest(a) === digest(b)
}
export function copy<T>(value: T): T {
  return canonical(value).json as T
}
export function inline(schema: W.SchemaRef, value: unknown): W.DataRef {
  const body = canonical(value)
  return {
    kind: 'inline',
    schema,
    value: body.json,
    bytes: body.bytes,
    digest: canonicalJsonDigest(body.json),
  }
}
export interface DagState {
  identity: string
  issued: W.PreparedAction[]
}
const document = {
  type: 'object',
  additionalProperties: false,
  required: ['identity', 'issued'],
  properties: {
    identity: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    issued: { type: 'array', maxItems: 32, items: { $ref: 'prototype.json#/$defs/PreparedAction' } },
  },
}
/** Algorithm-private state; the deployment owns the automatic preparation envelope. */
export const referenceDagCodec: W.StateCodecRef = {
  namespace: 'agh.reference/dag-loop',
  codecVersion: '1',
  schema: { typeId: 'agh.reference/dag-loop-state@1', revision: 1, digest: digest(document) },
}
