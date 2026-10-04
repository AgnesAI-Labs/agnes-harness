import type * as Wire from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type AlgorithmAdapterDefinition, runtimeAuthorSchemas } from '../../src/runtime/authoring.js'
import { createAuthorSchema } from '../../src/runtime/authoring-schema-core.js'
import {
  type AlgorithmAuthorEnvironment,
  createContextAuthorMethods,
} from '../../src/runtime/context-authoring.js'
import type * as Local from '../../src/runtime/public-api.js'
import { createRestrictedEffectsFixture } from '../../testkit/runtime/effects.js'
import { createTestServiceContainer } from '../../testkit/runtime/harness.js'

const binding: Wire.BindingRef = {
  bindingId: 'context',
  contract: 'agh.context',
  logicalName: 'default',
  providerId: 'test/context',
}
const scope: Wire.ScopeRef = {
  kind: 'run',
  installationId: 'i',
  runtimeId: 'rt',
  workspaceId: 'w',
  sessionId: 's',
  runId: 'r',
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
function data(name: keyof Wire.RuntimeWireTypes, ref: Wire.SchemaRef, value: unknown): Wire.DataRef {
  const result = createAuthorSchema(ref, (input) => validateRuntime(name, input)).encode(value as never)
  if (!result.ok) throw result.error
  return result.value
}
const request: Wire.ServiceQuery = {
  target: binding,
  method: 'view',
  snapshot: 'snapshot',
  input: data('ContextViewRequest', RuntimeMethodSchemaRefs['agh.context'].view.input, {
    sessionRef: { sessionId: 's', authority: { authorityId: 'a', tenantId: 't', authorityEpoch: 1 } },
    atRevision: 1,
    target: { modelRoute: 'model', format: 'chat', tokenLimit: 200 },
    resourceRefs: [],
    purpose: 'test',
    contributions: {
      digest: canonicalJsonDigest([]),
      registrationDigest: canonicalJsonDigest([]),
      sections: [],
      runtimeContext: [],
      candidateTools: [],
      conflictDiagnostics: [],
    },
    hookResults: null,
  }),
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
const output = data('ContextView', RuntimeMethodSchemaRefs['agh.context'].view.output, {
  ...viewContent,
  digest: canonicalJsonDigest(viewContent),
})
const lifecycle: Local.ProviderLifecycle = {
  ready: async () => ({ ok: true, value: undefined }),
  health: async () => ({ ok: true, value: { status: 'ready', diagnosticIds: [] } }),
  drain: async () => ({
    ok: true,
    value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
  }),
  close: async () => {},
}
function definition(
  view: Local.QueryHandler = async () => ({
    ok: true,
    value: { kind: 'value', output, snapshot: 'snapshot' },
  }),
  refresh?: Local.ActionProviderFactory,
): AlgorithmAdapterDefinition<'agh.context'> {
  return {
    id: 'context',
    contract: 'agh.context',
    requires: [],
    permissions: [],
    make: () => ({
      view,
      refresh: refresh ?? {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        create: async () => ({
          ...lifecycle,
          kind: 'leaf',
          effectSemantics: 'non-idempotent',
          execute: async () => ({
            outcome: 'unknown_effect',
            externalRequests: [],
            usage: [],
            references: [],
          }),
          reconcile: async () => {
            throw new Error('no evidence')
          },
        }),
      },
    }),
  }
}
async function create(
  value = definition(),
  controls: Pick<AlgorithmAuthorEnvironment, 'childDrainContext'> = {},
) {
  const container = createTestServiceContainer()
  const adapter = await createContextAuthorMethods(value, {
    binding,
    context: { bindingId: binding.bindingId, instanceId: 'instance', scope, signal: call.signal },
    dependencies: container.dependencies,
    config: null,
    ...controls,
  })
  expect(await adapter.ready(call)).toEqual({ ok: true, value: undefined })
  return adapter
}
function frame(): Wire.ActionFrame {
  const input = data('ContextRefreshRequest', RuntimeMethodSchemaRefs['agh.context'].refresh.input, {
    resourceRefs: [],
    expectedRevision: 1,
    reason: 'refresh',
  })
  const { signal: _signal, ...context } = call
  return {
    actionId: 'action',
    parentActionId: null,
    runId: 'r',
    bindingId: binding.bindingId,
    method: 'refresh',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : '',
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: call.invocationId,
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], nextCursor: null, complete: true, snapshot: 'snapshot' },
    receipts: { items: [], nextCursor: null, complete: true, snapshot: 'snapshot' },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: '2026-10-03T00:00:00Z',
    context,
    actionTimebox: { defaultTimeoutMs: 1000, maxDeadline: call.deadline },
  }
}

describe('Context author method slice', () => {
  it('dispatches the fixed query through a restricted service consumer and preserves its snapshot', async () => {
    const adapter = await create()
    const consumer = createTestServiceContainer()
    const requirement: Wire.ServiceRequirement = {
      contract: binding.contract,
      major: 1,
      logicalName: 'default',
      features: [],
      scope: 'run',
      optional: false,
    }
    consumer.register({ binding, requirement, query: adapter.methods.view })
    const service = consumer.dependencies.get(requirement)
    if (!service.ok) throw service.error
    expect(await service.value.query(request, call)).toEqual({
      ok: true,
      value: { kind: 'value', output, snapshot: 'snapshot' },
    })
    expect(Object.keys(adapter.methods).sort()).toEqual(['refresh', 'view'])
    expect(await adapter.drain(call.deadline, call)).toMatchObject({ ok: true, value: { state: 'drained' } })
    await adapter.close('completed')
    expect(await adapter.methods.view(request, call)).toMatchObject({ ok: false })
  })

  it.each(['binding', 'scope', 'schema', 'digest', 'version', 'blob'] as const)(
    'rejects %s before the author sees input',
    async (kind) => {
      let executed = false
      const adapter = await create(
        definition(async () => {
          executed = true
          return { ok: true, value: { kind: 'value', output, snapshot: 'snapshot' } }
        }),
      )
      const input = structuredClone(request)
      const context = { ...call }
      if (kind === 'binding') input.target.providerId = 'foreign'
      if (kind === 'scope') context.scope = { ...scope, runId: 'foreign' } as Wire.ScopeRef
      if (kind === 'schema') input.input.schema = RuntimeMethodSchemaRefs['agh.context'].refresh.input
      if (kind === 'version') input.input.schema.revision++
      if (kind === 'digest' && input.input.kind === 'inline') input.input.digest = 'a'.repeat(64)
      if (kind === 'blob')
        input.input = {
          kind: 'blob',
          schema: input.input.schema,
          blob: {
            authorityId: 'a',
            blobId: 'b',
            digest: 'a'.repeat(64),
            bytes: 1,
            mediaType: 'application/json',
            pinId: 'pin',
          },
        }
      expect(await adapter.methods.view(input, context)).toMatchObject({ ok: false })
      expect(executed).toBe(false)
    },
  )

  it('rejects output schema and pagination drift, and contains author exceptions', async () => {
    for (const handler of [
      async () => ({ ok: true as const, value: { kind: 'value' as const, output, snapshot: 'drift' } }),
      async () => ({
        ok: true as const,
        value: {
          kind: 'value' as const,
          output: data('ContextView', RuntimeMethodSchemaRefs['agh.context'].view.output, {
            ...viewContent,
            digest: canonicalJsonDigest([]),
          }),
          snapshot: 'snapshot',
        },
      }),
      async () => ({
        ok: true as const,
        value: { kind: 'value' as const, output: request.input, snapshot: 'snapshot' },
      }),
      async () => {
        throw new Error('private details')
      },
    ]) {
      const adapter = await create(definition(handler))
      const result = await adapter.methods.view(request, call)
      expect(result).toMatchObject({ ok: false })
      expect(JSON.stringify(result)).not.toContain('private details')
    }
  })

  it('observes cancellation during a pure invocation without returning stale success', async () => {
    const controller = new AbortController()
    const adapter = await create(
      definition(async (_request, context) => {
        controller.abort()
        expect(context.signal.aborted).toBe(true)
        return { ok: true, value: { kind: 'value', output, snapshot: 'snapshot' } }
      }),
    )
    expect(await adapter.methods.view(request, { ...call, signal: controller.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    expect(await adapter.methods.view(request, { ...call, deadline: '2000-01-01T00:00:00Z' })).toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    })
    const rejected = new AbortController()
    const throws = await create(
      definition(async () => {
        rejected.abort()
        throw new Error('aborted author')
      }),
    )
    expect(await throws.methods.view(request, { ...call, signal: rejected.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })
    let release: () => void = () => {}
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const stubborn = await create(
      definition(async () => {
        await waiting
        return { ok: true, value: { kind: 'value', output, snapshot: 'snapshot' } }
      }),
    )
    const abort = new AbortController()
    let returned = false
    const pending = stubborn.methods.view(request, { ...call, signal: abort.signal }).then((value) => {
      returned = true
      return value
    })
    abort.abort()
    for (let count = 0; count < 20; count++) await Promise.resolve()
    const returnedBeforeAuthor = returned
    expect(await stubborn.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'blocked' } })
    release()
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(returnedBeforeAuthor).toBe(true)
    for (let count = 0; count < 20; count++) await Promise.resolve()
    expect(await stubborn.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'drained' } })
  })

  it('drains cooperative work and retains child owners within the control deadline', async () => {
    const childScope: Wire.ScopeRef = { ...scope, kind: 'action', actionId: 'action' }
    const issued: Local.CallContext = {
      ...call,
      scope: childScope,
      invocationId: 'host-child-control',
      principalRef: 'host-controller',
      authorizationRef: 'host-child-authorization',
      traceRef: 'host-child-trace',
      signal: new AbortController().signal,
    }
    const aborted = new AbortController()
    aborted.abort()
    const cancelledControl = new AbortController()
    let closeWhileIssuing: () => Promise<void> = async () => {}
    const refusedControls: {
      resolve?: AlgorithmAuthorEnvironment['childDrainContext']
      control?: Local.CallContext
      closePending?: boolean
    }[] = [
      {},
      { resolve: async () => ({ ok: true, value: call }) },
      { resolve: async () => ({ ok: true, value: { ...issued, bindingId: 'foreign' } }) },
      { resolve: async () => ({ ok: true, value: { ...issued, deadline: '2000-01-01T00:00:00Z' } }) },
      { resolve: async () => ({ ok: true, value: { ...issued, signal: aborted.signal } }) },
      { resolve: async () => ({ ok: true, value: { ...issued, signal: undefined as never } }) },
      {
        resolve: async () => {
          cancelledControl.abort()
          return { ok: true, value: issued }
        },
        control: { ...call, signal: cancelledControl.signal },
      },
      {
        resolve: async () => {
          await closeWhileIssuing()
          return { ok: true, value: issued }
        },
      },
      {
        resolve: async () => {
          void closeWhileIssuing()
          return { ok: true, value: issued }
        },
        closePending: true,
      },
    ]
    for (const { resolve: childDrainContext, control = call, closePending } of refusedControls) {
      let drained = false
      let releaseClose: () => void = () => {}
      const closeGate = new Promise<void>((resolve) => {
        releaseClose = resolve
      })
      let childClose: Promise<void> | undefined
      const refused = await create(
        definition(undefined, {
          kind: 'leaf',
          recovery: 'R1',
          stateCodec: null,
          create: async () => ({
            ...lifecycle,
            kind: 'leaf',
            effectSemantics: 'non-idempotent',
            execute: async () => ({
              outcome: 'unknown_effect',
              externalRequests: [],
              usage: [],
              references: [],
            }),
            reconcile: async () => ({ kind: 'unknown', evidence: output, reason: 'pending' }),
            drain: async () => {
              drained = true
              return lifecycle.drain(call.deadline, issued)
            },
            close: async () => {
              if (closePending) await closeGate
            },
          }),
        }),
        childDrainContext ? { childDrainContext } : {},
      )
      const child = await refused.methods.refresh.create({
        instanceId: 'child',
        actionId: 'action',
        runId: 'r',
        bindingId: binding.bindingId,
        scope: childScope,
        signal: call.signal,
      })
      closeWhileIssuing = () => {
        childClose = child.close('completed')
        return childClose
      }
      try {
        const result = await refused.drain(call.deadline, control)
        expect(result).toMatchObject(
          control.signal.aborted
            ? { ok: false, error: { code: 'cancelled' } }
            : { value: { state: 'blocked' } },
        )
        if (childDrainContext === undefined)
          expect(result).toMatchObject({ value: { diagnosticIds: ['author-child-drain-context-required'] } })
        expect(drained).toBe(false)
      } finally {
        releaseClose()
        await childClose
        await refused.close('completed')
      }
    }
    let settled = false
    const adapter = await create(
      definition(async (_request, context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        await Promise.resolve()
        settled = true
        return { ok: true, value: { kind: 'value', output, snapshot: 'snapshot' } }
      }),
    )
    const pending = adapter.methods.view(request, call)
    expect(await adapter.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
    expect(settled).toBe(true)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(await adapter.drain('invalid', call)).toMatchObject({ ok: false })
    const cancelled = new AbortController()
    cancelled.abort()
    expect(await adapter.drain(call.deadline, { ...call, signal: cancelled.signal })).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    })

    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let hanging = false
    const owned = await create(
      definition(undefined, {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        create: async () => ({
          ...lifecycle,
          kind: 'leaf',
          effectSemantics: 'non-idempotent',
          execute: async () => ({
            outcome: 'unknown_effect',
            externalRequests: [],
            usage: [],
            references: [],
          }),
          reconcile: async () => ({ kind: 'unknown', evidence: output, reason: 'pending' }),
          drain: async (_deadline, context) => {
            const { signal: _signal, ...received } = context
            const { signal: _issuedSignal, ...expected } = issued
            expect(received).toEqual(expected)
            expect(context.signal.aborted).toBe(false)
            if (hanging) await wait
            return {
              ok: true,
              value: {
                state: 'blocked',
                activeInvocationIds: [],
                durableOwnerRefs: [{ kind: 'reconciliation', id: 'real-owner' }],
                diagnosticIds: ['pending-owner'],
              },
            }
          },
        }),
      }),
      {
        childDrainContext: async (target, parent) => {
          expect(target).toEqual(childScope)
          expect(parent.scope).toEqual(scope)
          expect(parent.authorizationRef).toBe(call.authorizationRef)
          return { ok: true, value: issued }
        },
      },
    )
    const child = await owned.methods.refresh.create({
      instanceId: 'child',
      actionId: 'action',
      runId: 'r',
      bindingId: binding.bindingId,
      scope: childScope,
      signal: call.signal,
    })
    expect(await owned.drain(call.deadline, call)).toMatchObject({
      value: {
        state: 'blocked',
        durableOwnerRefs: [{ kind: 'reconciliation', id: 'real-owner' }],
        diagnosticIds: ['pending-owner'],
      },
    })
    hanging = true
    expect(await owned.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'blocked' } })
    const abort = new AbortController()
    const cancelledDrain = owned.drain(call.deadline, { ...call, signal: abort.signal })
    abort.abort()
    expect(await cancelledDrain).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const timer = new AbortController()
      setTimeout(() => timer.abort(new DOMException('deadline', 'TimeoutError')), milliseconds)
      return timer.signal
    })
    try {
      const deadline = new Date(Date.now() + 1000).toISOString()
      const bounded = owned.drain(deadline, call)
      await vi.advanceTimersByTimeAsync(1000)
      expect(await bounded).toMatchObject({ value: { state: 'blocked' } })
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
    await child.close('completed')
    expect(await owned.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'blocked' } })
    release()
    expect(await owned.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
    await owned.close('completed')
  })

  it('keeps unknown effect ownership and closes action handlers once', async () => {
    let closes = 0
    let retained: Local.ActionContext | undefined
    let duringReconcile: ((context: Local.ActionContext) => void) | undefined
    const adapter = await create(
      definition(undefined, {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        create: async () => ({
          ...lifecycle,
          close: async () => {
            closes++
          },
          kind: 'leaf',
          effectSemantics: 'non-idempotent',
          execute: async (_frame, context) => {
            retained = context
            return {
              outcome: 'unknown_effect',
              externalRequests: [],
              usage: [],
              references: [],
            }
          },
          reconcile: async (_frame, evidence, context) => {
            duringReconcile?.(context)
            return {
              kind: 'unknown',
              evidence: evidence[0] ?? output,
              reason: 'original request requires reconciliation',
            }
          },
        }),
      }),
    )
    const action = await adapter.methods.refresh.create({
      instanceId: 'child',
      actionId: 'action',
      runId: 'r',
      bindingId: binding.bindingId,
      scope,
      signal: call.signal,
    })
    if (action.kind !== 'leaf') throw new Error('leaf expected')
    const effects = createRestrictedEffectsFixture()
    const actionContext: Local.ActionContext = {
      call,
      effects: effects.ports,
      progress: async () => ({ ok: true, value: undefined }),
    }
    expect(await action.execute(frame(), actionContext)).toMatchObject({ outcome: 'unknown_effect' })
    const changed = data('ContextRefreshRequest', RuntimeMethodSchemaRefs['agh.context'].refresh.input, {
      resourceRefs: [],
      expectedRevision: 1,
      reason: 'drifted',
    })
    if (changed.kind !== 'inline') throw new Error('inline expected')
    await expect(
      action.execute({ ...frame(), input: changed, inputDigest: changed.digest }, actionContext),
    ).rejects.toMatchObject({ detailCode: 'action_input_changed' })
    await expect(action.execute({ ...frame(), attemptNumber: 0 }, actionContext)).rejects.toMatchObject({
      detailCode: 'action_not_dispatchable',
    })
    if (!retained) throw new Error('context expected')
    expect(() => retained?.effects.invoke({ operation: 'forbidden', input: output }, call)).toThrow()
    expect(effects.calls()).toEqual([])
    await expect(
      action.execute(
        { ...frame(), actionTimebox: { defaultTimeoutMs: 1, maxDeadline: '2000-01-01T00:00:00Z' } },
        actionContext,
      ),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(await action.reconcile(frame(), [output], actionContext)).toMatchObject({
      kind: 'unknown',
      evidence: output,
    })
    try {
      duringReconcile = (context) => {
        expect(context.call.signal.aborted).toBe(false)
      }
      expect(
        await action.reconcile(
          {
            ...frame(),
            actionTimebox: { defaultTimeoutMs: 1000, maxDeadline: '2000-01-01T00:00:00Z' },
          },
          [output],
          actionContext,
        ),
      ).toMatchObject({ kind: 'unknown' })
    } finally {
      duringReconcile = undefined
    }
    expect(await adapter.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
    await adapter.close('shutdown')
    await action.close('shutdown')
    expect(closes).toBe(1)
    await expect(action.execute(frame(), actionContext)).rejects.toMatchObject({ detailCode: 'cancelled' })
  })

  it('keeps a pending action factory visible to drain and closes a late-created handler', async () => {
    let release: () => void = () => {}
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    let releaseClose: () => void = () => {}
    const closeWait = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    let closing: () => void = () => {}
    const closeStarted = new Promise<void>((resolve) => {
      closing = resolve
    })
    let closed = false
    const adapter = await create(
      definition(undefined, {
        kind: 'leaf',
        recovery: 'R1',
        stateCodec: null,
        create: async () => {
          await wait
          return {
            ...lifecycle,
            kind: 'leaf',
            effectSemantics: 'non-idempotent',
            close: async () => {
              closing()
              await closeWait
              closed = true
            },
            execute: async () => {
              throw new Error('must not execute')
            },
            reconcile: async () => {
              throw new Error('must not reconcile')
            },
          }
        },
      }),
    )
    const pending = adapter.methods.refresh.create({
      instanceId: 'child',
      actionId: 'action',
      runId: 'r',
      bindingId: binding.bindingId,
      scope,
      signal: call.signal,
    })
    expect(await adapter.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'blocked' } })
    release()
    await closeStarted
    expect(await adapter.drain('2000-01-01T00:00:00Z', call)).toMatchObject({
      value: { state: 'blocked', activeInvocationIds: [] },
    })
    releaseClose()
    await expect(pending).rejects.toMatchObject({ detailCode: 'action_creation_closed' })
    expect(closed).toBe(true)
    expect(await adapter.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
    await adapter.close('completed')
  })

  it.each(['unknown_effect', 'succeeded'] as const)(
    'tracks pending effects after author returns %s',
    async (outcome) => {
      let release: () => void = () => {}
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      const effects = createRestrictedEffectsFixture()
      effects.allow({
        port: 'invoke',
        operation: 'refresh',
        handle: async () => {
          await wait
          return { ok: true, value: output }
        },
      })
      let pending: Promise<Local.Outcome<Wire.DataRef>> | undefined
      const adapter = await create(
        definition(undefined, {
          kind: 'leaf',
          recovery: 'R1',
          stateCodec: null,
          create: async () => ({
            ...lifecycle,
            kind: 'leaf',
            effectSemantics: 'non-idempotent',
            execute: async (_frame, context) => {
              expect(
                await context.effects.stream({ operation: 'stream', input: output }, context.call),
              ).toMatchObject({ ok: false, error: { detailCode: 'stream_requires_full_provider' } })
              pending = context.effects.invoke({ operation: 'refresh', input: output }, context.call)
              return {
                outcome,
                externalRequests: [],
                usage: [],
                references: [],
                ...(outcome === 'succeeded'
                  ? {
                      result: data(
                        'ContextRefreshResult',
                        RuntimeMethodSchemaRefs['agh.context'].refresh.output,
                        { newRevision: 2, updatedRefs: [] },
                      ),
                    }
                  : {}),
              }
            },
            reconcile: async () => {
              throw new Error('unused')
            },
          }),
        }),
      )
      const action = await adapter.methods.refresh.create({
        instanceId: 'child',
        actionId: 'action',
        runId: 'r',
        bindingId: binding.bindingId,
        scope,
        signal: call.signal,
      })
      if (action.kind !== 'leaf') throw new Error('leaf expected')
      const execution = action.execute(frame(), {
        call,
        effects: effects.ports,
        progress: async () => ({ ok: true, value: undefined }),
      })
      if (outcome === 'succeeded')
        await expect(execution).rejects.toMatchObject({ detailCode: 'unsettled_effects' })
      else expect(await execution).toMatchObject({ outcome: 'unknown_effect' })
      const nextFrame = frame()
      nextFrame.invocationId = 'next-invocation'
      nextFrame.context.invocationId = 'next-invocation'
      await expect(
        action.execute(nextFrame, {
          call: { ...call, invocationId: 'next-invocation' },
          effects: effects.ports,
          progress: async () => ({ ok: true, value: undefined }),
        }),
      ).rejects.toMatchObject({ detailCode: 'action_active' })
      await action.close('completed')
      expect(await adapter.drain('2000-01-01T00:00:00Z', call)).toMatchObject({ value: { state: 'blocked' } })
      release()
      expect(await pending).toEqual({ ok: true, value: output })
      expect(effects.calls()).toEqual([{ port: 'invoke', operation: 'refresh' }])
      expect(await adapter.drain(call.deadline, call)).toMatchObject({ value: { state: 'drained' } })
      await adapter.close('completed')
    },
  )

  it('validates configuration and rejects missing methods and undeclared continuation codecs', async () => {
    const configured: AlgorithmAdapterDefinition<'agh.context', Wire.StandardToolOutput> = {
      ...definition(),
      make: () =>
        definition().make({}, createTestServiceContainer().dependencies, {
          bindingId: binding.bindingId,
          instanceId: 'i',
          scope,
          signal: call.signal,
        }),
      config: { schema: runtimeAuthorSchemas.StandardToolOutput, defaults: { content: [] } },
    }
    const environment = {
      binding,
      context: { bindingId: binding.bindingId, instanceId: 'i', scope, signal: call.signal },
      dependencies: createTestServiceContainer().dependencies,
      config: request.input,
    }
    await expect(createContextAuthorMethods(configured, environment)).rejects.toMatchObject({
      detailCode: 'schema_mismatch',
    })
    await expect(
      create({
        ...definition(),
        make: () =>
          ({
            view: async () => ({ ok: true, value: { kind: 'value', output, snapshot: 'snapshot' } }),
          }) as never,
      }),
    ).rejects.toMatchObject({ detailCode: 'method_set_mismatch' })
    await expect(
      create(
        definition(undefined, {
          kind: 'composite',
          recovery: 'R2',
          stateCodec: {
            namespace: 'test/state',
            codecVersion: '1',
            schema: runtimeAuthorSchemas.StandardToolOutput.ref,
          },
          create: async () => {
            throw new Error('must not create')
          },
        }),
      ),
    ).rejects.toMatchObject({ detailCode: 'undeclared_state_codec' })
  })
})
