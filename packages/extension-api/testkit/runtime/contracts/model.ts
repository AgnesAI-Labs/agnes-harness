import type {
  CallContext,
  DataRef,
  FactoryContext,
  LoopReadPorts,
  Outcome,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { runtimeAuthorSchemas } from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  type ActionResultView,
  type ActionVisibilityValue,
  canonicalJsonDigest,
  type ModelOutput,
  type PreparedAction,
  type RuntimeError,
  RuntimeMethodSchemaRefs,
  RuntimeSchemaRefs,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'
import { createTestServiceContainer } from '../harness.js'

const refs = RuntimeMethodSchemaRefs['agh.model']
const adapterRefs = RuntimeMethodSchemaRefs['agh.model-adapter']
const probe = RuntimeMethodSchemaRefs['agh.state'].probeActionResult
const CHILD_KEY = 'adapter-invoke'

export type ModelChild = Readonly<{ actionId: string; spec: PreparedAction }>
/** The restricted child peer: stands in for State's child creation and for the adapter leaf, in tests only. */
export interface ModelChildPeer {
  readonly ports: LoopReadPorts
  commit(parentActionId: string, child: PreparedAction): Outcome<ModelChild>
  dispatch(
    child: ModelChild,
    outcome: 'succeeded' | 'failed' | 'unknown_effect',
    options?: { foreignUsage?: boolean },
  ): Promise<void>
  publish(child: ModelChild, receiptId: string): ActionResultView
  deliveries(): number
  /** Queries that were not a published-result probe, for example a credential read; the model service makes none on a start or resume. */
  otherQueries(): number
}
export interface ModelContractFixture {
  factory: ProviderFactory<ServiceProvider>
  configuration: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  /** A run-scope call. */
  call: CallContext
  /** Inline `ModelPrepareRequest`. */
  prepareInput: DataRef
  /** This implementation's own, independent expectation of the prepared request's input digest. */
  recomputeDigest(prepareInput: DataRef): string
  /** One peer for the whole fixture, shared with whatever `restart` returns, so deliveries survive a restart. */
  peer: ModelChildPeer
  /** A prepared handle held by this process's registry that another binding owns. */
  foreignOwnedPrepared(): DataRef
  /** A prepared handle held by this process's registry that belongs to another run. */
  foreignRunPrepared(): DataRef
  /** A well-formed handle for this run and owner that this process's registry has never held. */
  unpreparedHandle(): DataRef
  /** After this, the adapter a request was prepared for is no longer the selected one. */
  retarget(): Promise<void>
  revoke(): Promise<void>
  restart(): Promise<ModelContractFixture>
  close(): Promise<void>
}

const failure = (code: RuntimeError['code'], detailCode: string): { ok: false; error: RuntimeError } => ({
  ok: false,
  error: { code, detailCode, message: 'm', retryAdvice: { kind: 'never' }, diagnosticId: 'model-contract' },
})
const inline = (schema: SchemaRef, value: unknown): DataRef => ({
  kind: 'inline',
  schema,
  value: value as never,
  digest: canonicalJsonDigest(value as never),
  bytes: new TextEncoder().encode(JSON.stringify(value)).length,
})

/** Restricted child peer: stable child per parent and key, one delivery per child, published result views. */
export function createModelChildPeer(options: {
  adapter: ModelChild['spec']['target']
  state: string
  usageIds?: readonly string[]
}): ModelChildPeer {
  const usageIds = options.usageIds ?? ['usage-1']
  const children = new Map<string, ModelChild>()
  const results = new Map<string, ActionResultView>()
  const published = new Map<string, ActionVisibilityValue>()
  let delivered = 0
  let other = 0
  const ports: LoopReadPorts = {
    prepare(spec) {
      const prepared = validateRuntime('PreparedAction', {
        ...spec,
        intentFingerprint: canonicalJsonDigest(spec),
      })
      return prepared.ok ? { ok: true, value: prepared.value } : failure('invalid_input', 'peer_prepare')
    },
    async query(request) {
      if (request.target.bindingId !== options.state || request.method !== 'probeActionResult') other++
      if (request.target.bindingId !== options.state || request.method !== 'probeActionResult')
        return failure('denied', 'peer_method')
      const input =
        request.input.kind === 'inline'
          ? validateRuntime('ProbeActionResultRequest', request.input.value)
          : null
      if (!input?.ok) return failure('invalid_input', 'peer_query')
      const view = published.get(`${input.value.actionId}\0${input.value.sourceReceiptId}`) ?? null
      return { ok: true, value: { kind: 'value', snapshot: 'peer', output: inline(probe.output, view) } }
    },
    async compute() {
      return failure('denied', 'peer_compute')
    },
    async resolveData(ref) {
      return ref.kind === 'inline' ? { ok: true, value: ref.value } : failure('denied', 'peer_data')
    },
  }
  return {
    ports,
    commit(parentActionId, child) {
      const key = `${parentActionId}\0${child.key}`
      const prior = children.get(key)
      if (prior)
        return prior.spec.intentFingerprint === child.intentFingerprint
          ? { ok: true, value: prior }
          : failure('conflict', 'idempotency_conflict')
      const created = { actionId: `child-${canonicalJsonDigest(key).slice(0, 16)}`, spec: child }
      children.set(key, created)
      return { ok: true, value: created }
    },
    async dispatch(child, outcome, dispatchOptions = {}) {
      if (results.has(child.actionId)) return
      delivered++
      const input = child.spec.input
      const output: ModelOutput = {
        outputRef: inline(runtimeAuthorSchemas.StandardToolOutput.ref, {
          content: [],
          structured: { text: 'ok' },
        }),
        finishReason: 'stop',
        usageFactRefs: [...usageIds, ...(dispatchOptions.foreignUsage ? ['usage-foreign'] : [])].map(
          (usageId) => ({
            authorityId: 'usage',
            usageId,
            digest: 'd'.repeat(64),
          }),
        ),
        providerReceipt: null,
        actualModel: 'fixture-model',
      }
      results.set(child.actionId, {
        receiptId: 'pending',
        actionId: child.actionId,
        attemptId: 'attempt',
        bindingId: options.adapter.bindingId,
        inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
        outcome,
        externalRequests: [],
        usageRefs: outcome === 'succeeded' ? [...usageIds] : [],
        references: [],
        provenance: { sourceRefs: [], producer: options.adapter, trustLabels: [] },
        completedAt: new Date().toISOString(),
        visibility: 'ready',
        viewId: 'view',
        sourceReceiptId: 'pending',
        hookResultSetRef: null,
        ...(outcome === 'succeeded'
          ? { result: inline(adapterRefs.invoke.output, output) }
          : {
              error:
                outcome === 'failed'
                  ? failure('denied', 'credential_refresh_required').error
                  : failure('unknown_effect', 'peer_unknown').error,
            }),
      })
    },
    publish(child, receiptId) {
      const recorded = results.get(child.actionId)
      if (!recorded) throw new Error('child was not dispatched')
      const view: ActionResultView = { ...recorded, receiptId, sourceReceiptId: receiptId }
      published.set(`${child.actionId}\0${receiptId}`, {
        actionId: child.actionId,
        sourceReceiptId: receiptId,
        revision: 1,
        state: 'ready',
        stageActionId: null,
        registrationDigest: null,
        result: view,
        uiResult: null,
        publishedByCommitId: 'peer-commit',
      })
      return view
    },
    deliveries: () => delivered,
    otherQueries: () => other,
  }
}

const LOST = 'model_prepared_lost'

function assert(condition: unknown, id: string): asserts condition {
  if (!condition) throw new Error(`Model contract assertion failed: ${id}`)
}

function inferFrame(
  fixture: ModelContractFixture,
  preparedRef: DataRef,
  over: Partial<ActionFrame> = {},
): ActionFrame {
  const { signal: _signal, ...context } = fixture.call
  const input = inline(refs.infer.input, { preparedRef })
  return {
    actionId: 'parent-1',
    parentActionId: null,
    runId: runIdOf(fixture.call),
    bindingId: fixture.factoryContext.bindingId,
    method: 'infer',
    input,
    inputDigest: input.kind === 'inline' ? input.digest : input.blob.digest,
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
    observedAt: new Date().toISOString(),
    context,
    actionTimebox: { defaultTimeoutMs: 10_000, maxDeadline: context.deadline },
    ...over,
  }
}
function runIdOf(call: CallContext): string {
  assert(call.scope.kind === 'run' || call.scope.kind === 'action', 'run-scope-call')
  return call.scope.runId
}

/** Every scenario drives an actually selected service and its composite `infer` against the restricted peer. */
export async function runModelContractScenario(
  scenario: ScenarioName,
  open: () => Promise<ModelContractFixture>,
) {
  let fixture = await open()
  let provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const binding = () => ({
    bindingId: fixture.factoryContext.bindingId,
    contract: 'agh.model',
    logicalName: fixture.factory.descriptor.logicalName,
    providerId: fixture.factory.descriptor.providerId,
  })
  const prepare = async (input = fixture.prepareInput, call = fixture.call) => {
    const container = createTestServiceContainer()
    const requirement = {
      contract: 'agh.model',
      major: 1,
      logicalName: fixture.factory.descriptor.logicalName,
      features: [],
      scope: 'runtime' as const,
      optional: false,
    }
    assert(provider.compute, 'compute-present')
    container.register({ requirement, binding: binding(), compute: provider.compute })
    const dependency = container.dependencies.get(requirement)
    assert(dependency.ok, 'selected-dependency')
    return dependency.value.compute({ target: binding(), method: 'prepare', input }, call)
  }
  const prepared = async () => {
    const result = await prepare()
    assert(result.ok && result.value.kind === 'inline', 'prepare-inline')
    assert(
      canonicalJsonDigest(result.value.schema) === canonicalJsonDigest(refs.prepare.output),
      'prepare-output-schema',
    )
    const parsed = validateRuntime('ModelPrepareResult', result.value.value)
    assert(parsed.ok && parsed.value.preparedRef.kind === 'inline', 'prepare-result')
    return { output: result.value, ref: parsed.value.preparedRef, result: parsed.value }
  }
  const createInfer = async (signal: AbortSignal = new AbortController().signal, actionId = 'parent-1') => {
    const factory = provider.actions?.infer
    assert(factory, 'infer-present')
    const action = await factory.create({
      instanceId: 'contract-instance',
      actionId,
      runId: runIdOf(fixture.call),
      bindingId: fixture.factoryContext.bindingId,
      scope: fixture.call.scope,
      signal,
    })
    assert(action.kind === 'composite', 'infer-composite')
    return action
  }
  const startWith = async (ref: DataRef) =>
    (await createInfer()).start(inferFrame(fixture, ref), fixture.peer.ports)
  try {
    assert((await provider.ready(fixture.call)).ok, 'ready')
    if (scenario === 'select') {
      const { descriptor } = fixture.factory
      assert(validateRuntime('ProviderDescriptor', descriptor).ok, 'descriptor')
      assert(descriptor.contract === 'agh.model', 'contract')
      const shape = descriptor.operations.map((operation) => `${operation.method}:${operation.kind}`).sort()
      assert(shape.join() === 'infer:action,prepare:compute,prepareRequest:action', 'exact-operations')
      const byMethod = (method: string) =>
        descriptor.operations.find((operation) => operation.method === method)
      assert(
        byMethod('infer')?.requiredCapabilities.length &&
          !byMethod('prepare')?.requiredCapabilities.length &&
          !byMethod('prepareRequest')?.requiredCapabilities.length,
        'capabilities',
      )
      assert(
        byMethod('prepare')?.retrySafety === 'read-only' &&
          byMethod('prepareRequest')?.retrySafety === 'never' &&
          byMethod('infer')?.retrySafety === 'never',
        'retry-safety',
      )
      assert(
        provider.actions?.prepareRequest?.kind === 'composite' &&
          provider.actions.infer?.kind === 'composite',
        'composite-kinds',
      )
      const { ref, result } = await prepared()
      assert(result.inputDigest === fixture.recomputeDigest(fixture.prepareInput), 'independent-digest')
      assert(
        canonicalJsonDigest(ref.schema) === canonicalJsonDigest(RuntimeSchemaRefs.PreparedModelHandle),
        'handle-schema',
      )
      const body = validateRuntime('PreparedModelHandle', ref.value)
      assert(body.ok && !('view' in body.value) && !('prepared' in body.value), 'handle-without-request')
    } else if (scenario === 'normal') {
      const { ref } = await prepared()
      const action = await createInfer()
      const frame = inferFrame(fixture, ref)
      const started = await action.start(frame, fixture.peer.ports)
      assert(started.children.length === 1, 'one-child')
      const spec = started.children[0]
      assert(spec, 'child-present')
      assert(
        spec.key === CHILD_KEY &&
          spec.method === 'invoke' &&
          spec.target.contract === 'agh.model-adapter' &&
          spec.retry.mode === 'never' &&
          spec.obligation === 'mandatory',
        'child-shape',
      )
      const invoke =
        spec.input.kind === 'inline' ? validateRuntime('ModelAdapterInvokeRequest', spec.input.value) : null
      assert(
        invoke?.ok && canonicalJsonDigest(invoke.value.preparedCallRef) === canonicalJsonDigest(ref),
        'original-ref',
      )
      const committed = fixture.peer.commit(frame.actionId, spec)
      const again = fixture.peer.commit(frame.actionId, spec)
      assert(committed.ok && again.ok && committed.value.actionId === again.value.actionId, 'stable-child')
      await fixture.peer.dispatch(committed.value, 'succeeded')
      const view = fixture.peer.publish(committed.value, 'receipt-1')
      const resumed: ActionFrame = {
        ...frame,
        providerRevision: 1,
        continuation: started.continuation,
        receipts: {
          items: [{ actionId: committed.value.actionId, receiptId: 'receipt-1', outcome: 'succeeded' }],
          snapshot: 'published',
          nextCursor: null,
          complete: true,
        },
      }
      const done = await action.resume(resumed, fixture.peer.ports)
      assert(done.children.length === 0 && done.next.kind === 'complete', 'complete')
      assert(done.next.output.kind === 'inline', 'complete-inline')
      assert(
        canonicalJsonDigest(done.next.output.schema) === canonicalJsonDigest(refs.infer.output),
        'complete-schema',
      )
      const output = validateRuntime('ModelOutput', done.next.output.value)
      assert(output.ok, 'complete-output')
      assert(
        output.value.usageFactRefs.map((usage) => usage.usageId).join() === view.usageRefs.join(),
        'usage-from-child',
      )
      assert(fixture.peer.deliveries() === 1, 'one-delivery')
      assert(!('usage' in done) && !('usageFacts' in done), 'no-parent-usage')
      const foreign = await createInfer(undefined, 'parent-2')
      const foreignFrame = inferFrame(fixture, ref, { actionId: 'parent-2' })
      const foreignStart = await foreign.start(foreignFrame, fixture.peer.ports)
      const foreignSpec = foreignStart.children[0]
      assert(foreignSpec, 'foreign-child-present')
      const foreignChild = fixture.peer.commit('parent-2', foreignSpec)
      assert(foreignChild.ok, 'foreign-commit')
      await fixture.peer.dispatch(foreignChild.value, 'succeeded', { foreignUsage: true })
      fixture.peer.publish(foreignChild.value, 'receipt-2')
      const refused = await foreign.resume(
        {
          ...foreignFrame,
          providerRevision: 1,
          continuation: foreignStart.continuation,
          receipts: {
            items: [{ actionId: foreignChild.value.actionId, receiptId: 'receipt-2', outcome: 'succeeded' }],
            snapshot: 'published',
            nextCursor: null,
            complete: true,
          },
        },
        fixture.peer.ports,
      )
      assert(
        refused.next.kind === 'fail' && refused.next.error.detailCode === 'model_usage_attribution',
        'usage-attribution',
      )
    } else if (scenario === 'deny') {
      const { ref } = await prepared()
      const refused = async (target: DataRef, id: string) => {
        const out = await startWith(target)
        assert(out.children.length === 0 && out.next.kind === 'fail', id)
        return out.next.error.detailCode
      }
      assert((await refused(fixture.foreignOwnedPrepared(), 'owner-mismatch-denied')) !== LOST, 'owner-held')
      assert((await refused(fixture.foreignRunPrepared(), 'run-mismatch-denied')) !== LOST, 'run-held')
      assert((await refused(fixture.unpreparedHandle(), 'registry-miss-denied')) === LOST, 'miss-is-lost')
      await fixture.retarget()
      await refused(ref, 'target-changed-denied')
      await fixture.revoke()
      assert(!(await prepare()).ok, 'prepare-denied')
      await refused(ref, 'start-denied')
      assert(fixture.peer.deliveries() === 0 && fixture.peer.otherQueries() === 0, 'nothing-delivered')
    } else if (scenario === 'cancel') {
      const aborted = new AbortController()
      aborted.abort()
      const cancelled = await prepare(fixture.prepareInput, { ...fixture.call, signal: aborted.signal })
      assert(!cancelled.ok && cancelled.error.code === 'cancelled', 'prepare-cancelled')
      const { ref } = await prepared()
      const early = await (await createInfer(aborted.signal)).start(
        inferFrame(fixture, ref),
        fixture.peer.ports,
      )
      assert(
        early.children.length === 0 && early.next.kind === 'fail' && early.next.error.code === 'cancelled',
        'start-cancelled',
      )
      const live = new AbortController()
      const action = await createInfer(live.signal)
      const frame = inferFrame(fixture, ref)
      const started = await action.start(frame, fixture.peer.ports)
      const spec = started.children[0]
      assert(spec, 'child-present')
      const committed = fixture.peer.commit(frame.actionId, spec)
      assert(committed.ok, 'commit')
      let began = () => {}
      const waiting = new Promise<void>((resolve) => {
        began = resolve
      })
      const pending = action.resume(
        {
          ...frame,
          providerRevision: 1,
          continuation: started.continuation,
          receipts: {
            items: [{ actionId: committed.value.actionId, receiptId: 'receipt-1', outcome: 'succeeded' }],
            snapshot: 'published',
            nextCursor: null,
            complete: true,
          },
        },
        {
          ...fixture.peer.ports,
          query: () => {
            began()
            return new Promise(() => {})
          },
        },
      )
      await waiting
      live.abort()
      assert((await pending).next.kind === 'fail', 'resume-interrupted')
      assert(fixture.peer.deliveries() === 0, 'nothing-delivered')
    } else if (scenario === 'recover') {
      const { ref } = await prepared()
      const sent = async (actionId: string, outcome: 'succeeded' | 'unknown_effect') => {
        const action = await createInfer(undefined, actionId)
        const frame = inferFrame(fixture, ref, { actionId })
        const started = await action.start(frame, fixture.peer.ports)
        const spec = started.children[0]
        assert(spec, 'child-present')
        const committed = fixture.peer.commit(actionId, spec)
        assert(committed.ok, 'commit')
        await fixture.peer.dispatch(committed.value, outcome)
        fixture.peer.publish(committed.value, `receipt-${actionId}`)
        await action.close('shutdown')
        const resume = (over: Partial<ActionFrame> = {}): ActionFrame => ({
          ...inferFrame(fixture, ref, { actionId }),
          providerRevision: 1,
          continuation: started.continuation,
          receipts: {
            items: [{ actionId: committed.value.actionId, receiptId: `receipt-${actionId}`, outcome }],
            snapshot: 'published',
            nextCursor: null,
            complete: true,
          },
          ...over,
        })
        return resume
      }
      const saved = await sent('parent-1', 'succeeded')
      const unknown = await sent('parent-2', 'unknown_effect')
      assert(fixture.peer.deliveries() === 2, 'two-deliveries-before-restart')
      await provider.close('shutdown')
      fixture = await fixture.restart()
      provider = await fixture.factory.create(
        fixture.configuration,
        fixture.dependencies,
        fixture.factoryContext,
      )
      assert((await provider.ready(fixture.call)).ok, 'reopened-ready')
      // A fresh process holds no prepared call: a new start names the loss and neither sends nor reads a credential.
      const lost = await startWith(ref)
      assert(
        lost.children.length === 0 && lost.next.kind === 'fail' && lost.next.error.detailCode === LOST,
        'registry-miss-is-lost',
      )
      // The saved result is still read from the published child, never sent again.
      const done = await (await createInfer(undefined, 'parent-1')).resume(saved(), fixture.peer.ports)
      assert(done.children.length === 0 && done.next.kind === 'complete', 'saved-result')
      // A child whose effect is unknown is never completed, retried or replaced by a new child.
      const open = await (await createInfer(undefined, 'parent-2')).resume(unknown(), fixture.peer.ports)
      assert(
        open.children.length === 0 &&
          (open.next.kind === 'wait' ||
            (open.next.kind === 'fail' && open.next.error.code === 'unknown_effect')),
        'unknown-effect-held',
      )
      assert(fixture.peer.deliveries() === 2, 'no-second-send')
      assert(fixture.peer.otherQueries() === 0, 'no-second-credential-use')
    } else {
      const { ref } = await prepared()
      const action = await createInfer()
      await action.close('shutdown')
      assert((await provider.ready(fixture.call)).ok, 'service-survives-action-close')
      const closed = await action.start(inferFrame(fixture, ref), fixture.peer.ports)
      assert(closed.children.length === 0 && closed.next.kind === 'fail', 'closed-action-denied')
      const old = createTestServiceContainer()
      const requirement = {
        contract: 'agh.model',
        major: 1,
        logicalName: fixture.factory.descriptor.logicalName,
        features: [],
        scope: 'runtime' as const,
        optional: false,
      }
      assert(provider.compute, 'compute-present')
      old.register({ requirement, binding: binding(), compute: provider.compute })
      const dependency = old.dependencies.get(requirement)
      assert(dependency.ok, 'selected-dependency')
      const operation = { target: binding(), method: 'prepare', input: fixture.prepareInput }
      await provider.drain(fixture.call.deadline, fixture.call)
      assert(!(await dependency.value.compute(operation, fixture.call)).ok, 'drained-compute-denied')
      await provider.close('shutdown')
      assert(!(await dependency.value.compute(operation, fixture.call)).ok, 'closed-compute-denied')
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      inputDigest: canonicalJsonDigest(fixture.prepareInput),
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}
