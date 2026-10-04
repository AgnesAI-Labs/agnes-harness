import { validateRuntime } from '@agnes/protocol/runtime'
import { describe, expect, it, vi } from 'vitest'
import {
  canonicalJsonDigest,
  defineDurableWorkflow,
  runtimeAuthorSchemas,
  type WorkflowPorts,
} from '../../src/runtime/authoring.js'
import { standardHookOperations } from '../../src/runtime/authoring-hook-operations.js'
import type {
  ActionFrame,
  ActionHandlerScope,
  CallContext,
  DrainResult,
  LoopReadPorts,
  NextStep,
  Outcome,
  Provenance,
} from '../../src/runtime/public-api.js'
import { createWorkflowAuthorAdapter } from '../../src/runtime/workflow-authoring.js'
import { createTestServiceContainer } from '../../testkit/runtime/harness.js'
import { MessageSchema } from './generated/owned-schema/Message.js'

const binding = {
  bindingId: 'binding',
  contract: '@example/typed-plugin/work',
  logicalName: 'default',
  providerId: '@example/typed-plugin/contribution/work',
}
const provenance: Provenance = {
  producer: binding,
  sourceRefs: ['original-input'],
  trustLabels: ['external'],
}
const encoded = MessageSchema.encode({ message: 'input' })
if (!encoded.ok || encoded.value.kind !== 'inline') throw new Error('fixture')
const input = encoded.value
const deadline = '2099-01-01T00:00:00.000Z'
const scope = {
  kind: 'action' as const,
  installationId: 'installation',
  runtimeId: 'runtime',
  workspaceId: 'workspace',
  sessionId: 'session',
  runId: 'run',
  actionId: 'action',
}
const context: CallContext = {
  principalRef: 'principal',
  scope,
  bindingId: 'binding',
  invocationId: 'invoke',
  deadline,
  traceRef: 'trace',
  authorizationRef: 'grant',
  signal: new AbortController().signal,
}
const handlerScope: ActionHandlerScope = {
  instanceId: 'instance',
  actionId: 'action',
  runId: 'run',
  bindingId: 'binding',
  scope,
  signal: new AbortController().signal,
}
function frame(overrides: Partial<ActionFrame> = {}): ActionFrame {
  const { signal: _signal, ...wireContext } = context
  return {
    actionId: 'action',
    parentActionId: null,
    runId: 'run',
    bindingId: 'binding',
    method: 'run',
    input,
    inputDigest: input.digest,
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: 'invoke',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'snapshot', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: new Date().toISOString(),
    context: wireContext,
    actionTimebox: { defaultTimeoutMs: 10000, maxDeadline: deadline },
    ...overrides,
  }
}
const ports: LoopReadPorts = {
  async resolveData(ref) {
    return ref.kind === 'inline'
      ? { ok: true, value: ref.value }
      : {
          ok: false,
          error: {
            code: 'denied',
            detailCode: 'not_authorized',
            message: 'refused',
            retryAdvice: { kind: 'never' },
            diagnosticId: 'test',
          },
        }
  },
  async query() {
    throw new Error('not requested')
  },
  async compute() {
    throw new Error('not requested')
  },
  prepare(spec) {
    const parsed = validateRuntime('PreparedAction', {
      ...spec,
      intentFingerprint: canonicalJsonDigest(spec),
    })
    if (!parsed.ok) throw new Error('invalid test prepared action')
    return { ok: true, value: parsed.value }
  },
}
function setup(
  start = async () => ({ state: { message: 'saved' }, references: [], next: { kind: 'continue' as const } }),
) {
  const definition = defineDurableWorkflow({
    id: 'work',
    input: MessageSchema,
    output: MessageSchema,
    state: { schema: MessageSchema, codecVersion: '1' },
    requires: [],
    permissions: [],
    start,
    async resume(value) {
      return {
        state: { message: `${value.state?.message}:resumed` },
        references: [],
        next: { kind: 'continue' as const },
      }
    },
  })
  const factory = createWorkflowAuthorAdapter(definition, {
    packageId: '@example/typed-plugin',
    binding,
    inputDigest: input.digest,
    provenance,
    dependencies: createTestServiceContainer().dependencies,
  })
  return { factory, definition }
}
describe('workflow author execution', () => {
  it('revokes captured ports after a decision and refuses a transition with pending reads', async () => {
    let captured: WorkflowPorts | undefined
    const { definition } = setup()
    const assembled = (start: typeof definition.start) =>
      createWorkflowAuthorAdapter(
        { ...definition, start },
        {
          packageId: '@example/typed-plugin',
          binding,
          inputDigest: input.digest,
          provenance,
          dependencies: createTestServiceContainer().dependencies,
        },
      )
    const completed = await assembled(async (_frame, authorPorts) => {
      captured = authorPorts
      return { state: { message: 'done' }, references: [], next: { kind: 'continue' } }
    }).create(handlerScope)
    await completed.ready(context)
    await completed.start(frame(), ports)
    if (!captured) throw new Error('fixture')
    await expect(captured.resolveData(input)).rejects.toThrow('invocation_closed')
    await completed.close('shutdown')
    let settle!: () => void
    const pendingRead = new Promise<void>((resolve) => {
      settle = resolve
    })
    const running = await assembled(async (_frame, authorPorts) => {
      void authorPorts.resolveData(input)
      return { state: { message: 'too early' }, references: [], next: { kind: 'continue' } }
    }).create(handlerScope)
    await running.ready(context)
    await expect(
      running.start(frame(), {
        ...ports,
        async resolveData() {
          await pendingRead
          return { ok: true, value: input.value }
        },
      }),
    ).rejects.toThrow('unsettled_reads')
    expect(await running.drain(new Date().toISOString(), context)).toMatchObject({
      ok: true,
      value: { state: 'blocked', activeInvocationIds: ['invoke'] },
    })
    settle()
    expect(await running.drain(deadline, context)).toMatchObject({ ok: true, value: { state: 'drained' } })
  })

  it('returns on deadline while an uncooperative author remains tracked until it settles', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const instance = await setup(async () => {
        enter()
        await waiting
        return { state: { message: 'late' }, references: [], next: { kind: 'continue' } }
      }).factory.create(handlerScope)
      await instance.ready(context)
      const call = instance.start(
        frame({ context: { ...frame().context, deadline: new Date(Date.now() + 20).toISOString() } }),
        ports,
      )
      const refused = expect(call).rejects.toMatchObject({ runtimeError: { code: 'cancelled' } })
      await entered
      await vi.advanceTimersByTimeAsync(20)
      await refused
      expect(await instance.drain(new Date().toISOString(), context)).toMatchObject({
        ok: true,
        value: { state: 'blocked' },
      })
      const revokeDrain = new AbortController()
      let cancelledDrain: Outcome<DrainResult> | undefined
      void instance.drain(deadline, { ...context, signal: revokeDrain.signal }).then((value) => {
        cancelledDrain = value
      })
      revokeDrain.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(cancelledDrain).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      let expiredDrain: Outcome<DrainResult> | undefined
      void instance
        .drain(deadline, { ...context, deadline: new Date(Date.now() + 10).toISOString() })
        .then((value) => {
          expiredDrain = value
        })
      await vi.advanceTimersByTimeAsync(10)
      expect(expiredDrain).toMatchObject({ ok: false, error: { code: 'cancelled' } })
      release()
      expect(await instance.drain(deadline, context)).toMatchObject({ ok: true, value: { state: 'drained' } })
      const expires = Date.now() + 20
      const synchronous = await setup(async () => {
        // Advancing wall time without firing timers models CPU work starving the timer queue.
        vi.setSystemTime(expires + 1)
        return { state: { message: 'late' }, references: [], next: { kind: 'continue' } }
      }).factory.create(handlerScope)
      await synchronous.ready(context)
      await expect(
        synchronous.start(
          frame({ actionTimebox: { defaultTimeoutMs: 20, maxDeadline: new Date(expires).toISOString() } }),
          ports,
        ),
      ).rejects.toMatchObject({ runtimeError: { code: 'cancelled' } })
      await synchronous.close('shutdown')
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves cancellation when the author aborts and throws synchronously', async () => {
    const revoke = new AbortController()
    const { definition } = setup()
    const factory = createWorkflowAuthorAdapter(
      {
        ...definition,
        start() {
          revoke.abort()
          throw new Error('private details')
        },
      },
      {
        packageId: '@example/typed-plugin',
        binding,
        inputDigest: input.digest,
        provenance,
        dependencies: createTestServiceContainer().dependencies,
      },
    )
    const instance = await factory.create({ ...handlerScope, signal: revoke.signal })
    await instance.ready(context)
    expect(await instance.drain('invalid', context)).toMatchObject({
      ok: false,
      error: { detailCode: 'invalid_deadline' },
    })
    expect(await instance.health(context)).toMatchObject({ ok: true, value: { status: 'ready' } })
    await expect(instance.start(frame(), ports)).rejects.toMatchObject({
      runtimeError: { code: 'cancelled' },
    })
    await instance.close('shutdown')
  })
  it('prepares a declared typed operation through the same public prepare port without executing it', async () => {
    const container = createTestServiceContainer()
    const requirement = {
      contract: 'agh.network',
      major: 1,
      logicalName: 'default',
      scope: 'workspace' as const,
      features: [],
      optional: false,
    }
    const target = {
      bindingId: 'network-binding',
      contract: 'agh.network',
      logicalName: 'default',
      providerId: 'network',
    }
    container.register({ requirement, binding: target })
    const headers = standardHookOperations.httpHeaders.encode({ accept: 'application/json' })
    if (!headers.ok) throw new Error('fixture')
    const request = {
      target: {
        targetId: 'service',
        scheme: 'https' as const,
        host: 'example.invalid',
        port: 443,
        path: '/',
      },
      method: 'GET' as const,
      headers: headers.value,
      bodyRef: null,
      redirect: { mode: 'deny' as const, maxHops: 0 },
      maxBytes: 1024,
    }
    const typed = {
      key: 'fetch',
      operation: standardHookOperations.networkRequest,
      input: request,
      dependencies: [],
      retry: { mode: 'never' as const, maxAttempts: 1, backoffMs: [] },
      obligation: 'mandatory' as const,
      deadline,
      references: [],
    }
    const definition = defineDurableWorkflow({
      ...setup().definition,
      requires: [requirement],
      async start(_frame, authorPorts) {
        const prepared = authorPorts.prepareTyped(typed)
        if (!prepared.ok) throw new Error(prepared.error.detailCode)
        const denied = authorPorts.prepareTyped({
          ...typed,
          operation: { ...typed.operation, logicalName: 'undeclared' },
        })
        expect(denied).toMatchObject({ ok: false, error: { detailCode: 'undeclared_operation' } })
        return {
          state: { message: 'prepared' },
          references: [],
          children: [prepared.value],
          next: { kind: 'continue' as const },
        }
      },
    })
    const factory = createWorkflowAuthorAdapter(definition, {
      packageId: '@example/typed-plugin',
      binding,
      inputDigest: input.digest,
      provenance,
      dependencies: container.dependencies,
    })
    const instance = await factory.create(handlerScope)
    await instance.ready(context)
    const transition = await instance.start(frame(), ports)
    const encodedRequest = typed.operation.input.encode(request)
    if (!encodedRequest.ok) throw new Error('fixture')
    const expected = ports.prepare({
      key: typed.key,
      target,
      method: 'request',
      input: encodedRequest.value,
      dependencies: [],
      retry: typed.retry,
      obligation: 'mandatory',
      deadline,
      references: [],
      resultSchema: typed.operation.output.ref,
    })
    expect(expected.ok && transition.children[0]).toEqual(expected.ok && expected.value)
    await instance.close('shutdown')
    const optional = await createWorkflowAuthorAdapter(
      { ...setup().definition, requires: [{ ...requirement, optional: true }] },
      {
        packageId: '@example/typed-plugin',
        binding,
        inputDigest: input.digest,
        provenance,
        dependencies: createTestServiceContainer().dependencies,
      },
    ).create(handlerScope)
    expect(await optional.ready(context)).toEqual({ ok: true, value: undefined })
    expect((await optional.start(frame(), ports)).next.kind).toBe('continue')
    await optional.close('shutdown')
    const unavailable = await factory.create(handlerScope)
    await container.dependencies.close()
    expect(await unavailable.ready(context)).toMatchObject({ ok: false })
    await unavailable.close('shutdown')
  })

  it('isolates an author transition before asynchronously validating its output', async () => {
    const output = {
      kind: 'blob' as const,
      schema: input.schema,
      blob: {
        authorityId: 'blobs',
        blobId: 'output',
        digest: input.digest,
        bytes: input.bytes,
        mediaType: 'application/json',
        pinId: 'pin',
      },
    }
    const next: Extract<NextStep, { kind: 'complete' }> = { kind: 'complete', output, references: [] }
    const instance = await createWorkflowAuthorAdapter(
      {
        ...setup().definition,
        async start() {
          return { state: { message: 'done' }, references: [], next }
        },
      },
      {
        packageId: '@example/typed-plugin',
        binding,
        inputDigest: input.digest,
        provenance,
        dependencies: createTestServiceContainer().dependencies,
      },
    ).create(handlerScope)
    await instance.ready(context)
    const result = await instance.start(frame(), {
      ...ports,
      async resolveData() {
        next.output = { ...input, schema: runtimeAuthorSchemas.StandardToolOutput.ref }
        return { ok: true, value: input.value }
      },
    })
    expect(result.next).toEqual({ kind: 'complete', output, references: [] })
    await instance.close('shutdown')
  })

  it('refuses expired and revoked calls before entering author code', async () => {
    let entered = false
    const { factory } = setup(async () => {
      entered = true
      return { state: { message: 'bad' }, references: [], next: { kind: 'continue' } }
    })
    const revoke = new AbortController()
    const instance = await factory.create({ ...handlerScope, signal: revoke.signal })
    await instance.ready(context)
    await expect(
      instance.start(frame({ context: { ...frame().context, deadline: '2000-01-01T00:00:00.000Z' } }), ports),
    ).rejects.toThrow('call_cancelled')
    revoke.abort()
    await expect(instance.start(frame(), ports)).rejects.toThrow('call_closed')
    expect(entered).toBe(false)
    await instance.close('shutdown')
  })

  it('rejects forged state bytes and producer evidence on cold resume', async () => {
    const instance = await setup().factory.create(handlerScope)
    await instance.ready(context)
    const saved = (await instance.start(frame(), ports)).continuation
    for (const continuation of [
      { ...saved, provenance: { ...saved.provenance, producer: { ...binding, providerId: 'foreign' } } },
      { ...saved, data: { ...input, bytes: input.bytes + 1 } },
    ])
      await expect(instance.resume(frame({ providerRevision: 1, continuation }), ports)).rejects.toThrow()
    await instance.close('shutdown')
  })
  it.each(['action', 'run', 'session'] as const)(
    'encodes and resumes state with a %s scope',
    async (kind) => {
      const { actionId: _actionId, ...runScope } = scope
      const { runId: _runId, ...sessionScope } = runScope
      const callScope =
        kind === 'action' ? scope : kind === 'run' ? { ...runScope, kind } : { ...sessionScope, kind }
      const ownedScope = { ...handlerScope, scope: callScope }
      const call = { ...context, scope: callScope }
      const value = frame({ context: { ...frame().context, scope: callScope } })
      if ('runId' in callScope)
        await expect(setup().factory.create({ ...ownedScope, runId: 'other' })).rejects.toThrow(
          'scope_mismatch',
        )
      if (kind === 'action')
        await expect(setup().factory.create({ ...ownedScope, actionId: 'other' })).rejects.toThrow(
          'scope_mismatch',
        )
      const first = await setup().factory.create(ownedScope)
      expect(await first.ready(call)).toEqual({ ok: true, value: undefined })
      const transition = await first.start(value, ports)
      expect(transition.expectedProviderRevision).toBe(0)
      expect(transition.continuation.namespace).toBe('@example/typed-plugin/work')
      expect(transition.continuation.provenance).toEqual(provenance)
      expect(transition.children).toEqual([])
      await first.close('shutdown')
      const second = await setup().factory.create(ownedScope)
      await second.ready(call)
      const resumed = await second.resume(
        { ...value, providerRevision: 1, continuation: transition.continuation },
        ports,
      )
      expect(resumed.expectedProviderRevision).toBe(1)
      expect(resumed.continuation.data.kind === 'inline' && resumed.continuation.data.value).toEqual({
        message: 'saved:resumed',
      })
      expect(await second.drain(deadline, call)).toMatchObject({
        ok: true,
        value: { state: 'drained', activeInvocationIds: [] },
      })
      await expect(second.start(value, ports)).rejects.toThrow()
    },
  )

  it.each(['binding', 'input', 'digest', 'scope', 'codec', 'control-attempt', 'leaf-attempt'] as const)(
    'rejects mismatched %s before invoking the author',
    async (fault) => {
      let called = 0
      const instance = await setup(async () => {
        called++
        return { state: { message: 'saved' }, references: [], next: { kind: 'continue' } }
      }).factory.create(handlerScope)
      await instance.ready(context)
      let invalid = frame()
      if (fault === 'binding') invalid = frame({ bindingId: 'other' })
      if (fault === 'control-attempt') invalid = frame({ attemptNumber: 0 })
      if (fault === 'leaf-attempt') invalid = frame({ attemptNumber: 2 })
      if (fault === 'input')
        invalid = frame({ input: { ...input, schema: runtimeAuthorSchemas.StandardToolOutput.ref } })
      if (fault === 'digest') invalid = frame({ input: { ...input, digest: 'a'.repeat(64) } })
      if (fault === 'scope')
        invalid = frame({ context: { ...invalid.context, scope: { ...scope, sessionId: 'other' } } })
      if (fault === 'codec') {
        const good = await instance.start(frame(), ports)
        called = 0
        invalid = frame({ providerRevision: 1, continuation: { ...good.continuation, codecVersion: '2' } })
      }
      await expect(
        fault === 'codec' ? instance.resume(invalid, ports) : instance.start(invalid, ports),
      ).rejects.toThrow()
      expect(called).toBe(0)
      await instance.close('shutdown')
    },
  )

  it('does not publish a late decision after close and reports calls still draining', async () => {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const instance = await setup(async () => {
      await wait
      return { state: { message: 'late' }, references: [], next: { kind: 'continue' } }
    }).factory.create(handlerScope)
    await instance.ready(context)
    const pending = instance.start(frame(), ports)
    const rejected = expect(pending).rejects.toThrow()
    await Promise.resolve()
    await instance.close('shutdown')
    expect(await instance.drain(new Date().toISOString(), context)).toMatchObject({
      ok: true,
      value: { state: 'blocked' },
    })
    release()
    await rejected
    expect(await instance.drain(deadline, context)).toMatchObject({ ok: true, value: { state: 'drained' } })
  })
})
