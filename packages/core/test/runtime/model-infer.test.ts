import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import {
  assemblePrepared,
  externalKeyOf,
  INFER_CHILD_KEY,
  modelCaptureOf,
} from '../../src/runtime/model/prepared-call.js'
import type { ModelDeployment } from '../../src/runtime/providers/model.js'
import { actionFrame, inlineRef, openModel } from './model-deployment-fixture.js'
import {
  callContext,
  fixtureAdapter,
  fixtureOwner,
  fixturePick,
  fixtureWire,
  prepareRequest,
  runScope,
} from './model-fixture.js'
import { requestIdentityOf, restrictedPeer } from './model-peer-fixture.js'

const refs = RuntimeMethodSchemaRefs['agh.model']
type Select = ModelDeployment['adapters']['select']
const standard: Select = (target) =>
  target.bindingId === fixtureAdapter.bindingId
    ? { binding: fixtureAdapter, packageDigest: 'package-1' }
    : null

async function startInfer(
  over: Partial<ModelDeployment> = {},
  frameOver: Partial<W.ActionFrame> = {},
  options: { aborted?: boolean; request?: W.ModelPrepareRequest } = {},
) {
  let select: Select = standard
  const model = await openModel({ adapters: { select: (target, call) => select(target, call) }, ...over })
  const prepared = await model.provider.compute?.(
    {
      target: fixtureOwner,
      method: 'prepare',
      input: inlineRef(refs.prepare.input, options.request ?? prepareRequest()),
    },
    callContext(),
  )
  if (!prepared?.ok || prepared.value.kind !== 'inline') throw new Error('prepare failed')
  const result = validateRuntime('ModelPrepareResult', prepared.value.value)
  if (!result.ok || result.value.preparedRef.kind !== 'inline') throw new Error('bad prepare result')
  const ref = result.value.preparedRef
  const stop = new AbortController()
  const factory = model.provider.actions?.infer
  if (!factory) throw new Error('infer missing')
  const action = await factory.create({
    instanceId: 'instance',
    actionId: 'parent-1',
    runId: 'run-1',
    bindingId: fixtureOwner.bindingId,
    scope: runScope(),
    signal: stop.signal,
  })
  if (action.kind !== 'composite') throw new Error('infer is not composite')
  if (options.aborted) stop.abort()
  return {
    ...model,
    action,
    ref,
    peer: restrictedPeer({}),
    frame: actionFrame('infer', inlineRef(refs.infer.input, { preparedRef: ref }), frameOver),
    setAdapter: (next: Select) => {
      select = next
    },
    abort: () => stop.abort(),
  }
}
type Setup = Awaited<ReturnType<typeof startInfer>>
type PreparedRef = Setup['ref']

describe('model infer: start', () => {
  it('creates exactly one child with a stable key, the original reference, the adapter target and no retry', async () => {
    const s = await startInfer()
    const out = await s.action.start(s.frame, s.peer.ports)
    expect(out.children).toHaveLength(1)
    const child = out.children[0]
    if (!child) throw new Error('no child')
    expect(child).toMatchObject({
      key: INFER_CHILD_KEY,
      target: fixtureAdapter,
      method: 'invoke',
      obligation: 'mandatory',
      retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
      dependencies: [],
      references: [],
    })
    expect(child.resultSchema).toEqual(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output)
    expect(Date.parse(child.deadline)).toBeLessThanOrEqual(Date.parse(s.frame.context.deadline))
    const input = validateRuntime(
      'ModelAdapterInvokeRequest',
      child.input.kind === 'inline' ? child.input.value : null,
    )
    if (!input.ok) throw new Error('bad child input')
    expect(input.value.preparedCallRef).toEqual(s.ref)
    expect(input.value.externalIdempotencyKey).toBe(externalKeyOf('run-1', 'parent-1'))
    expect(out.next).toMatchObject({ kind: 'wait' })
  })
  it('checks the parent input, the prepared reference and the child input separately', async () => {
    const s = await startInfer()
    expect(s.frame.inputDigest).not.toBe(s.ref.digest)
    const out = await s.action.start(s.frame, s.peer.ports)
    expect(out.next.kind).toBe('wait')
  })
  it('never calls the adapter itself and never reads a secret or the network while deciding', async () => {
    const s = await startInfer()
    await s.action.start(s.frame, s.peer.ports)
    expect(s.peer.deliveries()).toBe(0)
    expect(s.counters.network).toBe(0)
  })
  it.each([
    [
      'an adapter that is no longer selected',
      (s: Setup) => s.setAdapter(() => null),
      'model_adapter_unavailable',
    ],
    [
      'another adapter selected than the one prepared for',
      (s: Setup) =>
        s.setAdapter(() => ({ binding: { ...fixtureAdapter, bindingId: 'other' }, packageDigest: 'p' })),
      'model_target_changed',
    ],
  ])('refuses %s with no child', async (_name, tweak, detailCode) => {
    const s = await startInfer()
    tweak(s)
    const out = await s.action.start(s.frame, s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode } })
  })
  it.each([
    [
      'a prepared reference whose digest does not match its body',
      (ref: PreparedRef) => ({ ...ref, digest: 'e'.repeat(64) }),
    ],
    [
      'a prepared reference whose byte count is wrong',
      (ref: PreparedRef) => ({ ...ref, bytes: ref.bytes + 1 }),
    ],
    [
      'a prepared reference under another schema',
      (ref: PreparedRef) => ({ ...ref, schema: refs.infer.output }),
    ],
  ])('refuses %s with no child', async (_name, forge) => {
    const s = await startInfer()
    const input = inlineRef(refs.infer.input, { preparedRef: forge(s.ref) })
    const out = await s.action.start(actionFrame('infer', input), s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_infer_input' } })
  })
  it('refuses a prepared request that another binding owns, even with a consistent reference', async () => {
    const s = await startInfer()
    const parsed = validateRuntime('PreparedModelRequest', s.ref.value)
    if (!parsed.ok) throw new Error('bad prepared')
    const foreign = assemblePrepared({
      owner: { ...fixtureOwner, bindingId: 'other-owner' },
      request: prepareRequest(),
      capture: modelCaptureOf('package-1', fixturePick()),
      wire: fixtureWire,
      estimatedUnits: [],
    })
    if (!foreign.ok) throw new Error('assemble')
    const input = inlineRef(refs.infer.input, { preparedRef: foreign.value.ref })
    const out = await s.action.start(actionFrame('infer', input), s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_binding_denied' } })
  })
  it('refuses a frame whose method, binding, run or input digest is not this action', async () => {
    const s = await startInfer()
    const frames: Partial<W.ActionFrame>[] = [
      { method: 'prepare' },
      { runId: 'foreign' },
      { bindingId: 'foreign' },
      { inputDigest: 'f'.repeat(64) },
    ]
    for (const bad of frames) {
      const out = await s.action.start({ ...s.frame, ...bad }, s.peer.ports)
      expect(out.children).toHaveLength(0)
      expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_binding_denied' } })
    }
  })
  it('fails with cancelled and no child when the call is already aborted', async () => {
    const s = await startInfer({}, {}, { aborted: true })
    const out = await s.action.start(s.frame, s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({ kind: 'fail', error: { code: 'cancelled' } })
  })
})

describe('model infer: resume', () => {
  async function started() {
    const s = await startInfer()
    const out = await s.action.start(s.frame, s.peer.ports)
    const spec = out.children[0]
    if (!spec) throw new Error('no child')
    const committed = s.peer.commit('parent-1', spec)
    if (!committed.ok) throw new Error('commit')
    const child = committed.value
    const resumed = (items: W.ReceiptRef[]): W.ActionFrame => ({
      ...s.frame,
      providerRevision: 1,
      continuation: out.continuation,
      receipts: { items, snapshot: 's', nextCursor: null, complete: true },
    })
    const receipt = (outcome: W.ReceiptRef['outcome'], actionId = child.actionId): W.ReceiptRef[] => [
      { actionId, receiptId: 'receipt-1', outcome },
    ]
    return { ...s, out, spec, child, resumed, receipt }
  }
  it('completes with the child output re-encoded under the infer schema, carrying only the child usage', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'succeeded')
    const view = s.peer.publish(s.child, 'receipt-1')
    const out = await s.action.resume(s.resumed(s.receipt('succeeded')), s.peer.ports)
    expect(out.children).toHaveLength(0)
    if (out.next.kind !== 'complete' || out.next.output.kind !== 'inline') throw new Error('not complete')
    expect(out.next.output.schema).toEqual(refs.infer.output)
    const output = validateRuntime('ModelOutput', out.next.output.value)
    if (!output.ok) throw new Error('bad output')
    expect(output.value.usageFactRefs.map((u) => u.usageId)).toEqual(view.usageRefs)
    expect(s.peer.deliveries()).toBe(1)
  })
  it('refuses a result whose usage reference is not in the child usage', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'succeeded', { foreignUsage: true })
    s.peer.publish(s.child, 'receipt-1')
    const out = await s.action.resume(s.resumed(s.receipt('succeeded')), s.peer.ports)
    expect(out.next).toMatchObject({
      kind: 'fail',
      error: { code: 'denied', detailCode: 'model_usage_attribution' },
    })
  })
  it('passes a failed child through unchanged, including a refresh-required detail, and starts no second child', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'failed')
    s.peer.publish(s.child, 'receipt-1')
    const out = await s.action.resume(s.resumed(s.receipt('failed')), s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'credential_refresh_required' } })
  })
  it('keeps waiting while the child is unknown, creates no second child, and fails as unknown at the deadline', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'unknown_effect')
    s.peer.publish(s.child, 'receipt-1')
    const waiting = await s.action.resume(s.resumed(s.receipt('unknown_effect')), s.peer.ports)
    expect(waiting.children).toHaveLength(0)
    expect(waiting.next.kind).toBe('wait')
    const late = {
      ...s.resumed(s.receipt('unknown_effect')),
      context: { ...s.frame.context, deadline: new Date(Date.now() - 1000).toISOString() },
    }
    const out = await s.action.resume(late, s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next).toMatchObject({
      kind: 'fail',
      error: { code: 'unknown_effect', detailCode: 'model_child_unknown' },
    })
  })
  it('ignores a receipt of another action, and never creates a child on resume', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'succeeded')
    s.peer.publish(s.child, 'receipt-1')
    const foreign = await s.action.resume(s.resumed(s.receipt('succeeded', 'someone-else')), s.peer.ports)
    expect(foreign.children).toHaveLength(0)
    expect(foreign.next.kind).toBe('wait')
  })
  it('ignores a published result that belongs to another input of the same adapter', async () => {
    const s = await started()
    const sibling = s.peer.ports.prepare({
      key: 'other',
      target: fixtureAdapter,
      method: 'invoke',
      input: inlineRef(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.input, { other: true }),
      dependencies: [],
      retry: { mode: 'never', maxAttempts: 1, backoffMs: [] },
      obligation: 'mandatory',
      deadline: s.frame.context.deadline,
      resultSchema: RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output,
      references: [],
    })
    if (!sibling.ok) throw new Error('prepare')
    const other = s.peer.commit('parent-1', sibling.value)
    if (!other.ok) throw new Error('commit')
    await s.peer.dispatch(other.value, 'succeeded')
    s.peer.publish(other.value, 'receipt-1')
    const out = await s.action.resume(s.resumed(s.receipt('succeeded', other.value.actionId)), s.peer.ports)
    expect(out.children).toHaveLength(0)
    expect(out.next.kind).toBe('wait')
  })
  it('refuses a continuation that was saved for another request', async () => {
    const s = await started()
    const request = prepareRequest({ generation: { maxOutputTokens: 33, thinking: null } })
    const other = await startInfer({}, {}, { request })
    const foreign = await other.action.start(other.frame, other.peer.ports)
    const out = await s.action.resume({ ...s.resumed([]), continuation: foreign.continuation }, s.peer.ports)
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_continuation_conflict' } })
  })
  it('interrupts a pending result read when the call is cancelled', async () => {
    const s = await started()
    await s.peer.dispatch(s.child, 'succeeded')
    s.peer.publish(s.child, 'receipt-1')
    let began = () => {}
    const waiting = new Promise<void>((resolve) => {
      began = resolve
    })
    const pending = s.action.resume(s.resumed(s.receipt('succeeded')), {
      ...s.peer.ports,
      query: () => {
        began()
        return new Promise(() => {})
      },
    })
    await waiting
    s.abort()
    expect((await pending).next).toMatchObject({ kind: 'fail', error: { code: 'cancelled' } })
  })
})

describe('model infer: child request identity', () => {
  it('binds the committed child input to the whole input reference, not to its inner digest', async () => {
    const s = await startInfer()
    const out = await s.action.start(s.frame, s.peer.ports)
    const spec = out.children[0]
    if (!spec || spec.input.kind !== 'inline') throw new Error('no child')
    const identity = requestIdentityOf(spec)
    const request = validateRuntime('ModelAdapterInvokeRequest', spec.input.value)
    if (!request.ok) throw new Error('bad child input')
    expect(identity.idempotencyKey).toBe(request.value.externalIdempotencyKey)
    expect(identity.requestDigest).toBe(canonicalJsonDigest(spec.input))
    expect(identity.requestDigest).not.toBe(spec.input.digest)
    expect(identity.requestDigest).not.toBe(s.ref.digest)
  })
})

describe('model infer: stable identity under the restricted peer', () => {
  it('returns the original child for the same key and refuses another fingerprint', async () => {
    const s = await startInfer()
    const out = await s.action.start(s.frame, s.peer.ports)
    const spec = out.children[0]
    if (!spec) throw new Error('no child')
    const a = s.peer.commit('parent-1', spec)
    const b = s.peer.commit('parent-1', spec)
    expect(a.ok && b.ok && a.value.actionId === b.value.actionId).toBe(true)
    const changed = { ...spec, intentFingerprint: 'c'.repeat(64) }
    expect(s.peer.commit('parent-1', changed)).toMatchObject({
      ok: false,
      error: { detailCode: 'idempotency_conflict' },
    })
  })
})
