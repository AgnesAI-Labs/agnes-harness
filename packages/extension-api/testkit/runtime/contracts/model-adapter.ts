import type {
  ActionContext,
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type ActionFrame,
  canonicalJsonDigest,
  type DataRef,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'

export interface ModelAdapterContractFixture {
  factory: ProviderFactory<ServiceProvider>
  configuration: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  call: CallContext
  frame: ActionFrame
  actionContext(call: CallContext): ActionContext
  revoke(): Promise<void>
  restart(): Promise<ModelAdapterContractFixture>
  deliveries(): number
  close(): Promise<void>
}
function assert(condition: unknown, id: string): asserts condition {
  if (!condition) throw new Error(`Model adapter contract assertion failed: ${id}`)
}
/** Actual managed invoke/reconcile surface; a driver cannot supply its own pass verdict. */
export async function runModelAdapterContractScenario(
  scenario: ScenarioName,
  open: () => Promise<ModelAdapterContractFixture>,
) {
  let fixture = await open()
  let provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const leaf = async () => {
    const action = await provider.actions?.invoke?.create({
      instanceId: fixture.factoryContext.instanceId,
      actionId: fixture.frame.actionId,
      runId: fixture.frame.runId,
      bindingId: fixture.factoryContext.bindingId,
      scope: fixture.call.scope,
      signal: fixture.call.signal,
    })
    assert(action?.kind === 'leaf', 'managed-invoke')
    assert((await action.ready(fixture.call)).ok, 'leaf-ready')
    return action
  }
  try {
    assert((await provider.ready(fixture.call)).ok, 'ready')
    assert(validateRuntime('ProviderDescriptor', fixture.factory.descriptor).ok, 'descriptor')
    assert(fixture.factory.descriptor.contract === 'agh.model-adapter', 'contract')
    const action = await leaf()
    try {
      if (scenario === 'select') {
        assert(action.executionUnit === 'single-effect', 'single-effect')
        assert(action.effectSemantics === 'non-idempotent', 'effect-semantics')
        assert(
          fixture.factory.descriptor.operations.length === 2 &&
            fixture.factory.descriptor.operations.every(
              (op) => op.kind === 'action' && op.retrySafety === 'never',
            ),
          'exact-actions-no-retry',
        )
      } else if (scenario === 'normal' || scenario === 'recover') {
        const result = await action.execute(fixture.frame, fixture.actionContext(fixture.call))
        assert(
          result.outcome === 'succeeded' && validateRuntime('EffectResult', result).ok,
          'actual-invoke-success',
        )
        assert(result.result?.kind === 'inline', 'output-inline')
        assert(
          canonicalJsonDigest(result.result.schema) ===
            canonicalJsonDigest(RuntimeMethodSchemaRefs['agh.model-adapter'].invoke.output),
          'output-schema',
        )
        assert(
          result.result.digest === canonicalJsonDigest(result.result.value) &&
            validateRuntime('ModelOutput', result.result.value).ok,
          'output-content',
        )
        assert(fixture.deliveries() === 1, 'exact-one-delivery')
        if (scenario === 'recover') {
          await action.close('shutdown')
          await provider.close('shutdown')
          fixture = await fixture.restart()
          provider = await fixture.factory.create(
            fixture.configuration,
            fixture.dependencies,
            fixture.factoryContext,
          )
          assert((await provider.ready(fixture.call)).ok, 'reopened-ready')
          const reopened = await leaf()
          try {
            const recovered = await reopened.reconcile(fixture.frame, [], fixture.actionContext(fixture.call))
            assert(
              recovered.kind === 'resolved' &&
                canonicalJsonDigest(recovered.result) === canonicalJsonDigest(result),
              'cold-original-result',
            )
            assert(fixture.deliveries() === 1, 'cold-no-resend')
          } finally {
            await reopened.close('completed')
          }
        }
      } else if (scenario === 'deny') {
        await fixture.revoke()
        const result = await action.execute(fixture.frame, fixture.actionContext(fixture.call))
        assert(result.outcome === 'failed' && result.error?.code === 'denied', 'current-denied')
        assert(fixture.deliveries() === 0, 'denied-no-send')
      } else if (scenario === 'cancel') {
        const controller = new AbortController()
        controller.abort()
        const result = await action.execute(
          fixture.frame,
          fixture.actionContext({ ...fixture.call, signal: controller.signal }),
        )
        assert(result.outcome !== 'succeeded' && result.externalRequests.length === 0, 'cancel-no-effect')
        assert(fixture.deliveries() === 0, 'cancel-no-send')
      } else {
        await provider.drain(fixture.call.deadline, fixture.call)
        assert(
          (await action.execute(fixture.frame, fixture.actionContext(fixture.call))).outcome === 'failed',
          'drained-old-reference',
        )
        await provider.close('shutdown')
        assert(
          (await action.execute(fixture.frame, fixture.actionContext(fixture.call))).outcome === 'failed',
          'closed-old-reference',
        )
        assert(fixture.deliveries() === 0, 'disposed-no-send')
      }
    } finally {
      await action.close('completed')
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      inputDigest: canonicalJsonDigest(fixture.frame.input),
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}
