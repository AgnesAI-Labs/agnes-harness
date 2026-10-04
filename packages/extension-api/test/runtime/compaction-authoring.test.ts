import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { type AlgorithmAdapterDefinition, runtimeAuthorSchemas } from '../../src/runtime/authoring.js'
import { createAuthorSchema } from '../../src/runtime/authoring-schema-core.js'
import { createCompactionAuthorMethods } from '../../src/runtime/compaction-authoring.js'
import type * as Local from '../../src/runtime/public-api.js'
import { createTestServiceContainer } from '../../testkit/runtime/harness.js'

const binding: Wire.BindingRef = {
  bindingId: 'compaction',
  contract: 'agh.compaction',
  logicalName: 'default',
  providerId: 'test/compaction',
}
const scope: Wire.ScopeRef = {
  kind: 'session',
  installationId: 'i',
  runtimeId: 'rt',
  workspaceId: 'w',
  sessionId: 's',
}
const call: Local.CallContext = {
  scope,
  bindingId: binding.bindingId,
  invocationId: 'invocation',
  principalRef: 'p',
  authorizationRef: 'auth',
  traceRef: 'trace',
  deadline: '2099-01-01T00:00:00Z',
  signal: new AbortController().signal,
}
const schemas = RuntimeMethodSchemaRefs['agh.compaction']
function data(name: keyof Wire.RuntimeWireTypes, ref: Wire.SchemaRef, value: unknown): Wire.DataRef {
  const result = createAuthorSchema(ref, (input) => validateRuntime(name, input)).encode(value as never)
  if (!result.ok) throw result.error
  return result.value
}
const authorState = runtimeAuthorSchemas.StandardToolOutput.encode({ content: [], structured: { step: 1 } })
if (!authorState.ok) throw authorState.error
const codec: Wire.StateCodecRef = {
  namespace: 'test/compaction-state',
  codecVersion: '1',
  schema: runtimeAuthorSchemas.StandardToolOutput.ref,
}
const continuation: Wire.VersionedState = {
  namespace: codec.namespace,
  codecVersion: codec.codecVersion,
  data: authorState.value,
  provenance: { sourceRefs: [], producer: binding, trustLabels: [] },
  createdAt: '2026-10-03T00:00:00Z',
  references: [],
}
const viewContent = {
  viewId: 'view',
  format: 'chat',
  schema: RuntimeMethodSchemaRefs['agh.context'].view.output,
  baseRevision: 1,
  items: [],
  tokenEstimate: 0,
  protectedRefs: [],
  inputDigest: canonicalJsonDigest([]),
  runtimeInstructionRefs: [],
}
const view: Wire.ContextView = { ...viewContent, digest: canonicalJsonDigest(viewContent) }
const plan: Wire.CompactionPlan = {
  planId: 'plan',
  baseRevision: 1,
  inputDigest: canonicalJsonDigest([]),
  decision: 'noop',
  reasonCodes: ['empty'],
  algorithm: binding,
  privatePlan: authorState.value,
  outputCodec: codec.schema,
  preservedRefs: [],
  sourceRanges: [],
}
const planOutput = data('CompactionPlan', schemas.plan.output, plan)
const request: Wire.ServiceOperation = {
  target: binding,
  method: 'plan',
  input: data('CompactionPlanRequest', schemas.plan.input, {
    view,
    limitTokens: 100,
    trigger: 'manual',
    protectedRefs: [],
    instructions: null,
    hookResults: null,
  }),
}
const result: Wire.CompactionResult = {
  compactionId: 'compaction',
  viewRevision: 1,
  summaryRefs: [],
  expandedHistoryRef: { authorityId: 'a', typeId: 'test/history@1', id: 'history', revision: 1 },
  preservedRefs: [],
}
const lifecycle: Local.ProviderLifecycle = {
  ready: async () => ({ ok: true, value: undefined }),
  health: async () => ({ ok: true, value: { status: 'ready', diagnosticIds: [] } }),
  drain: async () => ({
    ok: true,
    value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
  }),
  close: async () => {},
}
const ports: Local.LoopReadPorts = {
  query: async () => {
    throw new Error('no query allowed')
  },
  compute: async () => {
    throw new Error('no compute allowed')
  },
  resolveData: async () => {
    throw new Error('no resolution allowed')
  },
  prepare: () => {
    throw new Error('no preparation allowed')
  },
}
function definition(
  options: { capture?: (ports: Local.LoopReadPorts) => void; wait?: Promise<void> } = {},
): AlgorithmAdapterDefinition<'agh.compaction'> {
  function action(method: 'execute' | 'apply'): Local.ActionProviderFactory {
    const output =
      method === 'execute'
        ? data('CompactionResult', schemas.execute.output, result)
        : data('CompactionApplyResult', schemas.apply.output, { viewRevision: 1 })
    const transition = async (
      frame: Wire.ActionFrame,
      ports: Local.LoopReadPorts,
    ): Promise<Wire.ProviderTransition> => {
      options.capture?.(ports)
      await options.wait
      return {
        expectedProviderRevision: frame.providerRevision,
        continuation: frame.continuation ?? continuation,
        consumeSignals: [],
        children: [],
        next: frame.continuation ? { kind: 'complete', output, references: [] } : { kind: 'continue' },
      }
    }
    return {
      kind: 'composite',
      recovery: 'R2',
      stateCodec: codec,
      create: async () => ({ ...lifecycle, kind: 'composite', start: transition, resume: transition }),
    }
  }
  return {
    id: 'compaction',
    contract: 'agh.compaction',
    requires: [],
    permissions: [],
    stateCodecs: [codec],
    make: () => ({
      plan: async () => ({ ok: true, value: planOutput }),
      expand: async () => ({
        ok: true,
        value: {
          kind: 'value',
          snapshot: 'snapshot',
          output: data('CompactionExpandResult', schemas.expand.output, {
            items: [],
            snapshot: 'snapshot',
            nextCursor: null,
            complete: true,
          }),
        },
      }),
      execute: action('execute'),
      apply: action('apply'),
    }),
  }
}
async function create(value = definition()) {
  const adapter = await createCompactionAuthorMethods(value, {
    binding,
    context: { bindingId: binding.bindingId, instanceId: 'instance', scope, signal: call.signal },
    dependencies: createTestServiceContainer().dependencies,
    config: null,
  })
  expect(await adapter.ready(call)).toEqual({ ok: true, value: undefined })
  return adapter
}
function frame(method: 'execute' | 'apply', state: Wire.VersionedState | null = null): Wire.ActionFrame {
  const input =
    method === 'execute'
      ? data('CompactionExecuteRequest', schemas.execute.input, { plan, expectedRevision: 1 })
      : data('CompactionApplyRequest', schemas.apply.input, {
          plan,
          expectedRevision: 1,
          result,
          childReceiptRefs: [],
        })
  const { signal: _signal, ...context } = call
  return {
    actionId: 'action',
    parentActionId: null,
    runId: 'r',
    bindingId: binding.bindingId,
    method,
    input,
    inputDigest: input.kind === 'inline' ? input.digest : '',
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: call.invocationId,
    requestIdentity: null,
    providerRevision: state ? 1 : 0,
    continuation: state,
    signals: { items: [], nextCursor: null, complete: true, snapshot: 'snapshot' },
    receipts: { items: [], nextCursor: null, complete: true, snapshot: 'snapshot' },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: '2026-10-03T00:00:00Z',
    context,
    actionTimebox: { defaultTimeoutMs: 1000, maxDeadline: call.deadline },
  }
}

describe('Compaction author method slice', () => {
  it('exposes plan, expand, execute and apply with official output schemas', async () => {
    const adapter = await create()
    expect(Object.keys(adapter.methods).sort()).toEqual(['apply', 'execute', 'expand', 'plan'])
    const container = createTestServiceContainer()
    const requirement: Wire.ServiceRequirement = {
      contract: binding.contract,
      logicalName: 'default',
      major: 1,
      scope: 'session',
      features: [],
      optional: false,
    }
    container.register({ binding, requirement, compute: adapter.methods.plan, query: adapter.methods.expand })
    const service = container.dependencies.get(requirement)
    if (!service.ok) throw service.error
    expect(await service.value.compute(request, call)).toEqual({ ok: true, value: planOutput })
    const query: Wire.ServiceQuery = {
      target: binding,
      method: 'expand',
      snapshot: 'snapshot',
      input: data('CompactionExpandRequest', schemas.expand.input, {
        compactionId: 'compaction',
        sourceRange: {
          session: { sessionId: 's', authority: { authorityId: 'a', tenantId: 't', authorityEpoch: 1 } },
          fromSeq: 0,
          toSeq: 1,
          digest: canonicalJsonDigest([]),
        },
        cursor: null,
        limit: 10,
      }),
    }
    expect(await service.value.query(query, call)).toMatchObject({
      ok: true,
      value: { kind: 'value', snapshot: 'snapshot' },
    })
    expect(await adapter.methods.plan({ ...request, method: 'preparePlan' }, call)).toMatchObject({
      ok: false,
    })
    await adapter.close('completed')
  })

  it.each(['execute', 'apply'] as const)(
    'restores %s from caller-provided continuation without changing the input',
    async (method) => {
      let retained: Local.LoopReadPorts | undefined
      const original = await create(
        definition({
          capture: (ports) => {
            retained = ports
          },
        }),
      )
      const actionScope = {
        instanceId: 'child',
        actionId: 'action',
        runId: 'r',
        bindingId: binding.bindingId,
        scope,
        signal: call.signal,
      }
      const first = await original.methods[method].create(actionScope)
      if (first.kind !== 'composite') throw new Error('composite required')
      const step = await first.start(frame(method), ports)
      await expect(first.start({ ...frame(method), attemptNumber: 0 }, ports)).rejects.toMatchObject({
        detailCode: 'action_not_dispatchable',
      })
      await expect(first.start({ ...frame(method), attemptNumber: 2 }, ports)).rejects.toMatchObject({
        detailCode: 'action_not_dispatchable',
      })
      await expect(first.resume(frame(method), ports)).rejects.toMatchObject({
        detailCode: 'action_phase_mismatch',
      })
      if (!retained) throw new Error('ports expected')
      await expect(retained.query({ ...request })).rejects.toMatchObject({ detailCode: 'invocation_closed' })
      expect(step.next).toEqual({ kind: 'continue' })
      await original.close('shutdown')
      const restored = await create()
      const second = await restored.methods[method].create(actionScope)
      if (second.kind !== 'composite') throw new Error('composite required')
      const resumed = await second.resume(frame(method, step.continuation), ports)
      await expect(second.start(frame(method, step.continuation), ports)).rejects.toMatchObject({
        detailCode: 'action_phase_mismatch',
      })
      expect(resumed).toMatchObject({
        expectedProviderRevision: 1,
        continuation: step.continuation,
        next: { kind: 'complete' },
      })
      expect(resumed.continuation.data).toEqual(authorState.value)
      await expect(
        second.resume(frame(method, { ...step.continuation, codecVersion: 'foreign' }), ports),
      ).rejects.toMatchObject({ detailCode: 'state_codec_mismatch' })
      const malformed = data('JsonValue', codec.schema, { wrong: 'state' })
      await expect(
        second.resume(frame(method, { ...step.continuation, data: malformed }), ports),
      ).rejects.toMatchObject({ detailCode: 'author_schema_invalid' })
      await expect(
        second.resume({ ...frame(method, step.continuation), bindingId: 'foreign' }, ports),
      ).rejects.toMatchObject({ detailCode: 'action_frame_mismatch' })
      await expect(
        second.resume({ ...frame(method, step.continuation), invocationId: 'foreign' }, ports),
      ).rejects.toMatchObject({ detailCode: 'action_frame_mismatch' })
      await restored.close('completed')
    },
  )

  it('refuses a revoked dependency on construction and incompatible scopes', async () => {
    const required: Wire.ServiceRequirement = {
      contract: 'agh.context',
      logicalName: 'default',
      major: 1,
      scope: 'run',
      features: [],
      optional: false,
    }
    await expect(create({ ...definition(), requires: [required] })).rejects.toMatchObject({
      detailCode: 'service_not_registered',
    })
    const adapter = await create()
    await expect(
      adapter.methods.execute.create({
        instanceId: 'child',
        actionId: 'action',
        runId: 'r',
        bindingId: binding.bindingId,
        scope: { ...scope, sessionId: 'foreign' } as Wire.ScopeRef,
        signal: call.signal,
      }),
    ).rejects.toMatchObject({ detailCode: 'action_scope_mismatch' })
    for (const nested of [
      { ...scope, kind: 'run', runId: 'foreign' },
      { ...scope, kind: 'action', runId: 'r', actionId: 'foreign' },
    ] as const) {
      await expect(
        adapter.methods.execute.create({
          instanceId: 'child',
          actionId: 'action',
          runId: 'r',
          bindingId: binding.bindingId,
          scope: nested,
          signal: call.signal,
        }),
      ).rejects.toMatchObject({ detailCode: 'action_scope_mismatch' })
    }
    const cancellation = new AbortController()
    cancellation.abort()
    expect(await adapter.methods.plan(request, { ...call, signal: cancellation.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
  })

  it('discards an uncommitted transition after closing its child and seals retained ports', async () => {
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let retained: Local.LoopReadPorts | undefined
    const adapter = await create(
      definition({
        wait,
        capture: (ports) => {
          retained = ports
        },
      }),
    )
    const action = await adapter.methods.execute.create({
      instanceId: 'child',
      actionId: 'action',
      runId: 'r',
      bindingId: binding.bindingId,
      scope,
      signal: call.signal,
    })
    if (action.kind !== 'composite') throw new Error('composite expected')
    const pending = action.start(frame('execute'), ports).then(
      () => null,
      (error: unknown) => error,
    )
    const otherFrame = frame('execute')
    otherFrame.invocationId = 'second'
    otherFrame.context.invocationId = 'second'
    const overlapping = action.start(otherFrame, ports).then(
      () => null,
      (error: unknown) => error,
    )
    await action.close('cancelled')
    if (!retained) throw new Error('ports expected')
    await expect(retained.compute(request)).rejects.toMatchObject({ code: 'cancelled' })
    release()
    expect(await pending).toMatchObject({ code: 'cancelled' })
    expect(await overlapping).toMatchObject({ detailCode: 'action_active' })
    await adapter.close('completed')

    let releaseRead: () => void = () => {}
    const waitRead = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let reading: Promise<unknown> | undefined
    const outstanding = await create(
      definition({
        capture: (ports) => {
          reading = ports.query({ ...request })
          void ports.query({ ...request })
        },
      }),
    )
    const child = await outstanding.methods.execute.create({
      instanceId: 'child',
      actionId: 'action',
      runId: 'r',
      bindingId: binding.bindingId,
      scope,
      signal: call.signal,
    })
    if (child.kind !== 'composite') throw new Error('composite expected')
    await expect(
      child.start(frame('execute'), {
        ...ports,
        query: async () => {
          await waitRead
          return { ok: true, value: { kind: 'value', output: authorState.value, snapshot: 'snapshot' } }
        },
      }),
    ).rejects.toMatchObject({ detailCode: 'unsettled_reads' })
    expect(await outstanding.drain('2000-01-01T00:00:00Z', call)).toMatchObject({
      value: { state: 'blocked' },
    })
    releaseRead()
    await expect(reading).rejects.toMatchObject({ code: 'cancelled' })
    expect(await outstanding.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
    await outstanding.close('completed')
  })
})
