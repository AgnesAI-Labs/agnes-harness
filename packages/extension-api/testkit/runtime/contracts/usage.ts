import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type ServiceOperation,
  type ServiceQuery,
  type UsageFact,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface UsageContractFixture {
  factory: ProviderFactory<ServiceProvider>
  config: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  context: CallContext
  record: ServiceOperation
  query: ServiceQuery
  read(reference: DataRef): Promise<unknown>
  /** Read actual original immutable authority facts independently of a provider result cache. */
  facts(): Promise<readonly UsageFact[]>
  deny(): Promise<void>
  cancel(): void
  recover(): Promise<UsageContractFixture>
  finish(): Promise<void>
}
function digest(value: unknown): string {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) throw new Error('Conformance observation is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Usage conformance failed: ${message}`)
}
async function decode<K extends keyof RuntimeWireTypes>(
  f: UsageContractFixture,
  name: K,
  method: 'record' | 'query',
  reference: DataRef,
): Promise<RuntimeWireTypes[K]> {
  const expected = RuntimeMethodSchemaRefs['agh.usage'][method].output
  assert(
    reference.schema.typeId === expected.typeId &&
      reference.schema.revision === expected.revision &&
      reference.schema.digest === expected.digest,
    'official output ref differs',
  )
  const value = await f.read(reference),
    limits = RuntimeAuthorCodecPolicy.payload,
    body = boundedCanonicalJson(value, {
      maxBytes: limits.maxCanonicalJsonBytes,
      maxDepth: limits.maxDepth,
      maxMembers: limits.maxMembers,
    }),
    proof = reference.kind === 'inline' ? reference : reference.blob
  assert(
    body.ok && body.value.bytes === proof.bytes && digest(body.value.json) === proof.digest,
    'output original proof differs',
  )
  const parsed = validateRuntime(name, value)
  assert(parsed.ok, 'output schema invalid')
  return parsed.value
}
export async function runUsageContractScenario(
  scenario: ScenarioName,
  create: () => Promise<UsageContractFixture>,
): Promise<{ providerDigest: string; configDigest: string }> {
  const fixture = await create()
  let current = fixture
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    assert(provider.control && provider.query, 'complete public Usage surface missing')
    if (scenario === 'select') {
      assert(
        digest(
          fixture.factory.descriptor.operations.map((value) => `${value.kind}/${value.method}`).sort(),
        ) === digest(['control/record', 'query/query']),
        'Usage full method descriptor differs',
      )
      assert((await provider.ready(fixture.context)).ok, 'ready failed')
      assert((await provider.health(fixture.context)).ok, 'health failed')
    } else if (scenario === 'normal') {
      const recorded = await provider.control(fixture.record, fixture.context)
      assert(recorded.ok, 'record failed')
      const result = await decode(fixture, 'UsageRecordResult', 'record', recorded.value)
      assert(result.factRefs.length > 0, 'no actual leaf facts')
      const actual = await fixture.facts()
      for (const ref of result.factRefs)
        assert(
          actual.some((fact) => fact.usageId === ref.usageId && digest(fact) === ref.digest),
          'original source lacks returned fact',
        )
      const repeat = await provider.control(fixture.record, fixture.context)
      assert(
        repeat.ok && digest(repeat.value) === digest(recorded.value),
        'repeat record changed refs/revision',
      )
      assert((await fixture.facts()).length === actual.length, 'repeat record charged an extra origin')
      const queried = await provider.query(fixture.query, fixture.context)
      assert(queried.ok && queried.value.kind === 'value', 'query failed')
      const page = await decode(fixture, 'UsageQueryResult', 'query', queried.value.output)
      assert(
        page.snapshot === queried.value.snapshot && page.complete && page.nextCursor === null,
        'complete source query is inconsistent',
      )
      for (const ref of result.factRefs)
        assert(
          page.items.some((fact) => fact.usageId === ref.usageId && digest(fact) === ref.digest),
          'query lost original fact',
        )
    } else if (scenario === 'deny' || scenario === 'cancel') {
      const before = await fixture.facts()
      if (scenario === 'deny') await fixture.deny()
      else fixture.cancel()
      assert(
        !(await provider.control(fixture.record, fixture.context)).ok,
        'denied/canceled record succeeded',
      )
      assert(digest(await fixture.facts()) === digest(before), 'refused request left facts')
    } else if (scenario === 'recover') {
      const first = await provider.control(fixture.record, fixture.context)
      assert(first.ok, 'record before reopen failed')
      const original = await fixture.facts()
      await provider.close('shutdown')
      current = await fixture.recover()
      const cold = await current.factory.create(current.config, current.dependencies, current.factoryContext)
      try {
        assert(cold.control, 'cold control missing')
        const replay = await cold.control(current.record, current.context)
        assert(replay.ok && digest(replay.value) === digest(first.value), 'cold replay changed original refs')
        assert(
          digest(await current.facts()) === digest(original),
          'cold replay lost or duplicated source facts',
        )
      } finally {
        await cold.close('shutdown')
      }
    } else {
      const result = await provider.control(fixture.record, fixture.context)
      assert(result.ok, 'record before disposal failed')
      const original = await fixture.facts()
      assert((await provider.drain(fixture.context.deadline, fixture.context)).ok, 'drain failed')
      await provider.close('shutdown')
      current = await fixture.recover()
      assert(digest(await current.facts()) === digest(original), 'disposal erased source facts')
    }
    const config = fixture.config.kind === 'inline' ? fixture.config : fixture.config.blob
    return { providerDigest: digest(fixture.factory.descriptor), configDigest: config.digest }
  } finally {
    await provider.close('shutdown')
    await current.finish()
  }
}

export interface UsageConformanceBinding {
  providerId: string
  command: string
  build: BuildIdentity
  releaseSetDigest: string
  create(): Promise<UsageContractFixture>
}
export function registerUsageContract(harness: ConformanceHarness, binding: UsageConformanceBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.usage',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const evidence = await runUsageContractScenario(scenario, binding.create)
        return {
          id: `agh.usage/${binding.providerId}/${scenario}`,
          ...evidence,
          recipe: 'original-persistent-authority',
          features: ['record', 'query'],
          build: binding.build,
          consumer: 'usage-public-consumer',
          command: binding.command,
          status: 'passed',
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: null,
          sharedEvidenceId: null,
          reuse: {
            scope: 'session',
            methodKind: 'query/control',
            lifecycle:
              scenario === 'cancel' || scenario === 'recover' || scenario === 'dispose' ? scenario : 'call',
            undeclaredConnection: false,
          },
          perImplementation: true,
          gate: null,
        }
      },
    })
}
