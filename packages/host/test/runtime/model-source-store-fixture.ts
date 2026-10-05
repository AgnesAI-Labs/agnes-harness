import type { ActionContext } from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  type AttemptRef,
  canonicalJsonDigest,
  type DataRef,
  type EffectResult,
  type ExternalRequestRef,
  RuntimeSchemaRefs,
  type UsageFact,
} from '@agnes/protocol/runtime'
import type { ModelCallIdentity, ModelCallRegistry } from '../../src/runtime/model/model-source-store.js'
import { inline } from '../../src/runtime/trace/provider-support.js'

export const BODY_DIGEST = 'd'.repeat(64)
/** Stands in for a credential or request body: it is placed in the frame input and must never be stored. */
export const SENTINEL = 'sk-live-sentinel-0123456789abcdef'
const BINDING = {
  bindingId: 'adapter',
  providerId: 'agh.default/model-adapter',
  contract: 'agh.model-adapter',
  logicalName: 'default',
}
const DEADLINE = '2099-01-01T00:00:00.000Z'

export const inlineRef = (value: unknown): DataRef => inline(RuntimeSchemaRefs.StandardToolOutput, value)
/** An inline reference past the 65536-byte author limit, which `inline` itself refuses to build. */
export function bigRef(characters: number): DataRef {
  const value = { text: 'x'.repeat(characters) }
  return {
    kind: 'inline',
    schema: RuntimeSchemaRefs.StandardToolOutput,
    value,
    digest: canonicalJsonDigest(value),
    bytes: characters + 12,
  }
}

export function frameFor(n: string, patch: Partial<ActionFrame> = {}): ActionFrame {
  const input = inlineRef({ preparedCallRef: `prepared-${n}`, note: SENTINEL })
  const inputDigest = canonicalJsonDigest(input.kind === 'inline' ? input.value : null)
  return {
    actionId: `action-${n}`,
    parentActionId: null,
    runId: 'run',
    bindingId: 'adapter',
    method: 'invoke',
    input,
    inputDigest,
    attemptId: `attempt-${n}`,
    attemptNumber: 1,
    invocationId: `invocation-${n}`,
    requestIdentity: {
      system: 'fixture-model',
      aghRequestId: `request-${n}`,
      idempotencyKey: `key-${n}`,
      requestDigest: inputDigest,
    },
    providerRevision: 1,
    continuation: null,
    signals: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: '2026-10-05T10:00:00.000Z',
    context: {
      principalRef: 'fixture-user',
      scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
      bindingId: 'adapter',
      invocationId: `invocation-${n}`,
      deadline: DEADLINE,
      traceRef: 'fixture-trace',
      authorizationRef: 'fixture-authority',
    },
    actionTimebox: { defaultTimeoutMs: 20000, maxDeadline: DEADLINE },
    ...patch,
  }
}

export const attemptRef = (frame: ActionFrame): AttemptRef => ({
  run: {
    runId: frame.runId,
    session: {
      sessionId: 'session',
      authority: { authorityId: 'state', tenantId: 'tenant', authorityEpoch: 1 },
    },
  },
  actionId: frame.actionId,
  attemptId: frame.attemptId,
})

export function requestRef(frame: ActionFrame): ExternalRequestRef {
  const identity = frame.requestIdentity
  if (!identity) throw new Error('fixture frame has no request identity')
  return {
    system: identity.system,
    requestId: identity.aghRequestId,
    requestDigest: identity.requestDigest,
    ...(identity.idempotencyKey === null ? {} : { idempotencyKey: identity.idempotencyKey }),
  }
}

export function usageFor(frame: ActionFrame, tokens = 7, patch: Partial<UsageFact> = {}): UsageFact {
  const request = requestRef(frame)
  return {
    usageId: `${frame.attemptId}:model`,
    originKey: `${request.system}:${request.requestId}`,
    actionId: frame.actionId,
    attemptId: frame.attemptId,
    source: BINDING,
    dimensions: inlineRef({ tokens }),
    externalRequest: request,
    observedAt: '2026-10-05T10:00:01.000Z',
    certainty: 'measured',
    ...patch,
  }
}

export function resultFor(frame: ActionFrame, patch: Partial<EffectResult> = {}, tokens = 7): EffectResult {
  return {
    outcome: 'succeeded',
    result: inlineRef({ content: [{ type: 'text', text: 'answer' }] }),
    externalRequests: [requestRef(frame)],
    usage: [usageFor(frame, tokens)],
    references: [],
    ...patch,
  }
}

export function unknownResultFor(frame: ActionFrame): EffectResult {
  return {
    outcome: 'unknown_effect',
    error: {
      code: 'unknown_effect',
      detailCode: 'model_stream_unknown',
      message: 'Model adapter request refused',
      retryAdvice: { kind: 'never' },
      diagnosticId: 'model-adapter',
    },
    externalRequests: [requestRef(frame)],
    usage: [usageFor(frame, 3, { certainty: 'unknown' })],
    references: [],
  }
}

export type FixtureRegistry = ModelCallRegistry & {
  add(frame: ActionFrame): void
  remove(attemptId: string): void
}
/** Stands in for State's persisted dispatch: what a real registry reads back for an attempt. */
export function registryOf(...frames: ActionFrame[]): FixtureRegistry {
  const known = new Map<string, ModelCallIdentity>()
  const add = (frame: ActionFrame) => {
    if (!frame.requestIdentity) throw new Error('fixture frame has no request identity')
    known.set(frame.attemptId, {
      runId: frame.runId,
      actionId: frame.actionId,
      attemptId: frame.attemptId,
      bindingId: frame.bindingId,
      inputDigest: frame.inputDigest,
      requestIdentity: frame.requestIdentity,
    })
  }
  for (const frame of frames) add(frame)
  return {
    attempt: (attemptId) => known.get(attemptId),
    add,
    remove: (attemptId) => {
      known.delete(attemptId)
    },
  }
}

export function actionContext(signal: AbortSignal = new AbortController().signal): ActionContext {
  return {
    call: {
      principalRef: 'fixture-user',
      scope: { kind: 'runtime', installationId: 'fixture-installation', runtimeId: 'fixture-runtime' },
      bindingId: 'adapter',
      invocationId: 'invocation',
      deadline: DEADLINE,
      traceRef: 'fixture-trace',
      authorizationRef: 'fixture-authority',
      signal,
    },
    effects: {
      invoke: async () => {
        throw new Error('Undeclared effect')
      },
      stream: async () => {
        throw new Error('Undeclared stream')
      },
      upload: async () => {
        throw new Error('Undeclared upload')
      },
    },
    progress: async () => ({ ok: true, value: undefined }),
  }
}
