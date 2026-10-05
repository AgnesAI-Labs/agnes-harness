import {
  canonicalJsonDigest,
  type DataRef,
  type EffectsDispatchResult,
  type ServiceOperation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '../../../src/runtime/index.js'
import type { ScenarioName } from '../evidence.js'

export interface EffectsContractFixture {
  factory: ProviderFactory<ServiceProvider>
  config: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  context: CallContext
  dispatch: ServiceOperation
  physicalRequests(): number
  revoke(): void
  cancel(): void
  /** Reconstruct from the same actual durable owner, not a passed flag or a canned response. */
  reopen(): Promise<EffectsContractFixture>
  close(): Promise<void>
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function output(ref: DataRef): EffectsDispatchResult {
  assert(ref.kind === 'inline', 'Effects result must be decoded by its genuine owner')
  assert(ref.digest === canonicalJsonDigest(ref.value), 'Effects result digest changed')
  const result = validateRuntime('EffectsDispatchResult', ref.value)
  assert(result.ok, 'Effects result schema rejected')
  return result.value as EffectsDispatchResult
}
/** The driver executes public methods; a fixture cannot supply its own success assertion. */
export async function runEffectsContractScenario(
  scenario: ScenarioName,
  create: () => Promise<EffectsContractFixture>,
) {
  const fixture = await create()
  let recovered: EffectsContractFixture | undefined
  try {
    const provider = await fixture.factory.create(
      fixture.config,
      fixture.dependencies,
      fixture.factoryContext,
    )
    assert(provider.control, 'Effects Host control missing')
    assert((await provider.ready(fixture.context)).ok, 'Effects owner not ready')
    if (scenario === 'select') {
      assert(fixture.factory.descriptor.contract === 'agh.effects', 'Wrong contract')
      for (const method of ['dispatch', 'reconcile', 'runHooks'])
        assert(
          fixture.factory.descriptor.operations.some(
            (operation) =>
              operation.method === method &&
              operation.kind === (method === 'runHooks' ? 'action' : 'control'),
          ),
          'Missing Effects control',
        )
      assert(
        !(await provider.control({ ...fixture.dispatch, method: 'unregistered' }, fixture.context)).ok,
        'Unknown method accepted',
      )
      assert(fixture.physicalRequests() === 0, 'Selection caused physical effect')
    } else if (scenario === 'normal') {
      const result = await provider.control(fixture.dispatch, fixture.context)
      assert(result.ok, 'Dispatch rejected')
      assert(output(result.value).status === 'settled', 'Effect not durably settled')
      assert(fixture.physicalRequests() === 1, 'Primitive effect not exactly one request')
    } else if (scenario === 'deny' || scenario === 'cancel') {
      if (scenario === 'deny') fixture.revoke()
      else fixture.cancel()
      assert(!(await provider.control(fixture.dispatch, fixture.context)).ok, 'Closed authorization accepted')
      assert(fixture.physicalRequests() === 0, 'Closed authorization physically sent')
    } else if (scenario === 'recover') {
      const first = await provider.control(fixture.dispatch, fixture.context)
      assert(first.ok, 'Initial effect rejected')
      const prior = output(first.value)
      assert(prior.status === 'settled' && prior.receiptRef, 'Original durable receipt missing')
      await fixture.close()
      recovered = await fixture.reopen()
      const restarted = await recovered.factory.create(
        recovered.config,
        recovered.dependencies,
        recovered.factoryContext,
      )
      assert(restarted.control, 'Recovered control missing')
      assert((await restarted.ready(recovered.context)).ok, 'Recovered owner refused')
      const replay = await restarted.control(recovered.dispatch, recovered.context)
      assert(replay.ok, 'Cold receipt rejected')
      assert(
        canonicalJsonDigest(output(replay.value)) === canonicalJsonDigest(prior),
        'Original receipt changed',
      )
      assert(recovered.physicalRequests() === 0, 'Completed attempt resent')
    } else if (scenario === 'dispose') {
      await provider.close('shutdown')
      assert(
        !(await provider.control(fixture.dispatch, fixture.context)).ok,
        'Old reference remained callable',
      )
      assert(fixture.physicalRequests() === 0, 'Disposed source physically sent')
    } else throw Error('Unsupported Effects scenario')
  } finally {
    await recovered?.close()
    await fixture.close()
  }
}
