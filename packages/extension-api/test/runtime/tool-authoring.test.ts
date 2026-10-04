import type * as Wire from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  defineTool,
  type OpaqueToolDefinition,
  type PureToolDefinition,
  runtimeAuthorSchemas,
} from '../../src/runtime/authoring.js'
import { standardHookOperations } from '../../src/runtime/authoring-hook-operations.js'
import { createAuthorSchema } from '../../src/runtime/authoring-schema-core.js'
import type {
  ActionContext,
  ActionHandlerScope,
  LeafActionProvider,
  Outcome,
} from '../../src/runtime/public-api.js'
import {
  createOpaqueToolAuthorAdapter,
  createPureToolAuthorAdapter,
} from '../../src/runtime/tool-authoring.js'
import { createRestrictedEffectsFixture } from '../../testkit/runtime/effects.js'

const toolCallSchema = createAuthorSchema(RuntimeMethodSchemaRefs['agh.tools'].invoke.input, (value) =>
  validateRuntime('ToolCall', value),
)

function value<T>(result: Outcome<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
const scope: ActionHandlerScope = {
  instanceId: 'tool-instance',
  actionId: 'tool-action',
  runId: 'run',
  bindingId: 'tool-binding',
  scope: {
    kind: 'action',
    installationId: 'installation',
    runtimeId: 'runtime',
    workspaceId: 'workspace',
    sessionId: 'session',
    runId: 'run',
    actionId: 'tool-action',
  },
  signal: new AbortController().signal,
}
const payload = { content: [{ type: 'text' as const, text: 'input' }] }
const input = value(runtimeAuthorSchemas.StandardToolOutput.encode(payload))
if (input.kind !== 'inline') throw new Error('inline fixture expected')
const inputDigest = input.digest
const definition: Wire.ToolDefinition = {
  resource: { resourceId: 'tool-resource', version: '1', digest: 'a'.repeat(64) },
  executor: {
    bindingId: scope.bindingId,
    contract: 'agh.tools',
    logicalName: 'default',
    providerId: 'test-tool',
  },
  name: 'echo',
  inputSchema: runtimeAuthorSchemas.StandardToolOutput.ref,
  outputSchema: runtimeAuthorSchemas.StandardToolOutput.ref,
  requiredCapabilities: [],
  retrySafety: 'idempotent',
  publicAnnotations: input,
  policy: {
    version: '1',
    classifierRef: null,
    defaults: {
      isReadOnly: true,
      isDestructive: false,
      replay: 'idempotent',
      requiresApproval: 'never',
      approvalScopes: [],
    },
  },
  execution: {
    concurrency: 'parallel',
    isOpenWorld: false,
    costHint: null,
    deferLoading: false,
    requiredModelInput: [],
  },
}
const provenance: Wire.Provenance = {
  sourceRefs: ['verified-input-source'],
  producer: definition.executor,
  trustLabels: ['external'],
}

async function setup(execute: PureToolDefinition<Wire.StandardToolOutput>['execute'] = async (arg) => arg) {
  const author = defineTool({
    id: 'echo',
    description: 'Echo fixed input',
    execution: 'pure',
    input: runtimeAuthorSchemas.StandardToolOutput,
    execute,
  })
  const factory = createPureToolAuthorAdapter(author, { definition, inputDigest, provenance })
  const provider = (await factory.create(scope)) as LeafActionProvider
  const fixture = createRestrictedEffectsFixture()
  const abort = new AbortController()
  const call = {
    principalRef: 'principal',
    scope: scope.scope,
    bindingId: scope.bindingId,
    invocationId: 'invocation',
    deadline: new Date(Date.now() + 60_000).toISOString(),
    traceRef: 'trace',
    authorizationRef: 'authorization',
    signal: abort.signal,
  }
  const context: ActionContext = {
    call,
    effects: fixture.ports,
    progress: async () => ({ ok: true, value: undefined }),
  }
  const policy = {
    ...definition.policy.defaults,
    policyVersion: '1',
    classifierDigest: 'b'.repeat(64),
    inputDigest,
    definitionDigest: canonicalJsonDigest(definition),
  }
  const toolCall: Wire.ToolCall = {
    definition,
    input,
    expectedDefinitionDigest: policy.definitionDigest,
    policy: { ...policy, fingerprint: canonicalJsonDigest(policy) },
    batchRef: null,
    modelContextRef: null,
  }
  const encoded = value(toolCallSchema.encode(toolCall))
  if (encoded.kind !== 'inline') throw new Error('inline fixture expected')
  const { signal: _signal, ...wire } = call
  const frame: Wire.ActionFrame = {
    actionId: scope.actionId,
    parentActionId: null,
    runId: scope.runId,
    bindingId: scope.bindingId,
    method: 'invoke',
    input: encoded,
    inputDigest: encoded.digest,
    attemptId: 'attempt',
    attemptNumber: 1,
    invocationId: call.invocationId,
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], nextCursor: null, snapshot: 'snapshot', complete: true },
    receipts: { items: [], nextCursor: null, snapshot: 'snapshot', complete: true },
    signalHighWater: 0,
    snapshot: 'snapshot',
    observedAt: new Date().toISOString(),
    context: wire,
    actionTimebox: { defaultTimeoutMs: 60_000, maxDeadline: call.deadline },
  }
  return { author, factory, provider, context, frame, fixture, abort, toolCall }
}

function replaceCall(frame: Wire.ActionFrame, toolCall: Wire.ToolCall): Wire.ActionFrame {
  const encoded = value(toolCallSchema.encode(toolCall))
  if (encoded.kind !== 'inline') throw new Error('inline fixture expected')
  return { ...frame, input: encoded, inputDigest: encoded.digest }
}

function drainContext(context: ActionContext) {
  return {
    ...context.call,
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signal: new AbortController().signal,
  }
}

describe('pure tool author execution adapter', () => {
  afterEach(() => vi.useRealTimers())

  it('runs a real public leaf with standard output, existing sources and no effects', async () => {
    let authorContext: unknown
    const test = await setup(async (arg, context) => {
      authorContext = context
      return arg
    })
    expect(await test.provider.ready(test.context.call)).toEqual({ ok: true, value: undefined })
    const result = await test.provider.execute(test.frame, test.context)
    expect(result.outcome).toBe('succeeded')
    if (result.result?.kind !== 'inline') throw new Error('missing tool result')
    const toolResult = value(runtimeAuthorSchemas.ToolResult.parse(result.result.value))
    expect(toolResult.provenance).toEqual({ ...provenance, trustLabels: ['derived'] })
    expect(toolResult.output).toEqual(input)
    expect(authorContext).not.toHaveProperty('effects')
    expect(test.fixture.calls()).toEqual([])
    expect(result).toMatchObject({ externalRequests: [], usage: [], references: [] })
  })

  it('recomputes fixed pure input after a lost response without inventing durable facts', async () => {
    const first = await setup()
    const result = await first.provider.execute(first.frame, first.context)
    const rebuilt = (await first.factory.create(scope)) as LeafActionProvider
    expect(await rebuilt.execute(first.frame, first.context)).toEqual(result)
    await expect(rebuilt.reconcile(first.frame, [], first.context)).rejects.toMatchObject({
      detailCode: 'tool_reconciliation_evidence_required',
    })
    expect(await rebuilt.reconcile(first.frame, [input], first.context)).toMatchObject({
      kind: 'unknown',
      evidence: input,
    })
    expect(
      await rebuilt.reconcile(
        {
          ...first.frame,
          actionTimebox: { ...first.frame.actionTimebox, maxDeadline: '2020-01-01T00:00:00.000Z' },
        },
        [input],
        first.context,
      ),
    ).toMatchObject({ kind: 'unknown', evidence: input })
    if (input.kind !== 'inline') throw new Error('inline fixture expected')
    await expect(
      rebuilt.reconcile(first.frame, [{ ...input, digest: '0'.repeat(64) }], first.context),
    ).rejects.toMatchObject({ detailCode: 'tool_reconciliation_evidence_integrity' })
    expect(first.fixture.calls()).toEqual([])
  })

  it('rejects definition drift, changed input, corrupt bytes and invalid output', async () => {
    const test = await setup()
    const drift = replaceCall(test.frame, {
      ...test.toolCall,
      definition: { ...definition, resource: { ...definition.resource, version: '2' } },
    })
    expect(await test.provider.execute(drift, test.context)).toMatchObject({
      outcome: 'failed',
      error: { detailCode: 'tool_definition_or_input_drift' },
    })
    await expect(test.provider.reconcile(drift, [input], test.context)).rejects.toMatchObject({
      detailCode: 'tool_definition_or_input_drift',
    })
    const wrongPolicy = replaceCall(test.frame, {
      ...test.toolCall,
      policy: { ...test.toolCall.policy, fingerprint: '0'.repeat(64) },
    })
    expect(await test.provider.execute(wrongPolicy, test.context)).toMatchObject({
      error: { detailCode: 'tool_policy_digest' },
    })
    const changed = value(runtimeAuthorSchemas.StandardToolOutput.encode({ content: [] }))
    expect(
      await test.provider.execute(
        replaceCall(test.frame, { ...test.toolCall, input: changed }),
        test.context,
      ),
    ).toMatchObject({ outcome: 'failed' })
    if (test.frame.input.kind !== 'inline') throw new Error('inline expected')
    expect(
      await test.provider.execute({ ...test.frame, input: { ...test.frame.input, bytes: 0 } }, test.context),
    ).toMatchObject({ outcome: 'failed', error: { detailCode: 'tool_data_digest' } })
    const bad = await setup(async () => ({ content: [], secret: 'no output' }))
    expect(await bad.provider.execute(bad.frame, bad.context)).toMatchObject({ outcome: 'failed' })
    const throws = await setup(async () => {
      throw new Error('private author details')
    })
    const failure = await throws.provider.execute(throws.frame, throws.context)
    expect(failure).toMatchObject({ outcome: 'failed', error: { detailCode: 'tool_author_failed' } })
    expect(JSON.stringify(failure)).not.toContain('private author details')
  })

  it('validates configured values and isolates defaults from author mutation', async () => {
    const test = await setup()
    const author = defineTool({
      id: 'configured',
      description: 'Configured pure tool',
      execution: 'pure',
      input: runtimeAuthorSchemas.StandardToolOutput,
      config: { schema: runtimeAuthorSchemas.StandardToolOutput, defaults: payload },
      execute(_input, context) {
        expect(Object.isFrozen(context.config)).toBe(true)
        return context.config
      },
    })
    const configured = value(
      runtimeAuthorSchemas.StandardToolOutput.encode({ content: [{ type: 'text', text: 'configured' }] }),
    )
    const mutableConfig = structuredClone(configured)
    const factory = createPureToolAuthorAdapter(author, {
      definition,
      inputDigest,
      provenance,
      config: mutableConfig,
    })
    if (mutableConfig.kind !== 'inline') throw new Error('inline fixture expected')
    mutableConfig.value = { content: [{ type: 'text', text: 'mutated after binding' }] }
    const result = await ((await factory.create(scope)) as LeafActionProvider).execute(
      test.frame,
      test.context,
    )
    if (result.result?.kind !== 'inline') throw new Error('missing configured result')
    expect(value(runtimeAuthorSchemas.ToolResult.parse(result.result.value)).output).toEqual(configured)
    if (configured.kind !== 'inline') throw new Error('inline expected')
    expect(() =>
      createPureToolAuthorAdapter(author, {
        definition,
        inputDigest,
        provenance,
        config: { ...configured, schema: { ...configured.schema, revision: 99 } },
      }),
    ).toThrow(/configuration/)
  })

  it('rejects wrong binding, scope, missing sources and mutable definition drift', async () => {
    const test = await setup()
    expect(await test.provider.drain('invalid timestamp', test.context.call)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
    expect(await test.provider.ready(test.context.call)).toEqual({ ok: true, value: undefined })
    expect(
      await test.provider.execute(test.frame, {
        ...test.context,
        call: { ...test.context.call, bindingId: 'other' },
      }),
    ).toMatchObject({ outcome: 'failed', error: { code: 'denied' } })
    expect(
      await test.provider.execute(test.frame, {
        ...test.context,
        call: { ...test.context.call, scope: { kind: 'installation', installationId: 'other' } },
      }),
    ).toMatchObject({ outcome: 'failed' })
    expect(() =>
      createPureToolAuthorAdapter(test.author, {
        definition,
        inputDigest,
        provenance: { ...provenance, sourceRefs: [] },
      }),
    ).toThrow(/sources/)
    const mutable = structuredClone(definition)
    const factory = createPureToolAuthorAdapter(test.author, { definition: mutable, inputDigest, provenance })
    mutable.execution.isOpenWorld = true
    expect(
      await ((await factory.create(scope)) as LeafActionProvider).execute(test.frame, test.context),
    ).toMatchObject({ outcome: 'succeeded' })
  })

  it('cancels immediately, keeps uncooperative work in drain and discards late output', async () => {
    let finish: (value: Wire.StandardToolOutput) => void = () => {}
    let executions = 0
    const test = await setup(() => {
      executions++
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const pending = test.provider.execute(test.frame, test.context)
    const concurrentContext = { ...test.context, call: { ...test.context.call, invocationId: 'concurrent' } }
    const { signal: _signal, ...wire } = concurrentContext.call
    expect(
      await test.provider.execute(
        { ...test.frame, invocationId: 'concurrent', context: wire },
        concurrentContext,
      ),
    ).toMatchObject({ outcome: 'failed', error: { code: 'conflict' } })
    expect(executions).toBe(1)
    test.abort.abort()
    expect(await pending).toMatchObject({ outcome: 'cancelled' })
    expect(await test.provider.drain(new Date().toISOString(), drainContext(test.context))).toMatchObject({
      ok: true,
      value: { state: 'blocked', activeInvocationIds: ['invocation'] },
    })
    finish(payload)
    await Promise.resolve()
    expect(await test.provider.drain(test.context.call.deadline, drainContext(test.context))).toMatchObject({
      ok: true,
      value: { state: 'drained' },
    })
    expect(test.fixture.calls()).toEqual([])
    const cooperative = await setup(
      (_input, context) =>
        new Promise((resolve) => {
          context.signal.addEventListener('abort', () => resolve(payload), { once: true })
        }),
    )
    const cooperativeCall = cooperative.provider.execute(cooperative.frame, cooperative.context)
    expect(
      await cooperative.provider.drain(cooperative.context.call.deadline, cooperative.context.call),
    ).toMatchObject({ ok: true, value: { state: 'drained', activeInvocationIds: [] } })
    expect(await cooperativeCall).toMatchObject({ outcome: 'cancelled' })
  })

  it('rejects cancelled and expired calls before invoking author code and releases on close', async () => {
    const execute = vi.fn(async (arg: Wire.StandardToolOutput) => arg)
    const control = await setup(execute)
    expect(
      await control.provider.execute({ ...control.frame, attemptNumber: 0 }, control.context),
    ).toMatchObject({ outcome: 'failed', error: { code: 'invalid_input' } })
    expect(execute).not.toHaveBeenCalled()
    const test = await setup(execute)
    test.abort.abort()
    expect(await test.provider.execute(test.frame, test.context)).toMatchObject({ outcome: 'cancelled' })
    expect(execute).not.toHaveBeenCalled()
    const expired = await setup(execute)
    expired.context.call = { ...expired.context.call, deadline: '2020-01-01T00:00:00.000Z' }
    expect(await expired.provider.execute(expired.frame, expired.context)).toMatchObject({
      outcome: 'failed',
      error: { code: 'timeout' },
    })
    await expired.provider.close('shutdown')
    expect((await expired.provider.ready(expired.context.call)).ok).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    const expiredAction = await setup(execute)
    expect(
      await expiredAction.provider.execute(
        {
          ...expiredAction.frame,
          actionTimebox: { ...expiredAction.frame.actionTimebox, maxDeadline: '2020-01-01T00:00:00.000Z' },
        },
        expiredAction.context,
      ),
    ).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
    expect(execute).not.toHaveBeenCalled()
    const selfCancelled = await setup(() => {
      selfCancelled.abort.abort()
      throw new Error('interrupted author')
    })
    expect(await selfCancelled.provider.execute(selfCancelled.frame, selfCancelled.context)).toMatchObject({
      outcome: 'cancelled',
      error: { code: 'cancelled' },
    })
  })

  it('enforces an in-flight deadline without publishing late successful output', async () => {
    vi.useFakeTimers()
    let finish: (value: Wire.StandardToolOutput) => void = () => {}
    const test = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const pending = test.provider.execute(test.frame, test.context)
    const drainPending = test.provider.drain(new Date(Date.now() + 100).toISOString(), test.context.call)
    await vi.advanceTimersByTimeAsync(100)
    expect(await drainPending).toMatchObject({
      ok: true,
      value: { state: 'blocked', activeInvocationIds: ['invocation'] },
    })
    expect(await pending).toMatchObject({ outcome: 'cancelled' })
    finish(payload)
    await Promise.resolve()
    const deadlineTest = await setup(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const timed = deadlineTest.provider.execute(deadlineTest.frame, deadlineTest.context)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await timed).toMatchObject({ outcome: 'failed', error: { code: 'timeout' } })
    finish(payload)
    await Promise.resolve()
    expect(
      await deadlineTest.provider.drain(
        deadlineTest.context.call.deadline,
        drainContext(deadlineTest.context),
      ),
    ).toMatchObject({
      value: { state: 'drained' },
    })
    const synchronous = await setup((arg) => {
      vi.setSystemTime(Date.now() + 60_001)
      return arg
    })
    expect(await synchronous.provider.execute(synchronous.frame, synchronous.context)).toMatchObject({
      outcome: 'failed',
      error: { code: 'timeout' },
    })
    const reports: unknown[] = []
    for (const mode of ['cancel', 'deadline'] as const) {
      const draining = await setup(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      const running = draining.provider.execute(draining.frame, draining.context)
      const controller = new AbortController()
      let observed: unknown
      const control = {
        ...drainContext(draining.context),
        signal: controller.signal,
        deadline: new Date(Date.now() + 50).toISOString(),
      }
      const waiting = draining.provider.drain(draining.context.call.deadline, control).then((result) => {
        observed = result
      })
      if (mode === 'cancel') controller.abort()
      await vi.advanceTimersByTimeAsync(mode === 'cancel' ? 0 : 50)
      reports.push(observed)
      finish(payload)
      await waiting
      expect(await running).toMatchObject({ outcome: 'cancelled' })
    }
    expect(reports).toMatchObject([
      { ok: false, error: { code: 'cancelled' } },
      { ok: false, error: { code: 'timeout' } },
    ])
  })
})

const network = standardHookOperations.networkRequest
const effectDeclaration = {
  contract: network.contract,
  logicalName: network.logicalName,
  method: network.method,
}
const networkInput: Wire.NetworkRequest = {
  target: { targetId: 'target', scheme: 'https', host: 'example.invalid', port: 443, path: '/' },
  method: 'GET',
  headers: value(standardHookOperations.httpHeaders.encode({})),
  bodyRef: null,
  redirect: { mode: 'deny', maxHops: 0 },
  maxBytes: 1024,
}
const brokerError: Wire.RuntimeError = {
  code: 'unknown_effect',
  detailCode: 'host_confirmation_lost',
  message: 'Host owns reconciliation',
  retryAdvice: { kind: 'never' },
  diagnosticId: 'host-owner',
}
const deniedError: Wire.RuntimeError = { ...brokerError, code: 'denied', detailCode: 'permission_revoked' }
const networkReply = value(
  network.output.encode({
    status: 200,
    headersRef: networkInput.headers,
    bodyRef: {
      authorityId: 'blobs',
      blobId: 'body',
      digest: canonicalJsonDigest(null),
      bytes: 0,
      mediaType: 'application/json',
      pinId: 'pin',
    },
    finalTarget: networkInput.target,
    receipt: null,
  }),
)
async function opaqueSetup(execute: OpaqueToolDefinition<Wire.StandardToolOutput>['execute']) {
  const base = await setup()
  const opaqueDefinition: Wire.ToolDefinition = {
    ...definition,
    retrySafety: 'never',
    policy: {
      ...definition.policy,
      defaults: { ...definition.policy.defaults, isReadOnly: false, replay: 'never' },
    },
    execution: { ...definition.execution, isOpenWorld: true },
  }
  const author = defineTool({
    id: 'opaque',
    description: 'Opaque fixture',
    execution: 'opaque',
    input: runtimeAuthorSchemas.StandardToolOutput,
    effects: [effectDeclaration],
    permissions: [],
    execute,
  })
  const binding = {
    definition: opaqueDefinition,
    inputDigest,
    provenance,
    effectRoutes: [{ ...effectDeclaration, brokerOperation: 'bound-network-request' }],
  }
  const factory = createOpaqueToolAuthorAdapter(author, binding)
  const provider = (await factory.create(scope)) as LeafActionProvider
  const policy = {
    ...opaqueDefinition.policy.defaults,
    policyVersion: '1',
    classifierDigest: 'b'.repeat(64),
    inputDigest,
    definitionDigest: canonicalJsonDigest(opaqueDefinition),
  }
  const call: Wire.ToolCall = {
    ...base.toolCall,
    definition: opaqueDefinition,
    expectedDefinitionDigest: policy.definitionDigest,
    policy: { ...policy, fingerprint: canonicalJsonDigest(policy) },
  }
  const frame = replaceCall(base.frame, call)
  return { ...base, author, binding, factory, provider, frame }
}

describe('opaque tool author execution adapter', () => {
  it('uses a non-idempotent window, external trust and refuses a second execution', async () => {
    let executed = 0
    const t = await opaqueSetup((arg) => {
      executed++
      return arg
    })
    expect(t.factory.recovery).toBe('R0')
    expect(t.provider.effectSemantics).toBe('non-idempotent')
    expect(t.provider.executionUnit).toBe('opaque-call')
    const result = await t.provider.execute(t.frame, t.context)
    expect(result.outcome).toBe('succeeded')
    if (result.result?.kind !== 'inline') throw new Error('missing result')
    const output = value(runtimeAuthorSchemas.ToolResult.parse(result.result.value))
    expect(output.provenance).toEqual({ ...provenance, trustLabels: ['external'] })
    expect(await t.provider.execute(t.frame, t.context)).toMatchObject({
      outcome: 'failed',
      error: { code: 'conflict' },
    })
    expect(executed).toBe(1)
  })

  it('rejects retryable metadata and missing routes before author execution', async () => {
    const t = await opaqueSetup((arg) => arg)
    expect(() =>
      createOpaqueToolAuthorAdapter(t.author, {
        ...t.binding,
        definition: { ...t.binding.definition, retrySafety: 'idempotent' },
      }),
    ).toThrow()
    expect(() => createOpaqueToolAuthorAdapter(t.author, { ...t.binding, effectRoutes: [] })).toThrow()
    expect(await t.provider.execute({ ...t.frame, attemptNumber: 2 }, t.context)).toMatchObject({
      outcome: 'failed',
    })
    if (t.frame.input.kind !== 'inline') throw new Error('inline fixture expected')
    const call = value(toolCallSchema.parse(t.frame.input.value))
    const { fingerprint: _fingerprint, ...policy } = call.policy
    const retryable = { ...policy, replay: 'idempotent' as const }
    expect(
      await t.provider.execute(
        replaceCall(t.frame, {
          ...call,
          policy: { ...retryable, fingerprint: canonicalJsonDigest(retryable) },
        }),
        t.context,
      ),
    ).toMatchObject({ outcome: 'failed', error: { detailCode: 'opaque_tool_replay_forbidden' } })
  })

  it.each(['result-encoding', 'expired-response'] as const)(
    'keeps %s unknown after successful typed effects',
    async (mode) => {
      const large: Wire.StandardToolOutput = {
        content: [{ type: 'text', text: 'x'.repeat(MAX_AUTHOR_INLINE_BYTES - 100) }],
      }
      const encoded = value(runtimeAuthorSchemas.StandardToolOutput.encode(large))
      expect(runtimeAuthorSchemas.ToolResult.encode({ output: encoded, artifacts: [], provenance }).ok).toBe(
        false,
      )
      const t = await opaqueSetup(async (_arg, ctx) => {
        expect(await ctx.effects.invoke(network, networkInput)).toMatchObject({
          ok: mode === 'result-encoding',
        })
        if (mode === 'result-encoding')
          expect(await ctx.effects.invoke(network, networkInput)).toMatchObject({ ok: true })
        return large
      })
      const clock = vi.spyOn(Date, 'now')
      t.fixture.allow({
        port: 'invoke',
        operation: 'bound-network-request',
        handle: async () => {
          if (mode === 'expired-response') clock.mockReturnValue(Date.parse(t.context.call.deadline) + 1)
          return { ok: true, value: networkReply }
        },
      })
      try {
        expect(await t.provider.execute(t.frame, t.context)).toMatchObject({
          outcome: 'unknown_effect',
          error: {
            code: 'unknown_effect',
            detailCode:
              mode === 'result-encoding'
                ? 'opaque_tool_output_invalid_after_dispatch'
                : 'tool_effect_deadline',
          },
        })
        expect(t.fixture.calls()).toHaveLength(mode === 'result-encoding' ? 2 : 1)
      } finally {
        clock.mockRestore()
      }
    },
  )

  it.each([
    'unknown',
    'first-denied',
    'partial-denied',
    'partial-denied-throw',
    'concurrent-denied-success',
  ] as const)('preserves the %s broker outcome and never reruns on reconciliation', async (mode) => {
    let effects:
      | Parameters<OpaqueToolDefinition<Wire.StandardToolOutput>['execute']>[1]['effects']
      | undefined
    let executed = 0
    const t = await opaqueSetup(async (arg, ctx) => {
      executed++
      effects = ctx.effects
      if (mode === 'concurrent-denied-success') {
        await Promise.all([
          ctx.effects.invoke(network, networkInput),
          ctx.effects.invoke(network, networkInput),
        ])
      } else {
        if (mode.startsWith('partial'))
          expect(await ctx.effects.invoke(network, networkInput)).toMatchObject({ ok: true })
        await ctx.effects.invoke(network, networkInput)
      }
      if (mode === 'partial-denied-throw') throw new Error('author stopped after a refused request')
      return arg
    })
    let calls = 0
    const actualError = mode === 'unknown' ? brokerError : deniedError
    t.fixture.allow({
      port: 'invoke',
      operation: 'bound-network-request',
      handle: async () => {
        if (mode === 'concurrent-denied-success')
          return calls++ === 0 ? { ok: false, error: actualError } : { ok: true, value: networkReply }
        if (mode.startsWith('partial') && calls++ === 0) return { ok: true, value: networkReply }
        return { ok: false, error: actualError }
      },
    })
    const total = mode.startsWith('partial') || mode === 'concurrent-denied-success' ? 2 : 1
    expect(await t.provider.execute(t.frame, t.context)).toMatchObject({
      outcome: mode === 'first-denied' ? 'failed' : 'unknown_effect',
      error: { ...actualError, code: mode === 'first-denied' ? 'denied' : 'unknown_effect' },
    })
    expect(t.fixture.calls()).toHaveLength(total)
    expect(await t.provider.reconcile(t.frame, [input], t.context)).toMatchObject({
      kind: 'unknown',
      evidence: input,
    })
    expect(executed).toBe(1)
    expect(await effects?.invoke(network, networkInput)).toMatchObject({ ok: false })
    expect(t.fixture.calls()).toHaveLength(total)
  })

  it.each(['returned', 'threw-after-denial'] as const)(
    'keeps unfinished effects visible to drain when the author %s',
    async (mode) => {
      let release: () => void = () => {}
      const t = await opaqueSetup(async (arg, ctx) => {
        void ctx.effects.invoke(network, networkInput)
        if (mode === 'threw-after-denial') {
          await ctx.effects.invoke(network, networkInput)
          throw new Error('author stopped while another request remained pending')
        }
        return arg
      })
      let calls = 0
      t.fixture.allow({
        port: 'invoke',
        operation: 'bound-network-request',
        handle: async () => {
          if (mode === 'threw-after-denial' && calls++ > 0) return { ok: false, error: deniedError }
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { ok: false, error: brokerError }
        },
      })
      try {
        expect(await t.provider.execute(t.frame, t.context)).toMatchObject({ outcome: 'unknown_effect' })
        const drain = drainContext(t.context)
        expect(await t.provider.drain(new Date().toISOString(), drain)).toMatchObject({
          ok: true,
          value: { state: 'blocked', activeInvocationIds: ['invocation'] },
        })
        release()
        expect(await t.provider.drain(new Date(Date.now() + 1000).toISOString(), drain)).toMatchObject({
          ok: true,
          value: { state: 'drained' },
        })
      } finally {
        release()
      }
    },
  )

  it('reports unknown after cancellation during a dispatched effect and does not release pending work early', async () => {
    let release: () => void = () => {}
    const t = await opaqueSetup(async (arg, ctx) => {
      await ctx.effects.invoke(network, networkInput)
      return arg
    })
    t.fixture.allow({
      port: 'invoke',
      operation: 'bound-network-request',
      handle: async (_request, context) => {
        await new Promise<void>((resolve) => {
          release = resolve
          context.signal.addEventListener('abort', () => {}, { once: true })
        })
        return { ok: false, error: brokerError }
      },
    })
    const executing = t.provider.execute(t.frame, t.context)
    t.abort.abort()
    expect(await executing).toMatchObject({ outcome: 'unknown_effect', error: { code: 'unknown_effect' } })
    expect(await t.provider.drain(new Date().toISOString(), drainContext(t.context))).toMatchObject({
      ok: true,
      value: { state: 'blocked' },
    })
    release()
    expect(
      await t.provider.drain(new Date(Date.now() + 1000).toISOString(), drainContext(t.context)),
    ).toMatchObject({ ok: true, value: { state: 'drained' } })
  })
})
