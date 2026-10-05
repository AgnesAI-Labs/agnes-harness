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
  RuntimeMethodSchemaRefs,
  type RuntimeError,
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
  /** An inline, schema-valid prepared request that another binding owns. */
  foreignOwnedPrepared(): DataRef
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
  const ports: LoopReadPorts = {
    prepare(spec) {
      const prepared = validateRuntime('PreparedAction', { ...spec, intentFingerprint: canonicalJsonDigest(spec) })
      return prepared.ok ? { ok: true, value: prepared.value } : failure('invalid_input', 'peer_prepare')
    },
    async query(request) {
      if (request.target.bindingId !== options.state || request.method !== 'probeActionResult')
        return failure('denied', 'peer_method')
      const input =
        request.input.kind === 'inline' ? validateRuntime('ProbeActionResultRequest', request.input.value) : null
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
        outputRef: inline(runtimeAuthorSchemas.StandardToolOutput.ref, { content: [], structured: { text: 'ok' } }),
        finishReason: 'stop',
        usageFactRefs: [...usageIds, ...(dispatchOptions.foreignUsage ? ['usage-foreign'] : [])].map((usageId) => ({
          authorityId: 'usage',
          usageId,
          digest: 'd'.repeat(64),
        })),
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
  }
}

function assert(condition: unknown, id: string): asserts condition {
  if (!condition) throw new Error(`Model contract assertion failed: ${id}`)
}

function inferFrame(fixture: ModelContractFixture, preparedRef: DataRef, over: Partial<ActionFrame> = {}): ActionFrame {
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
  let provider = await fixture.factory.create(fixture.configuration, fixture.dependencies, fixture.factoryContext)
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
    assert(canonicalJsonDigest(result.value.schema) === canonicalJsonDigest(refs.prepare.output), 'prepare-output-schema')
    const parsed = validateRuntime('ModelPrepareResult', result.value.value)
    assert(parsed.ok && parsed.value.preparedRef.kind === 'inline', 'prepare-result')
    return { output: result.value, ref: parsed.value.preparedRef, result: parsed.value }
  }
  const createInfer = async (signal: AbortSignal = new AbortController().signal) => {
    const factory = provider.actions?.infer
    assert(factory, 'infer-present')
    const action = await factory.create({
      instanceId: 'contract-instance',
      actionId: 'parent-1',
      runId: runIdOf(fixture.call),
      bindingId: fixture.factoryContext.bindingId,
      scope: fixture.call.scope,
      signal,
    })
    assert(action.kind === 'composite', 'infer-composite')
    return action
  }
  const startWith = async (ref: DataRef) => (await createInfer()).start(inferFrame(fixture, ref), fixture.peer.ports)
  try {
    assert((await provider.ready(fixture.call)).ok, 'ready')
    if (scenario === 'select') {
      const { descriptor } = fixture.factory
      assert(validateRuntime('ProviderDescriptor', descriptor).ok, 'descriptor')
      assert(descriptor.contract === 'agh.model', 'contract')
      const shape = descriptor.operations.map((operation) => `${operation.method}:${operation.kind}`).sort()
      assert(shape.join() === 'infer:action,prepare:compute,prepareRequest:action', 'exact-operations')
      const byMethod = (method: string) => descriptor.operations.find((operation) => operation.method === method)
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
        provider.actions?.prepareRequest?.kind === 'composite' && provider.actions.infer?.kind === 'composite',
        'composite-kinds',
      )
      const { result } = await prepared()
      assert(result.inputDigest === fixture.recomputeDigest(fixture.prepareInput), 'independent-digest')
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
      const invoke = spec.input.kind === 'inline' ? validateRuntime('ModelAdapterInvokeRequest', spec.input.value) : null
      assert(invoke?.ok && canonicalJsonDigest(invoke.value.preparedCallRef) === canonicalJsonDigest(ref), 'original-ref')
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
      assert(canonicalJsonDigest(done.next.output.schema) === canonicalJsonDigest(refs.infer.output), 'complete-schema')
      const output = validateRuntime('ModelOutput', done.next.output.value)
      assert(output.ok, 'complete-output')
      assert(
        output.value.usageFactRefs.map((usage) => usage.usageId).join() === view.usageRefs.join(),
        'usage-from-child',
      )
      assert(fixture.peer.deliveries() === 1, 'one-delivery')
      assert(!('usage' in done) && !('usageFacts' in done), 'no-parent-usage')
    } else if (scenario === 'deny') {
      const { ref } = await prepared()
      const foreign = await startWith(fixture.foreignOwnedPrepared())
      assert(foreign.children.length === 0 && foreign.next.kind === 'fail', 'foreign-owner-denied')
      await fixture.retarget()
      const moved = await startWith(ref)
      assert(moved.children.length === 0 && moved.next.kind === 'fail', 'target-changed-denied')
      await fixture.revoke()
      assert(!(await prepare()).ok, 'prepare-denied')
      const revoked = await startWith(ref)
      assert(revoked.children.length === 0 && revoked.next.kind === 'fail', 'start-denied')
      assert(fixture.peer.deliveries() === 0, 'nothing-delivered')
    } else if (scenario === 'cancel') {
      const aborted = new AbortController()
      aborted.abort()
      const cancelled = await prepare(fixture.prepareInput, { ...fixture.call, signal: aborted.signal })
      assert(!cancelled.ok && cancelled.error.code === 'cancelled', 'prepare-cancelled')
      const { ref } = await prepared()
      const early = await (await createInfer(aborted.signal)).start(inferFrame(fixture, ref), fixture.peer.ports)
      assert(early.children.length === 0 && early.next.kind === 'fail' && early.next.error.code === 'cancelled', 'start-cancelled')
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
      const first = await prepared()
      const action = await createInfer()
      const frame = inferFrame(fixture, first.ref)
      const started = await action.start(frame, fixture.peer.ports)
      const spec = started.children[0]
      assert(spec, 'child-present')
      const committed = fixture.peer.commit(frame.actionId, spec)
      assert(committed.ok, 'commit')
      await fixture.peer.dispatch(committed.value, 'succeeded')
      fixture.peer.publish(committed.value, 'receipt-1')
      await action.close('shutdown')
      await provider.close('shutdown')
      fixture = await fixture.restart()
      provider = await fixture.factory.create(fixture.configuration, fixture.dependencies, fixture.factoryContext)
      assert((await provider.ready(fixture.call)).ok, 'reopened-ready')
      const second = await prepared()
      assert(canonicalJsonDigest(second.output) === canonicalJsonDigest(first.output), 'replay-same-ref')
      const reopened = await createInfer()
      const done = await reopened.resume(
        {
          ...inferFrame(fixture, second.ref),
          providerRevision: 1,
          continuation: started.continuation,
          receipts: {
            items: [{ actionId: committed.value.actionId, receiptId: 'receipt-1', outcome: 'succeeded' }],
            snapshot: 'published',
            nextCursor: null,
            complete: true,
          },
        },
        fixture.peer.ports,
      )
      assert(done.children.length === 0 && done.next.kind === 'complete', 'cold-complete')
      assert(fixture.peer.deliveries() === 1, 'cold-no-resend')
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
