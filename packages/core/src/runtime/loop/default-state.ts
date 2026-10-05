import type { LoopReadPorts, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  RuntimeAuthorCodecPolicy,
  validateRuntime,
} from '@agnes/protocol/runtime'

export class DefaultLoopFault extends Error {
  readonly error: W.RuntimeError
  constructor(detailCode: string, code: W.RuntimeError['code'] = 'invalid_input') {
    super('Default text loop refused the operation')
    this.error = {
      code,
      detailCode,
      message: this.message,
      retryAdvice: { kind: 'never' },
      diagnosticId: 'default-text-loop',
    }
  }
}
export function insist(condition: unknown, detail: string, code?: W.RuntimeError['code']): asserts condition {
  if (!condition) throw new DefaultLoopFault(detail, code)
}
export function unwrap<T>(value: Outcome<T>): T {
  if (!value.ok) {
    const error = new DefaultLoopFault(value.error.detailCode, value.error.code)
    Object.assign(error.error, value.error)
    throw error
  }
  return value.value
}
export function canonical(value: unknown) {
  const policy = RuntimeAuthorCodecPolicy.payload
  const bounded = boundedCanonicalJson(value, {
    maxBytes: policy.maxCanonicalJsonBytes,
    maxDepth: policy.maxDepth,
    maxMembers: policy.maxMembers,
  })
  insist(bounded.ok, 'loop_json_limit', 'quota')
  return bounded.value
}
export function equal(a: unknown, b: unknown): boolean {
  return canonicalJsonDigest(canonical(a).json) === canonicalJsonDigest(canonical(b).json)
}
export function encode(schema: W.SchemaRef, value: unknown): W.DataRef {
  const body = canonical(value)
  insist(body.bytes <= 65_536, 'loop_inline_limit', 'quota')
  return {
    kind: 'inline',
    schema,
    digest: canonicalJsonDigest(body.json),
    bytes: body.bytes,
    value: body.json,
  }
}
/** The prepare boundary may refuse; successful preparation may not substitute caller intent. */
export function checkedPrepare(ports: LoopReadPorts, spec: W.ActionSpec): W.PreparedAction {
  const original = structuredClone(spec)
  freezeLoopValue(original)
  const prepared = structuredClone(unwrap(ports.prepare(structuredClone(original))))
  insist(validateRuntime('PreparedAction', canonical(prepared).json).ok, 'loop_prepared_action_invalid')
  const { intentFingerprint: _fingerprint, ...returnedSpec } = prepared
  insist(equal(returnedSpec, original), 'loop_prepared_action_substituted', 'denied')
  return prepared
}
export async function decode(
  ref: W.DataRef,
  schema: W.SchemaRef,
  ports: LoopReadPorts,
): Promise<W.JsonValue> {
  insist(validateRuntime('DataRef', canonical(ref).json).ok && equal(ref.schema, schema), 'loop_data_schema')
  // Even inline reads go through the current authorization boundary.
  const body = canonical(unwrap(await ports.resolveData(ref)))
  const identity = ref.kind === 'inline' ? ref : ref.blob
  insist(
    body.bytes === identity.bytes && canonicalJsonDigest(body.json) === identity.digest,
    'loop_data_integrity',
  )
  return body.json
}

export type DefaultLoopPhase = 'first-model' | 'tool' | 'second-model' | 'terminal'
export interface DefaultLoopState {
  phase: DefaultLoopPhase
  runId: string
  sessionId: string
  workspaceId: string
  bindingId: string
  inputDigest: W.Digest
  pending: W.PreparedAction | null
}
// Default algorithm-private codec. It is not the SDK automatic-preparation envelope.
export const defaultLoopStateDocument = {
  type: 'object',
  additionalProperties: false,
  required: ['phase', 'runId', 'sessionId', 'workspaceId', 'bindingId', 'inputDigest', 'pending'],
  properties: {
    phase: { enum: ['first-model', 'tool', 'second-model', 'terminal'] },
    runId: { type: 'string' },
    sessionId: { type: 'string' },
    workspaceId: { type: 'string' },
    bindingId: { type: 'string' },
    inputDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    pending: { anyOf: [{ $ref: 'prototype.json#/$defs/PreparedAction' }, { type: 'null' }] },
  },
} as const
export const defaultLoopStateCodec: W.StateCodecRef = {
  namespace: 'agh.default/text-loop',
  codecVersion: '1',
  schema: {
    typeId: 'agh.default/text-loop-state@1',
    revision: 1,
    digest: canonicalJsonDigest(canonical(defaultLoopStateDocument).json),
  },
}
export function inputDigest(frame: W.RunFrame): W.Digest {
  return frame.input.kind === 'inline' ? frame.input.digest : frame.input.blob.digest
}
export function initialState(frame: W.RunFrame): DefaultLoopState {
  return {
    phase: 'terminal',
    runId: frame.runId,
    sessionId: frame.sessionId,
    workspaceId: frame.workspaceId,
    bindingId: frame.bindingId,
    inputDigest: inputDigest(frame),
    pending: null,
  }
}
export function stateEnvelope(
  state: DefaultLoopState,
  frame: W.RunFrame,
  binding: W.BindingRef,
): W.VersionedState {
  const pending = state.pending
  return {
    namespace: defaultLoopStateCodec.namespace,
    codecVersion: defaultLoopStateCodec.codecVersion,
    data: encode(defaultLoopStateCodec.schema, state),
    provenance: { producer: binding, sourceRefs: [], trustLabels: [] },
    createdAt: frame.observedAt,
    references: pending?.references ?? [],
  }
}
export async function readState(frame: W.RunFrame, ports: LoopReadPorts): Promise<DefaultLoopState> {
  const outer = frame.continuation
  insist(outer && validateRuntime('VersionedState', canonical(outer).json).ok, 'loop_continuation_invalid')
  insist(
    outer.namespace === defaultLoopStateCodec.namespace &&
      outer.codecVersion === defaultLoopStateCodec.codecVersion,
    'loop_codec_mismatch',
    'incompatible',
  )
  const data = await decode(outer.data, defaultLoopStateCodec.schema, ports)
  insist(data && typeof data === 'object' && !Array.isArray(data), 'loop_state_invalid')
  const state = data as unknown as DefaultLoopState
  insist(
    Object.keys(state).sort().join(',') === 'bindingId,inputDigest,pending,phase,runId,sessionId,workspaceId',
    'loop_state_invalid',
  )
  insist(['first-model', 'tool', 'second-model', 'terminal'].includes(state.phase), 'loop_state_invalid')
  const expected = initialState(frame)
  for (const key of ['runId', 'sessionId', 'workspaceId', 'bindingId', 'inputDigest'] as const)
    insist(state[key] === expected[key], 'loop_state_identity', 'conflict')
  insist(
    state.phase === 'terminal'
      ? state.pending === null
      : state.pending !== null && validateRuntime('PreparedAction', state.pending).ok,
    'loop_state_pending',
  )
  insist(equal(outer.references, state.pending?.references ?? []), 'loop_state_references')
  return state
}

export function freezeLoopValue(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeLoopValue(child)
    Object.freeze(value)
  }
}

export function waitForLoopAction(pending: W.PreparedAction, resolved = false): W.NextStep {
  return {
    kind: 'wait',
    condition: {
      anyOf: [
        {
          kind: 'actions',
          mode: 'all',
          actions: [{ localKey: pending.key }],
          readyWhen: resolved ? 'resolved' : 'receipt',
        },
      ],
      ...(!resolved ? { deadline: pending.deadline } : {}),
    },
  }
}
