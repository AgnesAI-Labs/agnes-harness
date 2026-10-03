import type {
  CallContext,
  DataRef,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  canonicalJsonDigest,
  type RoutingSelectInput,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import type { ScenarioName } from '../evidence.js'
import { createTestServiceContainer } from '../harness.js'

export interface RoutingContractFixture {
  factory: ProviderFactory<ServiceProvider>
  configuration: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  call: CallContext
  input: DataRef
  revoke(): Promise<void>
  restart(): Promise<RoutingContractFixture>
  close(): Promise<void>
}
function assert(condition: unknown, id: string): asserts condition {
  if (!condition) throw new Error(`Routing contract assertion failed: ${id}`)
}
/** Every scenario exercises an actually selected BoundService and immutable candidate provenance. */
export async function runRoutingContractScenario(
  scenario: ScenarioName,
  open: () => Promise<RoutingContractFixture>,
) {
  let fixture = await open()
  let provider = await fixture.factory.create(
    fixture.configuration,
    fixture.dependencies,
    fixture.factoryContext,
  )
  const selected = () => {
    const container = createTestServiceContainer()
    const requirement = {
      contract: 'agh.routing',
      major: 1,
      logicalName: fixture.factory.descriptor.logicalName,
      features: [],
      scope: 'workspace' as const,
      optional: false,
    }
    const binding = {
      bindingId: fixture.factoryContext.bindingId,
      contract: requirement.contract,
      logicalName: requirement.logicalName,
      providerId: fixture.factory.descriptor.providerId,
    }
    assert(provider.compute, 'compute-present')
    container.register({ requirement, binding, compute: provider.compute })
    const dependency = container.dependencies.get(requirement)
    assert(dependency.ok, 'selected-dependency')
    return {
      service: dependency.value,
      operation: { target: binding, method: 'select', input: fixture.input },
    }
  }
  const compute = async (call = fixture.call) => {
    const bound = selected()
    return bound.service.compute(bound.operation, call)
  }
  const checked = async () => {
    const result = await compute()
    assert(result.ok && result.value.kind === 'inline', 'select-inline')
    assert(
      canonicalJsonDigest(result.value.schema) ===
        canonicalJsonDigest(RuntimeMethodSchemaRefs['agh.routing'].select.output),
      'output-schema',
    )
    assert(result.value.digest === canonicalJsonDigest(result.value.value), 'output-digest')
    const parsed = validateRuntime('RoutingSelectResult', result.value.value)
    assert(parsed.ok && fixture.input.kind === 'inline', 'select-result')
    const input = validateRuntime('RoutingSelectInput', fixture.input.value)
    assert(input.ok, 'input-schema')
    const original: RoutingSelectInput = input.value
    assert(
      original.allowedRoutes.some(
        (route) => canonicalJsonDigest(route) === canonicalJsonDigest(parsed.value.route),
      ),
      'original-candidate',
    )
    assert(parsed.value.route.catalogRevision === original.catalogRevision, 'original-catalog')
    return result.value
  }
  try {
    assert((await provider.ready(fixture.call)).ok, 'ready')
    if (scenario === 'select') {
      assert(validateRuntime('ProviderDescriptor', fixture.factory.descriptor).ok, 'descriptor')
      assert(fixture.factory.descriptor.contract === 'agh.routing', 'contract')
      assert(
        fixture.factory.descriptor.operations.length === 1 &&
          fixture.factory.descriptor.operations[0]?.kind === 'compute' &&
          fixture.factory.descriptor.operations[0]?.method === 'select',
        'exact-operation',
      )
      await checked()
    } else if (scenario === 'normal') {
      await checked()
    } else if (scenario === 'deny') {
      await fixture.revoke()
      assert(!(await compute()).ok, 'revoked-selection-denied')
    } else if (scenario === 'cancel') {
      const signal = new AbortController()
      signal.abort()
      assert(!(await compute({ ...fixture.call, signal: signal.signal })).ok, 'cancelled-selection-denied')
    } else if (scenario === 'recover') {
      const original = await checked()
      await provider.close('shutdown')
      fixture = await fixture.restart()
      provider = await fixture.factory.create(
        fixture.configuration,
        fixture.dependencies,
        fixture.factoryContext,
      )
      assert((await provider.ready(fixture.call)).ok, 'reopened-ready')
      assert(
        canonicalJsonDigest(original) === canonicalJsonDigest(await checked()),
        'pinned-candidate-after-restart',
      )
    } else {
      const old = selected()
      await provider.drain(fixture.call.deadline, fixture.call)
      assert(!(await old.service.compute(old.operation, fixture.call)).ok, 'drained-old-reference-denied')
      await provider.close('shutdown')
      assert(!(await old.service.compute(old.operation, fixture.call)).ok, 'closed-old-reference-denied')
    }
    return {
      providerDigest: fixture.factory.descriptor.packageDigest,
      configDigest:
        fixture.configuration.kind === 'inline'
          ? fixture.configuration.digest
          : fixture.configuration.blob.digest,
      inputDigest: canonicalJsonDigest(fixture.input),
    }
  } finally {
    await provider.close('shutdown')
    await fixture.close()
  }
}
