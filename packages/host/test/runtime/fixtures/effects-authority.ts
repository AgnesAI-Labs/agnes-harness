import type { ActionContext, LeafActionProvider } from '@agnes/extension-api/runtime'
import { createRestrictedEffectsFixture } from '@agnes/extension-api/testkit'
import {
  type ActionFrame,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type EffectsDispatchResult,
  type ExternalRequestRef,
  type JsonValue,
  type Receipt,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type {
  AdmittedEffectAttempt,
  EffectsAuthority,
} from '../../../../core/src/runtime/effects/authority.js'
import { createEffectsPreparedStateFixture } from './effects-prepared-state.js'
import { createEffectsIdentityFixture, effectsFixtureAuthority } from './effects-state.js'

/** Test-only genuine State/identity owner. The private callbacks are not a production installer. */
export async function createEffectsAuthorityFixture(
  file: string,
  physical?: (identity: import('@agnes/protocol/runtime').RequestIdentity) => Promise<void>,
) {
  const identity = await createEffectsIdentityFixture(),
    context = identity.context
  const db = await createEffectsPreparedStateFixture(file)
  let identityClosed = false
  const closeIdentity = () => {
    if (!identityClosed) {
      identityClosed = true
      identity.close()
    }
  }
  const peer = createRestrictedEffectsFixture()
  let requests = 0
  peer.allow({
    port: 'invoke',
    operation: 'fixture.effect',
    async handle() {
      requests++
      await physical?.(db.dispatch.requestIdentity)
      return { ok: true, value: db.data }
    },
  })
  const { signal: _signal, ...wire } = context
  const frame: ActionFrame = {
    actionId: db.actionId,
    parentActionId: null,
    runId: 'run',
    bindingId: 'binding',
    method: 'run',
    input: db.data,
    inputDigest: canonicalJsonDigest(db.data),
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: 'invocation',
    requestIdentity: db.dispatch.requestIdentity,
    providerRevision: 1,
    continuation: null,
    signals: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: '2026-04-01T00:00:00Z',
    context: wire,
    actionTimebox: { defaultTimeoutMs: 1000, maxDeadline: context.deadline },
  }
  if (!validateRuntime('ActionFrame', frame).ok) throw Error('Actual frame schema refused')
  const committedBody = db.record(`action:${db.actionId}`).value
  const committedBytes = boundedCanonicalJson(committedBody, {
    maxBytes: 65536,
    maxDepth: 64,
    maxMembers: 10000,
  })
  if (!committedBytes.ok || !validateRuntime('ActionRecordValue', committedBody).ok)
    throw Error('Committed action codec refused')
  const version: DataRef = {
    kind: 'inline',
    schema: RuntimeSchemaRefs.ActionRecordValue,
    value: committedBytes.value.json,
    bytes: committedBytes.value.bytes,
    digest: canonicalJsonDigest(committedBytes.value.json),
  }
  const original = { action: { existingActionId: db.actionId }, frame, version }
  const attempt = {
    run: { runId: 'run', session: { sessionId: 'session', authority: effectsFixtureAuthority } },
    actionId: db.actionId,
    attemptId: 'attempt',
  }
  const result = () => {
    const stored = db.record('attempt:attempt').value
    const receiptId = (stored.receiptIds as string[])[0]
    let receiptRef: EffectsDispatchResult['receiptRef'] = null
    if (receiptId) {
      const receipt = db.record(`receipt:${receiptId}`).value.receipt
      receiptRef = {
        authorityId: effectsFixtureAuthority.authorityId,
        receiptId,
        digest: canonicalJsonDigest(receipt as JsonValue),
      }
    }
    return { attemptRef: attempt, status: stored.state, receiptRef } as EffectsDispatchResult
  }
  const external: ExternalRequestRef = {
    system: db.dispatch.requestIdentity.system,
    requestId: db.dispatch.requestIdentity.aghRequestId,
    requestDigest: db.dispatch.requestIdentity.requestDigest,
  }
  const leaf: LeafActionProvider = {
    kind: 'leaf',
    effectSemantics: 'non-idempotent',
    async ready() {
      return { ok: true, value: undefined }
    },
    async health() {
      return { ok: true, value: { status: 'ready', diagnosticIds: [] } }
    },
    async drain() {
      return {
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
      }
    },
    async close() {},
    async execute(_frame, ctx) {
      const response = await ctx.effects.invoke({ operation: 'fixture.effect', input: db.data }, ctx.call)
      if (!response.ok) throw Error('Restricted peer refused')
      return {
        outcome: 'succeeded',
        result: response.value,
        externalRequests: [external],
        usage: [],
        references: [],
      }
    },
    async reconcile() {
      throw Error('lookup not yet installed')
    },
  }
  const actionContext: ActionContext = {
    call: context,
    effects: peer.ports,
    async progress() {
      return { ok: true, value: undefined }
    },
  }
  const ticket: AdmittedEffectAttempt = {
    original,
    attempt,
    requestIdentity: db.dispatch.requestIdentity,
    frame,
    context: actionContext,
    leaf,
    get externalRequests() {
      return db.record('attempt:attempt').value.externalRequests as ExternalRequestRef[]
    },
    get state() {
      return result()
    },
  }
  const actualCurrent = () => {
    if (!identity.identity.current(context)) throw Error('Current identity refused')
    const action = db.record(`action:${db.actionId}`).value
    if (action.state === 'prepared' && action.currentAttemptId === null) return
    const stored = db.record('attempt:attempt').value
    if (
      action.currentAttemptId !== 'attempt' ||
      stored.actionId !== db.actionId ||
      canonicalJsonDigest(stored.requestIdentity as JsonValue) !==
        canonicalJsonDigest(db.dispatch.requestIdentity)
    )
      throw Error('Original durable source changed')
  }
  const authority: EffectsAuthority = {
    now: () => '2026-04-01T00:00:00Z',
    async open() {
      actualCurrent()
      return { ok: true, value: undefined }
    },
    async checkCurrent(call) {
      if (call !== context) throw Error('Foreign context')
      actualCurrent()
    },
    assertSend(originalAttempt, request, call) {
      if (
        originalAttempt !== ticket ||
        call !== context ||
        request.operation !== 'fixture.effect' ||
        canonicalJsonDigest(request.input) !== canonicalJsonDigest(db.data)
      )
        throw Error('Foreign send')
      actualCurrent()
    },
    async readCommitted(request) {
      actualCurrent()
      if (
        !('existingActionId' in request.committedActionRef) ||
        request.committedActionRef.existingActionId !== db.actionId ||
        request.expectedWriterEpoch !== 1 ||
        request.expectedAuthorityEpoch !== 1
      )
        throw Error('Foreign action')
      return original
    },
    async admit(action) {
      if (action !== original) throw Error('Foreign admission')
      const admitted = await db.admit()
      if (admitted.state !== 'admitted') throw Error('Not admitted')
      return ticket
    },
    assertOriginal(value) {
      if (value !== ticket) throw Error('Fake original')
      actualCurrent()
    },
    external() {
      return external
    },
    async markRunning() {
      const revision = db.record('attempt:attempt').revision
      await db.state.commitControl({
        commitId: 'physical-request',
        guard: db.guard,
        command: {
          kind: 'mark_running',
          attemptId: 'attempt',
          expectedAttemptRevision: revision,
          externalRequests: [external],
        },
      })
    },
    async intake(_attempt, effect) {
      const receipt: Receipt = {
        receiptId: 'receipt',
        actionId: db.actionId,
        attemptId: 'attempt',
        bindingId: 'binding',
        inputDigest: frame.inputDigest,
        outcome: effect.outcome,
        ...(effect.result ? { result: effect.result } : {}),
        ...(effect.error ? { error: effect.error } : {}),
        externalRequests: effect.externalRequests,
        usageRefs: effect.usage.map((v) => v.usageId),
        references: effect.references,
        provenance: { sourceRefs: [], producer: db.dispatch.atomicDomain.stateBinding, trustLabels: [] },
        completedAt: '2026-04-01T00:00:01Z',
      }
      await db.state.intakeReceipt({
        intakeId: 'intake',
        receipt,
        usage: effect.usage,
        evidence: [],
        sourceAuthorizationRef: db.admitted.authorizationId,
        queryUsage: null,
        resultHandling: { kind: 'no-hook' },
      })
      return result()
    },
    async unknown(originalAttempt, externalRequests) {
      if (
        originalAttempt !== ticket ||
        canonicalJsonDigest([...externalRequests]) !== canonicalJsonDigest([...ticket.externalRequests])
      )
        throw Error('Foreign unknown attempt')
      throw Error('Original State unknown intake is unavailable')
    },
    async reconcile(request, call) {
      if (call !== context || canonicalJsonDigest(request.attemptRef) !== canonicalJsonDigest(attempt))
        throw Error('Foreign lookup request')
      throw Error('Original State reconciliation is unavailable')
    },
    async publish(method, value) {
      const body = boundedCanonicalJson(value, { maxBytes: 65536, maxDepth: 64, maxMembers: 10000 })
      if (!body.ok) throw Error('Output budget')
      return {
        kind: 'inline',
        schema: RuntimeMethodSchemaRefs['agh.effects'][method].output,
        value: body.value.json,
        bytes: body.value.bytes,
        digest: canonicalJsonDigest(body.value.json),
      }
    },
    async health() {
      return { ok: true, value: { status: 'ready', diagnosticIds: [] } }
    },
    async close() {
      closeIdentity()
    },
  }
  return {
    authority,
    context,
    db,
    ticket,
    leaf,
    peer,
    requests: () => requests,
    revoke: identity.revoke,
    close() {
      closeIdentity()
      db.close()
    },
  }
}
