import type {
  CallContext,
  DataRef,
  LoopReadPorts,
  Outcome,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { createTestServiceContainer } from '@agnes/extension-api/testkit'
import type { ActionFrame, ModelPrepareRequest, RuntimeError, SecretHandle } from '@agnes/protocol/runtime'
import {
  canonicalJsonDigest,
  MAX_AUTHOR_INLINE_BYTES,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'
import { createPreparedRegistry } from '../../../../packages/core/src/runtime/model/prepared-registry.js'
import {
  createDefaultModelFactory,
  type ModelDeployment,
} from '../../../../packages/core/src/runtime/providers/model.js'
import {
  standardTool,
  standardToolDocument,
  toolCatalogOf,
  toolRoute,
} from '../../../../packages/core/test/runtime/model-tools-fixture.js'
import {
  createModelChildPeer,
  type ModelChildPeer,
} from '../../../../packages/extension-api/testkit/runtime/contracts/model.js'
import {
  createReferenceModelFactory,
  createReferenceModelRegistry,
  type ReferenceModelDeployment,
} from './model.js'
import {
  ADAPTER,
  factoryContext,
  inlineRef,
  OWNER_ID,
  runCall as plainCall,
  prepareRequestOf,
  type ReferenceModelState,
  referenceDeployment,
  STATE,
  textItem,
} from './model-contract.js'

/*
 * One set of inputs, two implementations. Everything a caller can observe is compared: references,
 * digests, child specs, continuations (minus the codec namespace each side owns), error codes and the
 * number of times the leaf was reached or a credential was asked for.
 */
const refs = RuntimeMethodSchemaRefs['agh.model']
// One deadline for every call, so a child spec can be compared across the two runs.
const DEADLINE = new Date(Date.now() + 3_600_000).toISOString()
const runCall = (...args: Parameters<typeof plainCall>) => ({ ...plainCall(...args), deadline: DEADLINE })
const DEFAULT_ID = 'agh.default/model'
type Kind = 'default' | 'reference'
type Rig = {
  kind: Kind
  provider: ServiceProvider
  peer: ModelChildPeer
  hold(handleId: string): Record<string, unknown> | undefined
  put(handleId: string, entry: Record<string, unknown>): void
  state: ReferenceModelState
  queries: string[]
}

async function open(
  kind: Kind,
  over: Partial<ReferenceModelDeployment> = {},
  bindingId = OWNER_ID,
): Promise<Rig> {
  const state: ReferenceModelState = { current: true, adapterSelectable: true }
  const queries: string[] = []
  const peer = createModelChildPeer({ adapter: ADAPTER, state: STATE.bindingId })
  const shared = referenceDeployment(state, { providerId: DEFAULT_ID, ...over })
  const encoded = shared.config.encode({})
  if (!encoded.ok) throw new Error('config')
  const context = factoryContext(bindingId)
  if (kind === 'reference') {
    const registry = createReferenceModelRegistry()
    const provider = await createReferenceModelFactory({ ...shared, registry }).create(
      encoded.value,
      createTestServiceContainer().dependencies,
      context,
    )
    await provider.ready(runCall())
    return {
      kind,
      provider,
      peer,
      state,
      queries,
      hold: (id) => registry.get(id) as never,
      put: (id, entry) => registry.put(id, entry as never),
    }
  }
  const registry = createPreparedRegistry()
  const provider = await createDefaultModelFactory({
    ...shared,
    registry,
  } as unknown as ModelDeployment).create(encoded.value, createTestServiceContainer().dependencies, context)
  await provider.ready(runCall())
  return {
    kind,
    provider,
    peer,
    state,
    queries,
    hold: (id) => registry.get(id) as never,
    put: (id, entry) => registry.put(id, entry as never),
  }
}
const both = async <T>(
  work: (rig: Rig) => Promise<T>,
  over: Partial<ReferenceModelDeployment> = {},
): Promise<[T, T]> => [await work(await open('default', over)), await work(await open('reference', over))]
const same = async <T>(work: (rig: Rig) => Promise<T>, over: Partial<ReferenceModelDeployment> = {}) => {
  const [a, b] = await both(work, over)
  expect(b).toEqual(a)
  return a
}

const seen = (reply: Outcome<DataRef>) =>
  reply.ok
    ? { ok: true as const, value: reply.value }
    : { ok: false as const, code: reply.error.code, detail: reply.error.detailCode }
const prepareRaw = (rig: Rig, input: DataRef, call: CallContext = runCall()) => {
  const compute = rig.provider.compute
  if (!compute) throw new Error('compute missing')
  return compute(
    {
      target: { bindingId: OWNER_ID, contract: 'agh.model', logicalName: 'default', providerId: DEFAULT_ID },
      method: 'prepare',
      input,
    },
    call,
  )
}
const prepareOf = async (rig: Rig, request: ModelPrepareRequest, call?: CallContext) =>
  seen(await prepareRaw(rig, inlineRef(refs.prepare.input, request), call))
const handleOf = async (rig: Rig, request: ModelPrepareRequest = prepareRequestOf(), call?: CallContext) => {
  const reply = await prepareRaw(rig, inlineRef(refs.prepare.input, request), call)
  const parsed =
    reply.ok && reply.value.kind === 'inline'
      ? validateRuntime('ModelPrepareResult', reply.value.value)
      : null
  if (!parsed?.ok) throw new Error('prepare refused')
  return parsed.value.preparedRef
}

function frameOf(ref: DataRef, over: Partial<ActionFrame> = {}, call = runCall()): ActionFrame {
  const { signal: _signal, ...context } = call
  const input = inlineRef(refs.infer.input, { preparedRef: ref })
  return {
    actionId: 'parent-1',
    parentActionId: null,
    runId: 'run-1',
    bindingId: OWNER_ID,
    method: 'infer',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : '',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    invocationId: 'invocation-parent',
    requestIdentity: null,
    providerRevision: 0,
    continuation: null,
    signals: { items: [], snapshot: 'signals', nextCursor: null, complete: true },
    receipts: { items: [], snapshot: 'receipts', nextCursor: null, complete: true },
    signalHighWater: 0,
    snapshot: 'frame',
    observedAt: '2026-01-01T00:00:00.000Z',
    context,
    actionTimebox: { defaultTimeoutMs: 10_000, maxDeadline: context.deadline },
    ...over,
  }
}
async function inferOf(rig: Rig, actionId = 'parent-1', signal: AbortSignal = new AbortController().signal) {
  const factory = rig.provider.actions?.infer
  if (!factory) throw new Error('infer missing')
  const action = await factory.create({
    instanceId: 'i',
    actionId,
    runId: 'run-1',
    bindingId: OWNER_ID,
    scope: runCall().scope,
    signal,
  })
  if (action.kind !== 'composite') throw new Error('not composite')
  return action
}
type Transition = Awaited<ReturnType<Awaited<ReturnType<typeof inferOf>>['start']>>
/** A transition as a caller sees it, without the codec namespace the two implementations each own. */
function shape(t: Transition) {
  const { continuation, ...rest } = t
  return {
    ...rest,
    continuation: { ...continuation, namespace: 'x', data: continuation.data },
    children: t.children.map((c) => ({ ...c })),
  }
}
const startOf = async (rig: Rig, ref: DataRef, over: Partial<ActionFrame> = {}, signal?: AbortSignal) =>
  shape(
    await (await inferOf(rig, over.actionId ?? 'parent-1', signal)).start(frameOf(ref, over), rig.peer.ports),
  )

type Variant = 'succeeded' | 'failed' | 'unknown_effect'
async function lifecycle(
  rig: Rig,
  variant: Variant,
  options: {
    foreignUsage?: boolean
    deadline?: string
    tamper?: (value: Record<string, unknown>) => void
  } = {},
) {
  const ref = await handleOf(rig)
  const action = await inferOf(rig)
  const frame = frameOf(ref)
  const started = await action.start(frame, rig.peer.ports)
  const spec = started.children[0]
  if (!spec) throw new Error('no child')
  const child = rig.peer.commit(frame.actionId, spec)
  if (!child.ok) throw new Error('commit')
  await rig.peer.dispatch(child.value, variant, { foreignUsage: options.foreignUsage ?? false })
  rig.peer.publish(child.value, 'receipt-1')
  const continuation = structuredClone(started.continuation)
  if (options.tamper && continuation.data.kind === 'inline') {
    options.tamper(continuation.data.value as Record<string, unknown>)
    continuation.data = {
      ...continuation.data,
      digest: canonicalJsonDigest(continuation.data.value as never),
    }
  }
  const resumed = await action.resume(
    {
      ...frame,
      providerRevision: 1,
      continuation,
      context: { ...frame.context, ...(options.deadline ? { deadline: options.deadline } : {}) },
      receipts: {
        items: [
          {
            actionId: child.value.actionId,
            receiptId: 'receipt-1',
            outcome: variant === 'succeeded' ? 'succeeded' : variant,
          },
        ],
        snapshot: 'published',
        nextCursor: null,
        complete: true,
      },
    },
    rig.peer.ports,
  )
  return {
    started: shape(started),
    resumed: shape(resumed),
    deliveries: rig.peer.deliveries(),
    other: rig.peer.otherQueries(),
  }
}

const idOf = (ref: DataRef) => (ref.kind === 'inline' ? (ref.value as { handleId: string }).handleId : '')
/** Store, under `handleId`, what another preparation of this implementation holds. */
async function seedOther(rig: Rig, handleId: string) {
  const other = await open(rig.kind)
  const held = other.hold(
    idOf(await handleOf(other, prepareRequestOf({ generation: { maxOutputTokens: 33, thinking: null } }))),
  )
  if (!held) throw new Error('nothing held')
  rig.put(handleId, held)
}
const hookResultSet = () => ({
  stageId: 'stage',
  event: 'before_request',
  registrationDigest: 'd'.repeat(64),
  inputDigest: 'e'.repeat(64),
  entries: [],
  output: inlineRef(prepareRequestOf().view.schema, {}),
  digest: 'f'.repeat(64),
  sourceActionId: null,
})
const runtimeAuthorSchemasRef = () => prepareRequestOf().view.schema
const TOO_LARGE = 'x'.repeat(Math.floor(MAX_AUTHOR_INLINE_BYTES * 0.9))
const secretHandle = (expiresAt: string): SecretHandle => ({
  handleId: 'h',
  secretId: 's',
  version: '1',
  audience: 'fixture-endpoint',
  expiresAt,
})
const expiredHandle = () => secretHandle('2000-01-01T00:00:00.000Z')
const longLived = () => secretHandle('2999-01-01T00:00:00.000Z')
const bound = {
  consumer: 'model',
  secretId: 's',
  accountRef: null,
  serverRef: 'srv',
  audience: 'fixture-endpoint',
  purpose: 'p',
} as never
const route = (over: object) => ({ ...prepareRequestOf().route, ...over })
const withRoute = (over: object) => prepareRequestOf({ route: route(over) as never })
describe('prepare: the default and the reference answer every input alike', () => {
  const rows: Array<[string, () => ModelPrepareRequest, Partial<ReferenceModelDeployment>?]> = [
    ['plain request', () => prepareRequestOf()],
    [
      'system and user text',
      () =>
        prepareRequestOf({
          view: {
            ...prepareRequestOf().view,
            items: [textItem('system', 'be brief'), textItem('user', 'hi')],
          },
        }),
    ],
    [
      'unicode and line breaks',
      () =>
        prepareRequestOf({
          view: { ...prepareRequestOf().view, items: [textItem('user', 'héllo\n\u{1F600}\u0000')] },
        }),
    ],
    [
      'thinking and temperature',
      () =>
        prepareRequestOf({
          generation: { maxOutputTokens: 64, thinking: 'high', temperature: 0.5 } as never,
        }),
    ],
    ['hook results', () => prepareRequestOf({ hookResults: { stageId: 's' } as never })],
    ['a complete hook result set', () => prepareRequestOf({ hookResults: hookResultSet() as never })],
    [
      'a handle the issuer does not know',
      () => ({ ...withRoute({ credentialBinding: bound }), credentialRef: { ...longLived(), version: '2' } }),
    ],
    ['tools without the feature', () => prepareRequestOf({ toolCatalog: { tools: [] } as never })],
    [
      'output schema without the feature',
      () => prepareRequestOf({ outputSchema: inlineRef(prepareRequestOf().view.schema, {}) as never }),
    ],
    [
      'tools with the feature',
      () => withRoute({ features: { ...prepareRequestOf().route.features, tools: true } }),
      {},
    ],
    ['unknown adapter', () => withRoute({ adapter: { ...ADAPTER, bindingId: 'elsewhere' } })],
    ['unknown model', () => withRoute({ model: 'missing' })],
    ['price drift', () => withRoute({ priceVersion: 'other' })],
    [
      'credential binding without issuer check',
      () => ({ ...withRoute({ credentialBinding: bound }), credentialRef: longLived() }),
    ],
    ['credential binding without a handle', () => withRoute({ credentialBinding: bound })],
    [
      'credential expired',
      () => ({ ...withRoute({ credentialBinding: bound }), credentialRef: expiredHandle() }),
    ],
    [
      'credential for another audience',
      () => ({
        ...withRoute({ credentialBinding: bound }),
        credentialRef: { ...longLived(), audience: 'z' } as never,
      }),
    ],
    ['handle without a binding', () => ({ ...prepareRequestOf(), credentialRef: longLived() })],
    [
      'no user message',
      () => prepareRequestOf({ view: { ...prepareRequestOf().view, items: [textItem('system', 'only')] } }),
    ],
    [
      'assistant item',
      () =>
        prepareRequestOf({
          view: {
            ...prepareRequestOf().view,
            items: [{ ...textItem('user', 'a'), trust: 'assistant' } as never],
          },
        }),
    ],
    [
      'non message item',
      () =>
        prepareRequestOf({
          view: {
            ...prepareRequestOf().view,
            items: [{ ...textItem('user', 'a'), kind: 'tool-result' } as never],
          },
        }),
    ],
    [
      'non text body',
      () =>
        prepareRequestOf({
          view: {
            ...prepareRequestOf().view,
            items: [
              {
                ...textItem('user', 'a'),
                body: inlineRef(prepareRequestOf().view.schema, { a: 1 }),
              } as never,
            ],
          },
        }),
    ],
    [
      'seed',
      () => prepareRequestOf({ generation: { maxOutputTokens: 8, thinking: null, seed: 3 } as never }),
    ],
    [
      'near the inline limit',
      () => prepareRequestOf({ view: { ...prepareRequestOf().view, items: [textItem('user', TOO_LARGE)] } }),
    ],
  ]
  it.each(rows)('%s', async (_name, build, over = {}) => {
    const verifies: Partial<ReferenceModelDeployment> = {
      ...over,
      credentials: {
        verifyIssued: (handle) => handle.version === '1',
      },
    }
    const outcome = await same((rig) => prepareOf(rig, build()), verifies)
    expect(outcome).toBeDefined()
  })

  it('outcomes include both successes and refusals across the table', async () => {
    const results = await Promise.all(
      rows.map(([, build]) => open('default').then((rig) => prepareOf(rig, build()))),
    )
    expect(results.some((r) => r.ok)).toBe(true)
    expect(new Set(results.flatMap((r) => (r.ok ? [] : [r.detail]))).size).toBeGreaterThan(5)
  })

  it('the same request prepared twice names the same handle and the same digest', async () => {
    const [a, b] = await both(async (rig) => [await handleOf(rig), await handleOf(rig)])
    expect(a[0]).toEqual(a[1])
    expect(b).toEqual(a)
  })

  it('a different run or session names a different handle', async () => {
    const results = await same(async (rig) => [
      await handleOf(rig),
      await handleOf(rig, prepareRequestOf(), runCall(undefined, { runId: 'run-2' })),
    ])
    expect(results[0]).not.toEqual(results[1])
  })

  it.each([
    [
      'hooks claim, estimator throws',
      {
        estimate: () => {
          throw new Error('estimator')
        },
      },
    ],
    ['estimator adds units', { estimate: () => [{ unit: 'tokens', value: '5' }] as never }],
    ['price unknown', { prices: { version: () => null } }],
    [
      'catalog refused',
      {
        catalog: {
          capture: () => ({
            ok: false as const,
            error: {
              code: 'retryable' as const,
              detailCode: 'catalog_down',
              message: 'm',
              retryAdvice: { kind: 'never' as const },
              diagnosticId: 'd',
            },
          }),
        },
      },
    ],
    [
      'wire refused',
      {
        wire: {
          resolve: async () => ({
            ok: false as const,
            error: {
              code: 'denied' as const,
              detailCode: 'wire_no',
              message: 'm',
              retryAdvice: { kind: 'never' as const },
              diagnosticId: 'd',
            },
          }),
        },
      },
    ],
    [
      'wire throws',
      {
        wire: {
          resolve: async () => {
            throw new Error('boom')
          },
        },
      },
    ],
    ['grant revoked', { current: () => false }],
  ] as Array<[string, Partial<ReferenceModelDeployment>]>)('%s', async (_name, over) => {
    await same((rig) => prepareOf(rig, prepareRequestOf()), over)
  })

  it('malformed or foreign input references', async () => {
    const good = inlineRef(refs.prepare.input, prepareRequestOf())
    const goodValue = good.kind === 'inline' ? good.value : null
    const inputs: DataRef[] = [
      { ...good, digest: 'f'.repeat(64) } as never,
      { ...good, schema: { ...refs.prepare.input, digest: 'e'.repeat(64) } } as never,
      inlineRef(refs.prepare.input, { ...(goodValue as object), extra: 1 }),
      inlineRef(refs.prepare.input, 'text'),
      inlineRef(refs.prepare.input, null),
      { kind: 'blob', schema: refs.prepare.input, blob: { digest: 'a'.repeat(64) } } as never,
    ]
    const out = await same(async (rig) =>
      Promise.all(inputs.map(async (input) => seen(await prepareRaw(rig, input)))),
    )
    expect(out.every((r) => !r.ok)).toBe(true)
  })

  it('a cancelled call, a non-run scope, another target and another method', async () => {
    const out = await same(async (rig) => {
      const input = inlineRef(refs.prepare.input, prepareRequestOf())
      const compute = rig.provider.compute
      if (!compute) throw new Error('compute')
      const target = {
        bindingId: OWNER_ID,
        contract: 'agh.model',
        logicalName: 'default',
        providerId: DEFAULT_ID,
      }
      const runtimeScope = {
        ...runCall(),
        scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as never,
      }
      return [
        seen(await prepareRaw(rig, input, runCall(AbortSignal.abort()))),
        seen(await prepareRaw(rig, input, runtimeScope)),
        seen(
          await compute({ target: { ...target, bindingId: 'other' }, method: 'prepare', input }, runCall()),
        ),
        seen(await compute({ target, method: 'prepareRequest', input }, runCall())),
      ]
    })
    expect(out.map((r) => (r.ok ? 'ok' : r.code))).toEqual(['cancelled', 'denied', 'denied', 'denied'])
  })

  it('a registry that holds other content under the handle refuses the preparation alike', async () => {
    const probe = await open('default')
    const handleId = idOf(await handleOf(probe))
    const out = await same(async (rig) => {
      await seedOther(rig, handleId)
      return prepareOf(rig, prepareRequestOf())
    })
    expect(out).toMatchObject({ ok: false, code: 'retryable', detail: 'model_dependency_unavailable' })
  })
})

describe('prepareRequest: the managed preparation path', () => {
  const SECRETS = {
    bindingId: 'secrets',
    providerId: 'agh.default/secrets',
    contract: 'agh.secrets',
    logicalName: 'default',
  }
  const resolveRefs = RuntimeMethodSchemaRefs['agh.secrets'].resolve
  const asked: string[] = []
  const ports = (
    peer: ModelChildPeer,
    answer: () => Outcome<{ kind: 'value'; snapshot: string; output: DataRef }>,
  ): LoopReadPorts => ({
    ...peer.ports,
    async query(request) {
      asked.push(`${request.target.bindingId}:${request.method}`)
      return answer() as never
    },
  })
  const run = async (
    rig: Rig,
    request: object,
    answer: () => Outcome<{ kind: 'value'; snapshot: string; output: DataRef }>,
  ) => {
    const factory = rig.provider.actions?.prepareRequest
    if (!factory) throw new Error('prepareRequest missing')
    const action = await factory.create({
      instanceId: 'i',
      actionId: 'parent-1',
      runId: 'run-1',
      bindingId: OWNER_ID,
      scope: runCall().scope,
      signal: new AbortController().signal,
    })
    if (action.kind !== 'composite') throw new Error('not composite')
    const input = inlineRef(refs.prepareRequest.input, request)
    const frame = {
      ...frameOf(input),
      method: 'prepareRequest',
      input,
      inputDigest: input.kind === 'inline' ? input.digest : '',
    } as ActionFrame
    asked.length = 0
    const out = await action.start(frame, ports(rig.peer, answer))
    return {
      next: shape(out).next,
      queries: [...asked],
      continuation: { ...out.continuation, namespace: 'x' },
    }
  }
  const handleAnswer = (handle: SecretHandle) => () => ({
    ok: true as const,
    value: { kind: 'value' as const, snapshot: 's', output: inlineRef(resolveRefs.output, handle) },
  })
  const refused = () => ({
    ok: false as const,
    error: {
      code: 'denied' as const,
      detailCode: 'secrets_no',
      message: 'm',
      retryAdvice: { kind: 'never' as const },
      diagnosticId: 'd',
    },
  })
  const request = (over: object = {}) => ({
    ...prepareRequestOf({ credentialRef: null }),
    credentialRefresh: null,
    ...over,
  })
  const rows: Array<
    [
      string,
      object,
      () => Outcome<never> | Outcome<{ kind: 'value'; snapshot: string; output: DataRef }>,
      Partial<ReferenceModelDeployment>,
    ]
  > = [
    [
      'a route without a credential binding',
      request({ route: route({ credentialBinding: null }) }),
      refused as never,
      { secrets: SECRETS },
    ],
    [
      'a resolved handle',
      request({ route: route({ credentialBinding: bound }) }),
      handleAnswer(longLived()),
      { secrets: SECRETS },
    ],
    [
      'a resolved handle the caller also names',
      request({ route: route({ credentialBinding: bound }), credentialRef: longLived() }),
      handleAnswer(longLived()),
      { secrets: SECRETS },
    ],
    [
      'a caller handle that differs from the resolved one',
      request({
        route: route({ credentialBinding: bound }),
        credentialRef: { ...longLived(), version: '2' },
      }),
      handleAnswer(longLived()),
      { secrets: SECRETS },
    ],
    [
      'an expired resolved handle',
      request({ route: route({ credentialBinding: bound }) }),
      handleAnswer(expiredHandle()),
      { secrets: SECRETS },
    ],
    [
      'a refused resolve',
      request({ route: route({ credentialBinding: bound }) }),
      refused as never,
      { secrets: SECRETS },
    ],
    [
      'no secrets service',
      request({ route: route({ credentialBinding: bound }) }),
      handleAnswer(longLived()),
      { secrets: null },
    ],
    [
      'a refresh request',
      request({
        credentialRefresh: {
          requestId: 'r',
          secretId: 's',
          expectedVersion: '1',
          audience: 'a',
          accountRef: 'x',
          serverRef: 'y',
          purpose: 'model-subscription',
        },
      }),
      refused as never,
      { secrets: SECRETS },
    ],
    [
      'hook results claimed',
      request({ hookResults: { stageId: 's' } }),
      refused as never,
      { secrets: SECRETS },
    ],
    ['a malformed request', { nonsense: true }, refused as never, { secrets: SECRETS }],
    ['a revoked grant', request(), refused as never, { secrets: SECRETS, current: () => false }],
    [
      'an unknown adapter',
      request({ route: route({ adapter: { ...ADAPTER, bindingId: 'elsewhere' } }) }),
      refused as never,
      { secrets: SECRETS },
    ],
  ]
  it.each(rows)('%s', async (_name, input, answer, over) => {
    const out = await same((rig) => run(rig, input, answer as never), over)
    expect(out.next.kind === 'complete' || out.next.kind === 'fail').toBe(true)
  })
  it('the rows reach completion and several distinct refusals', async () => {
    const seen = new Set<string>()
    for (const [, input, answer, over] of rows) {
      const rig = await open('reference', over)
      const out = await run(rig, input, answer as never)
      seen.add(out.next.kind === 'fail' ? out.next.error.detailCode : out.next.kind)
    }
    expect(seen.has('complete')).toBe(true)
    expect(seen.size).toBeGreaterThan(7)
  })
})

describe('infer start: the default and the reference answer every handle alike', () => {
  const tamper =
    (change: (v: Record<string, unknown>) => void, keepDigest = false) =>
    async (rig: Rig): Promise<DataRef> => {
      const ref = await handleOf(rig)
      if (ref.kind !== 'inline') throw new Error('inline')
      const value = structuredClone(ref.value) as Record<string, unknown>
      change(value)
      return keepDigest ? { ...ref, value: value as never } : inlineRef(ref.schema, value)
    }
  const rows: Array<[string, (rig: Rig) => Promise<DataRef>]> = [
    ['the handle as prepared', (rig) => handleOf(rig)],
    [
      'a value changed, digest kept',
      tamper((v) => {
        v.inputDigest = 'a'.repeat(64)
      }, true),
    ],
    [
      'an input digest changed',
      tamper((v) => {
        v.inputDigest = 'a'.repeat(64)
      }),
    ],
    [
      'another handle id',
      tamper((v) => {
        v.handleId = 'hdl-x'
      }),
    ],
    [
      'another kind',
      tamper((v) => {
        v.kind = 'agh.model/prepared-handle@2'
      }),
    ],
    [
      'an extra member',
      tamper((v) => {
        v.extra = 1
      }),
    ],
    [
      'another owner',
      tamper((v) => {
        ;(v.ownerBinding as Record<string, string>).bindingId = 'other-owner'
      }),
    ],
    [
      'another adapter',
      tamper((v) => {
        ;(v.header as { route: { adapter: Record<string, string> } }).route.adapter.bindingId = 'elsewhere'
      }),
    ],
    [
      'a bound credential the header lacks',
      tamper((v) => {
        ;(v.header as { route: Record<string, unknown> }).route.credentialBinding = bound
      }),
    ],
    ['not a handle at all', async () => inlineRef(refs.infer.input, { x: 1 })],
    [
      'a blob',
      async () => ({ kind: 'blob', schema: refs.infer.input, blob: { digest: 'a'.repeat(64) } }) as never,
    ],
    [
      'a wrong byte count',
      async (rig) => {
        const ref = await handleOf(rig)
        return { ...ref, bytes: 1 } as DataRef
      },
    ],
  ]
  it.each(rows)('%s', async (_name, make) => {
    const out = await same(async (rig) => startOf(rig, await make(rig)))
    expect(out.children.length + (out.next.kind === 'fail' ? 1 : 0)).toBe(1)
  })

  it('refusals and the single child cover several outcomes', async () => {
    const outs = await Promise.all(
      rows.map(async ([, make]) => open('default').then(async (rig) => startOf(rig, await make(rig)))),
    )
    expect(outs.some((o) => o.children.length === 1)).toBe(true)
    expect(
      new Set(outs.flatMap((o) => (o.next.kind === 'fail' ? [o.next.error.detailCode] : []))).size,
    ).toBeGreaterThan(3)
  })

  it('a handle this process never held names the loss and sends nothing', async () => {
    const out = await same(async (rig) => {
      const other = await open(rig.kind)
      const ref = await handleOf(
        other,
        prepareRequestOf({ generation: { maxOutputTokens: 33, thinking: null } }),
      )
      const result = await startOf(rig, ref)
      return { result, deliveries: rig.peer.deliveries(), other: rig.peer.otherQueries() }
    })
    expect(out.result.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_prepared_lost' } })
    expect(out.deliveries + out.other).toBe(0)
  })

  it('a held entry that disagrees with the handle is a mismatch, not a loss', async () => {
    const probe = await open('default')
    const ref = await handleOf(probe)
    const out = await same(async (rig) => {
      await seedOther(rig, idOf(ref))
      return { start: await startOf(rig, ref), deliveries: rig.peer.deliveries() }
    })
    expect(out.start.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_prepared_mismatch' } })
    expect(out.deliveries).toBe(0)
  })

  it('each way a frame can disagree with its own action', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const bad: Array<Partial<ActionFrame>> = [
        { bindingId: 'other' },
        { method: 'prepareRequest' },
        { runId: 'run-2' },
        { actionId: 'parent-1', inputDigest: 'f'.repeat(64) },
        { continuation: { namespace: 'n', codecVersion: '1' } as never },
      ]
      const results = []
      for (const over of bad) results.push(await startOf(rig, ref, over))
      return results
    })
    expect(out.every((t) => t.children.length === 0 && t.next.kind === 'fail')).toBe(true)
  })

  it('a cancelled, retargeted or revoked start sends nothing', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const cancelled = await startOf(rig, ref, {}, AbortSignal.abort())
      rig.state.adapterSelectable = false
      const retargeted = await startOf(rig, ref)
      rig.state.adapterSelectable = true
      rig.state.current = false
      const revoked = await startOf(rig, ref)
      return {
        cancelled,
        retargeted,
        revoked,
        deliveries: rig.peer.deliveries(),
        other: rig.peer.otherQueries(),
      }
    })
    expect(out.deliveries + out.other).toBe(0)
    expect([out.cancelled, out.retargeted, out.revoked].every((t) => t.children.length === 0)).toBe(true)
  })

  it('a closed action refuses and the service stays ready', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const action = await inferOf(rig)
      await action.close('shutdown')
      const refused = shape(await action.start(frameOf(ref), rig.peer.ports))
      return {
        refused,
        ready: (await rig.provider.ready(runCall())).ok,
        drained: await action.drain(runCall().deadline, runCall()),
      }
    })
    expect(out.ready).toBe(true)
    expect(out.refused.next.kind).toBe('fail')
  })
})

describe('infer resume: results, unknown effects and attribution', () => {
  it.each([
    ['succeeded', {}],
    ['failed', {}],
    ['succeeded', { foreignUsage: true }],
    ['unknown_effect', {}],
    ['unknown_effect', { deadline: '2000-01-01T00:00:00.000Z' }],
    [
      'succeeded',
      {
        tamper: (v: Record<string, unknown>) => {
          v.request = 'x'.repeat(64)
        },
      },
    ],
    [
      'succeeded',
      {
        tamper: (v: Record<string, unknown>) => {
          ;(v.child as Record<string, string>).externalKey = 'ext-other'
        },
      },
    ],
    [
      'succeeded',
      {
        tamper: (v: Record<string, unknown>) => {
          ;(v.child as Record<string, string>).childInputDigest = 'a'.repeat(64)
        },
      },
    ],
  ] as Array<[Variant, object]>)('%s %j', async (variant, options) => {
    const out = await same((rig) => lifecycle(rig, variant, options))
    expect(out.started.children).toHaveLength(1)
    expect(out.deliveries).toBe(1)
    expect(out.other).toBe(0)
  })

  it('the observable resume results span completion, waiting and refusals', async () => {
    const kinds = new Set<string>()
    for (const [variant, options] of [
      ['succeeded', {}],
      ['failed', {}],
      ['unknown_effect', {}],
      ['unknown_effect', { deadline: '2000-01-01T00:00:00.000Z' }],
      ['succeeded', { foreignUsage: true }],
    ] as Array<[Variant, object]>) {
      const out = await lifecycle(await open('reference'), variant, options)
      kinds.add(
        `${out.resumed.next.kind}:${out.resumed.next.kind === 'fail' ? out.resumed.next.error.detailCode : ''}`,
      )
    }
    expect(kinds.size).toBe(5)
  })

  it('a fresh process holds no prepared call; saved results are still read and nothing is sent twice', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const action = await inferOf(rig)
      const frame = frameOf(ref)
      const started = await action.start(frame, rig.peer.ports)
      const spec = started.children[0]
      if (!spec) throw new Error('child')
      const child = rig.peer.commit(frame.actionId, spec)
      if (!child.ok) throw new Error('commit')
      await rig.peer.dispatch(child.value, 'succeeded')
      rig.peer.publish(child.value, 'receipt-1')
      await rig.provider.close('shutdown')
      const fresh = await open(rig.kind)
      const second = { ...fresh, peer: rig.peer }
      const lost = await startOf(second, ref)
      const resumed = await (await inferOf(second)).resume(
        {
          ...frame,
          providerRevision: 1,
          continuation: started.continuation,
          receipts: {
            items: [{ actionId: child.value.actionId, receiptId: 'receipt-1', outcome: 'succeeded' }],
            snapshot: 'p',
            nextCursor: null,
            complete: true,
          },
        },
        rig.peer.ports,
      )
      return {
        lost,
        resumed: shape(resumed),
        deliveries: rig.peer.deliveries(),
        other: rig.peer.otherQueries(),
      }
    })
    expect(out.lost.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_prepared_lost' } })
    expect(out.resumed.next.kind).toBe('complete')
    expect(out.deliveries).toBe(1)
    expect(out.other).toBe(0)
  })

  it('empty receipts keep waiting and never create a child', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const action = await inferOf(rig)
      const frame = frameOf(ref)
      const started = await action.start(frame, rig.peer.ports)
      const resumed = await action.resume(
        { ...frame, providerRevision: 1, continuation: started.continuation },
        rig.peer.ports,
      )
      return shape(resumed)
    })
    expect(out.next.kind).toBe('wait')
    expect(out.children).toHaveLength(0)
  })

  it('a resume without its continuation conflicts instead of starting again', async () => {
    const out = await same(async (rig) => {
      const action = await inferOf(rig)
      return shape(await action.resume(frameOf(await handleOf(rig)), rig.peer.ports))
    })
    expect(out.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_continuation_conflict' } })
  })
})

type Held = Record<string, unknown> & { ownerBinding: object; header: object }
describe('refusal order, registry contents and closing', () => {
  const idOf = (ref: DataRef) => (ref.kind === 'inline' ? (ref.value as { handleId: string }).handleId : '')
  const bodyOf = (rig: Rig, ref: DataRef) => {
    const held = rig.hold(idOf(ref)) as { body?: unknown; request?: unknown } | undefined
    return held?.body ?? held?.request
  }

  it('a scope that is not a run is refused before the hook results are looked at', async () => {
    const out = await same(async (rig) => {
      const call = {
        ...runCall(),
        scope: { kind: 'runtime', installationId: 'installation', runtimeId: 'runtime' } as never,
      }
      return prepareOf(rig, prepareRequestOf({ hookResults: hookResultSet() as never }), call)
    })
    expect(out).toMatchObject({ ok: false, detail: 'model_scope' })
  })

  it('the wire body kept for the send is the same for every request that can be sent', async () => {
    const view = prepareRequestOf().view
    const requests = [
      prepareRequestOf(),
      prepareRequestOf({
        view: { ...view, items: [textItem('system', 'a'), textItem('system', 'b'), textItem('user', 'c')] },
      }),
      prepareRequestOf({ view: { ...view, items: [textItem('user', 'one'), textItem('user', 'two')] } }),
      prepareRequestOf({ generation: { maxOutputTokens: 7, thinking: 'low', temperature: 0.25 } as never }),
    ]
    const bodies = await same(async (rig) => {
      const kept = []
      for (const request of requests) kept.push(bodyOf(rig, await handleOf(rig, request)))
      return kept
    })
    expect(bodies.every((body) => body !== undefined)).toBe(true)
    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(requests.length)
  })

  it('every held fact the handle repeats must agree, one at a time', async () => {
    const probe = await open('default')
    const ref = await handleOf(probe)
    const changes: Array<[string, (held: Held) => Record<string, unknown>]> = [
      ['run', (held) => ({ ...held, runId: 'run-9' })],
      ['session', (held) => ({ ...held, sessionId: 'session-9' })],
      ['owner', (held) => ({ ...held, ownerBinding: { ...held.ownerBinding, bindingId: 'o' } })],
      ['header', (held) => ({ ...held, header: { ...held.header, maxOutputTokens: 1 } })],
      ['input digest', (held) => ({ ...held, inputDigest: 'c'.repeat(64) })],
    ]
    for (const [name, change] of changes) {
      const out = await same(async (rig) => {
        const other = await open(rig.kind)
        await handleOf(other)
        rig.put(idOf(ref), change(other.hold(idOf(ref)) as Held))
        return { name, start: await startOf(rig, ref), deliveries: rig.peer.deliveries() }
      })
      expect(out.start.next, name).toMatchObject({
        kind: 'fail',
        error: { detailCode: 'model_prepared_mismatch' },
      })
      expect(out.deliveries).toBe(0)
    }
  })

  it('an adapter binding that is not the one prepared for is a changed target', async () => {
    let swapped = false
    const out = await same(
      async (rig) => {
        swapped = false
        const ref = await handleOf(rig)
        swapped = true
        return { start: await startOf(rig, ref), prepare: await prepareOf(rig, prepareRequestOf()) }
      },
      {
        adapters: {
          select: (target) =>
            target.bindingId !== ADAPTER.bindingId
              ? null
              : {
                  binding: swapped ? { ...ADAPTER, logicalName: 'other' } : ADAPTER,
                  packageDigest: 'package-1',
                },
        },
      },
    )
    expect(out.start.next).toMatchObject({ kind: 'fail', error: { detailCode: 'model_target_changed' } })
    expect(out.prepare).toMatchObject({ ok: false, detail: 'model_adapter_unavailable' })
  })

  it('a call cancelled while the units are estimated registers nothing', async () => {
    const probe = await open('default')
    const id = idOf(await handleOf(probe))
    let control = new AbortController()
    const out = await same(
      async (rig) => {
        control = new AbortController()
        const result = await prepareOf(rig, prepareRequestOf(), runCall(control.signal))
        return { result, held: rig.hold(id) === undefined }
      },
      {
        estimate: () => {
          control.abort()
          return []
        },
      },
    )
    expect(out).toEqual({ result: { ok: false, code: 'cancelled', detail: 'model_cancelled' }, held: true })
  })

  it('closing the service forgets every prepared call', async () => {
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const before = rig.hold(idOf(ref)) !== undefined
      await rig.provider.close('shutdown')
      return { before, after: rig.hold(idOf(ref)) !== undefined }
    })
    expect(out).toEqual({ before: true, after: false })
  })

  it('drain reports what is in flight, and the managed preparation reports nothing', async () => {
    const never = () => new Promise<never>(() => {})
    const out = await same(async (rig) => {
      const ref = await handleOf(rig)
      const action = await inferOf(rig)
      const frame = frameOf(ref)
      const started = await action.start(frame, rig.peer.ports)
      const spec = started.children[0]
      if (!spec) throw new Error('child')
      const child = rig.peer.commit(frame.actionId, spec)
      if (!child.ok) throw new Error('commit')
      const pending = action.resume(
        {
          ...frame,
          providerRevision: 1,
          continuation: started.continuation,
          receipts: {
            items: [{ actionId: child.value.actionId, receiptId: 'r', outcome: 'succeeded' }],
            snapshot: 'p',
            nextCursor: null,
            complete: true,
          },
        },
        { ...rig.peer.ports, query: never },
      )
      await new Promise((resolve) => setTimeout(resolve, 5))
      const drained = await action.drain(runCall().deadline, runCall())
      const settled = shape(await pending)
      return { drained, settled: settled.next }
    })
    expect(out.drained).toMatchObject({
      value: { state: 'blocked', activeInvocationIds: ['invocation-parent'] },
    })
  })
  it('the managed preparation drains without naming its in-flight call', async () => {
    const SECRETS = {
      bindingId: 'secrets',
      providerId: 'agh.default/secrets',
      contract: 'agh.secrets',
      logicalName: 'default',
    }
    const out = await same(
      async (rig) => {
        const factory = rig.provider.actions?.prepareRequest
        if (!factory) throw new Error('prepareRequest missing')
        const action = await factory.create({
          instanceId: 'i',
          actionId: 'parent-1',
          runId: 'run-1',
          bindingId: OWNER_ID,
          scope: runCall().scope,
          signal: new AbortController().signal,
        })
        if (action.kind !== 'composite') throw new Error('not composite')
        const input = inlineRef(refs.prepareRequest.input, {
          ...prepareRequestOf({ route: route({ credentialBinding: bound }) }),
          credentialRefresh: null,
        })
        const frame = {
          ...frameOf(input),
          method: 'prepareRequest',
          input,
          inputDigest: input.kind === 'inline' ? input.digest : '',
        } as ActionFrame
        const pending = action.start(frame, { ...rig.peer.ports, query: () => new Promise<never>(() => {}) })
        await new Promise((resolve) => setTimeout(resolve, 5))
        const drained = await action.drain(runCall().deadline, runCall())
        return { drained, settled: shape(await pending).next }
      },
      { secrets: SECRETS },
    )
    expect(out.drained).toMatchObject({ value: { state: 'drained', activeInvocationIds: [] } })
  })
})

describe('prepare with tools: the default and the reference answer every input alike', () => {
  const DOC = standardToolDocument()
  const tool = (name = 'text_statistics', description = 'Count the words of a text') =>
    standardTool(name, description)
  const withDoc = (name: string, document: unknown, description = 'A tool') =>
    standardTool(name, description, document)
  const objectDoc = (schema: object, defs: Record<string, unknown> = {}) => ({
    $schema: DOC.$schema,
    $ref: '#/$defs/Input',
    $defs: { ...defs, Input: schema },
  })
  type Entry = ReturnType<typeof standardTool>
  const portOf = (entries: readonly Entry[]) => ({
    resolve: async () => ({ ok: true as const, value: entries.map((entry) => entry.resolved) }),
  })
  const toolItem = (
    kind: 'tool-call' | 'tool-result',
    trust: 'derived' | 'external',
    value: unknown,
    pair: string | null,
  ) =>
    ({
      ...textItem('user', 'x'),
      id: `item-${kind}-${String(pair)}-${JSON.stringify(value).length}`,
      kind,
      trust,
      toolPairRef: pair,
      body: inlineRef(
        {
          typeId: kind === 'tool-call' ? 'agh.context/tool-call-body@1' : 'agh.context/tool-result-body@1',
          revision: 1,
          digest: 'a'.repeat(64),
        },
        value,
      ),
    }) as never
  const call = (id: string, ordinal = 0, name = 'text_statistics') =>
    toolItem('tool-call', 'derived', { toolUseId: id, name, args: { q: 1 }, ordinal }, id)
  const back = (id: string, isError = false) =>
    toolItem(
      'tool-result',
      'external',
      { toolUseId: id, content: [{ type: 'text', text: 'done' }], isError },
      id,
    )
  const request = (entries: readonly Entry[], items: unknown[] = [], over: object = {}) =>
    prepareRequestOf({
      route: toolRoute(prepareRequestOf().route) as never,
      toolCatalog: toolCatalogOf(entries.map((entry) => entry.definition)) as never,
      view: { ...prepareRequestOf().view, items: [textItem('user', 'hi'), ...items] as never },
      ...over,
    })
  const one = tool()
  const big = withDoc('big_tool', objectDoc({ type: 'object', enum: ['x'.repeat(270_000)] }))
  const rows: Array<[string, () => ModelPrepareRequest, Partial<ReferenceModelDeployment>?]> = [
    ['one tool', () => request([one]), { tools: portOf([one]) }],
    [
      'two tools keep catalog order',
      () => request([one, tool('read_file', 'Read')]),
      { tools: portOf([one, tool('read_file', 'Read')]) },
    ],
    ['an empty catalog', () => request([]), { tools: portOf([]) }],
    [
      'a description changed under the same schema',
      () => request([one]),
      { tools: portOf([tool('text_statistics', 'Count the lines of a text')]) },
    ],
    ['no resolver installed', () => request([one])],
    [
      'a resolver that refuses',
      () => request([one]),
      {
        tools: {
          resolve: async () => ({
            ok: false as const,
            error: {
              code: 'denied' as const,
              detailCode: 'no',
              message: 'm',
              retryAdvice: { kind: 'never' as const },
              diagnosticId: 'd',
            },
          }),
        },
      },
    ],
    [
      'a resolver that throws',
      () => request([one]),
      {
        tools: {
          resolve: async () => {
            throw new Error('down')
          },
        },
      },
    ],
    ['one answer too few', () => request([one, tool('read_file')]), { tools: portOf([one]) }],
    ['an answer for another name', () => request([one]), { tools: portOf([tool('other_name')]) }],
    [
      'a document that is not the bound one',
      () => request([one]),
      {
        tools: portOf([
          { ...one, resolved: { ...one.resolved, document: { ...DOC, $defs: { ...DOC.$defs, X: {} } } } },
        ]),
      },
    ],
    [
      'a name with a hyphen',
      () => request([tool('text-statistics')]),
      { tools: portOf([tool('text-statistics')]) },
    ],
    ['the same name twice', () => request([one, tool()]), { tools: portOf([one, tool()]) }],
    ['an empty description', () => request([tool('a', '')]), { tools: portOf([tool('a', '')]) }],
    [
      'a description over the limit',
      () => request([tool('a', 'x'.repeat(4097))]),
      { tools: portOf([tool('a', 'x'.repeat(4097))]) },
    ],
    [
      'a keyword outside the subset',
      () => request([withDoc('a', objectDoc({ type: 'object', pattern: 'x' }))]),
      { tools: portOf([withDoc('a', objectDoc({ type: 'object', pattern: 'x' }))]) },
    ],
    [
      'an x- extension is dropped',
      () => request([withDoc('a', objectDoc({ type: 'object', 'x-max-bytes': 5 }))]),
      { tools: portOf([withDoc('a', objectDoc({ type: 'object', 'x-max-bytes': 5 }))]) },
    ],
    [
      'a recursive definition',
      () =>
        request([
          withDoc(
            'a',
            objectDoc(
              { $ref: '#/$defs/Loop' },
              { Loop: { type: 'object', properties: { next: { $ref: '#/$defs/Loop' } } } },
            ),
          ),
        ]),
      {
        tools: portOf([
          withDoc(
            'a',
            objectDoc(
              { $ref: '#/$defs/Loop' },
              { Loop: { type: 'object', properties: { next: { $ref: '#/$defs/Loop' } } } },
            ),
          ),
        ]),
      },
    ],
    [
      'a root that is not an object',
      () => request([withDoc('a', objectDoc({ type: 'string' }))]),
      { tools: portOf([withDoc('a', objectDoc({ type: 'string' }))]) },
    ],
    ['an oversize parameter schema', () => request([big]), { tools: portOf([big]) }],
    [
      'tools together with an output schema',
      () =>
        request([one], [], {
          outputSchema: runtimeAuthorSchemasRef(),
          route: route({
            features: { ...prepareRequestOf().route.features, tools: true, structuredOutput: true },
          }),
        }),
      { tools: portOf([one]) },
    ],
    ['a call and its result', () => request([one], [call('c1'), back('c1')]), { tools: portOf([one]) }],
    [
      'two calls answered out of order',
      () => request([one], [call('b', 1), call('a', 0), back('b'), back('a')]),
      { tools: portOf([one]) },
    ],
    [
      'an error result',
      () => request([one], [call('c1'), back('c1', true), textItem('user', 'again')]),
      { tools: portOf([one]) },
    ],
    ['a result without a call', () => request([one], [back('c1')]), { tools: portOf([one]) }],
    ['a call without a result', () => request([one], [call('c1')]), { tools: portOf([one]) }],
    ['a result for another call', () => request([one], [call('c1'), back('c2')]), { tools: portOf([one]) }],
    [
      'a repeated ordinal',
      () => request([one], [call('a', 0), call('b', 0), back('a'), back('b')]),
      { tools: portOf([one]) },
    ],
    [
      'a call trusted as external',
      () =>
        request(
          [one],
          [
            toolItem('tool-call', 'external', { toolUseId: 'a', name: 'x', args: {}, ordinal: 0 }, 'a'),
            back('a'),
          ],
        ),
      { tools: portOf([one]) },
    ],
    [
      'a call body with an extra key',
      () =>
        request(
          [one],
          [
            toolItem(
              'tool-call',
              'derived',
              { toolUseId: 'a', name: 'x', args: {}, ordinal: 0, more: 1 },
              'a',
            ),
            back('a'),
          ],
        ),
      { tools: portOf([one]) },
    ],
    ['a call id with a space', () => request([one], [call('a b'), back('a b')]), { tools: portOf([one]) }],
    [
      'a message between a call and its result',
      () => request([one], [call('a'), textItem('user', 'x'), back('a')]),
      { tools: portOf([one]) },
    ],
    [
      'history with thinking on a native replay model',
      () =>
        request([one], [call('a'), back('a')], {
          generation: { maxOutputTokens: 32, thinking: 'low' },
        }),
      { tools: portOf([one]) },
    ],
    [
      'history without a catalog',
      () =>
        prepareRequestOf({
          view: {
            ...prepareRequestOf().view,
            items: [textItem('user', 'hi'), call('a'), back('a')] as never,
          },
        }),
    ],
  ]
  it.each(rows)('%s', async (_name, build, over = {}) => {
    const verifies: Partial<ReferenceModelDeployment> = {
      ...over,
      credentials: { verifyIssued: () => true },
    }
    const outcome = await same(async (rig) => {
      const request = build()
      const answer = await prepareOf(rig, request)
      if (!answer.ok) return { answer }
      const held = rig.hold(idOf(await handleOf(rig, request)))
      return {
        answer,
        body: (held as { body?: unknown; request?: unknown }).body ?? (held as { request?: unknown }).request,
      }
    }, verifies)
    expect(outcome).toBeDefined()
  })

  it('the rows reach completion and the named wire refusals', async () => {
    const seen = new Set<string>()
    for (const [, build, over] of rows) {
      const rig = await open('default', { ...over, credentials: { verifyIssued: () => true } })
      const out = await prepareOf(rig, build())
      seen.add(out.ok ? 'ok' : out.detail)
    }
    expect(seen.has('ok')).toBe(true)
    for (const name of [
      'model_wire_tools',
      'model_wire_tool_name',
      'model_wire_tool_description',
      'model_wire_tool_schema',
      'model_wire_tool_schema_recursive',
      'model_wire_tools_oversize',
      'model_wire_tool_pair',
      'model_wire_tool_id',
      'model_wire_tool_history',
      'model_wire_tool_thinking',
      'model_wire_output_schema',
      'model_wire_item',
      'model_dependency_unavailable',
    ])
      expect(seen.has(name), name).toBe(true)
  })

  it('both bind the descriptions into the input digest, and to the same value', async () => {
    const digestOf = async (kind: Kind, description: string) => {
      const rig = await open(kind, {
        tools: portOf([tool('text_statistics', description)]),
        credentials: { verifyIssued: () => true },
      })
      const out = await prepareOf(rig, request([one]))
      if (!out.ok || out.value.kind !== 'inline') throw new Error('refused')
      return (out.value.value as { inputDigest: string }).inputDigest
    }
    const [a, b] = [await digestOf('default', 'one'), await digestOf('default', 'two')]
    expect(a).not.toBe(b)
    expect(await digestOf('reference', 'one')).toBe(a)
    expect(await digestOf('reference', 'two')).toBe(b)
  })
})

describe('prepare refuses modes the adapter cannot serve, alike in both', () => {
  const structured = (over: object = {}) =>
    prepareRequestOf({
      route: route({ features: { ...prepareRequestOf().route.features, structuredOutput: true } }) as never,
      ...over,
    })
  const unbound = (over: object = {}) =>
    prepareRequestOf({ route: route({ credentialBinding: null }) as never, credentialRef: null, ...over })
  const rows: Array<[string, () => ModelPrepareRequest, string]> = [
    [
      'an output schema on a route that declares structured output',
      () => structured({ outputSchema: runtimeAuthorSchemasRef() }),
      'model_wire_output_schema',
    ],
    [
      'an output schema without the feature',
      () => prepareRequestOf({ outputSchema: runtimeAuthorSchemasRef() }),
      'model_feature_mismatch',
    ],
    ['a route without a credential binding', () => unbound(), 'model_credential_required'],
    [
      'a handle on a route without a binding',
      () => unbound({ credentialRef: longLived() }),
      'model_credential_binding',
    ],
    ['a bound route with its handle', () => prepareRequestOf(), 'ok'],
  ]
  it.each(rows)('%s', async (_name, build, expected) => {
    const outcome = await same((rig) => prepareOf(rig, build()), {
      credentials: { verifyIssued: () => true },
    })
    expect(outcome.ok ? 'ok' : outcome.detail).toBe(expected)
  })
})

describe('what the two implementations are expected to differ in', () => {
  it('own provider id, codec namespaces and registry; same operations', async () => {
    const d = createDefaultModelFactory({
      ...referenceDeployment(),
      registry: createPreparedRegistry(),
    } as unknown as ModelDeployment)
    const r = createReferenceModelFactory(referenceDeployment())
    expect(r.descriptor.providerId).not.toBe(d.descriptor.providerId)
    expect(r.descriptor.stateCodecs.map((c) => c.namespace)).not.toEqual(
      d.descriptor.stateCodecs.map((c) => c.namespace),
    )
    const strip = (x: typeof d.descriptor) => ({
      ...x,
      providerId: '',
      stateCodecs: x.stateCodecs.map((c) => ({ ...c, namespace: '' })),
    })
    expect(strip(r.descriptor)).toEqual(strip(d.descriptor))
  })
})

export type { RuntimeError }
