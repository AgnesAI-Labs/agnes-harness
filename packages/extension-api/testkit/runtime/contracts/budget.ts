import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  type BudgetReservation,
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type DomainObjectRef,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type ServiceOperation,
  type ServiceQuery,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface BudgetContractFixture {
  factory: ProviderFactory<ServiceProvider>
  config: DataRef
  dependencies: ScopedDependencies
  factoryContext: FactoryContext
  context: CallContext
  reserve: ServiceOperation
  quota: ServiceOperation
  readBudget: ServiceQuery
  read(reference: DataRef): Promise<unknown>
  /** Arrange genuine original Usage source and pinned quote, then return its exact public request. */
  settle(reservation: BudgetReservation): Promise<ServiceOperation>
  /** Arrange actual not-executed evidence for the original reservation. */
  reconcile(reservation: BudgetReservation): Promise<ServiceOperation>
  /** Arrange completion/transfer evidence for the actual held quota. */
  release(reference: DomainObjectRef): Promise<ServiceOperation>
  /** Independent observer reads the actual durable authority, not the provider's cached return value. */
  reservations(): Promise<readonly BudgetReservation[]>
  deny(): Promise<void>
  cancel(): void
  recover(): Promise<BudgetContractFixture>
  finish(): Promise<void>
}
function digest(value: unknown): string {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) throw new Error('Conformance observation is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Budget conformance failed: ${message}`)
}
async function decode<K extends keyof RuntimeWireTypes>(
  fixture: BudgetContractFixture,
  name: K,
  method: keyof (typeof RuntimeMethodSchemaRefs)['agh.budget'],
  reference: DataRef,
): Promise<RuntimeWireTypes[K]> {
  const official = RuntimeMethodSchemaRefs['agh.budget'][method].output
  assert(
    reference.schema.typeId === official.typeId &&
      reference.schema.revision === official.revision &&
      reference.schema.digest === official.digest,
    'output schema identity differs',
  )
  const value = await fixture.read(reference),
    limits = RuntimeAuthorCodecPolicy.payload
  const body = boundedCanonicalJson(value, {
      maxBytes: limits.maxCanonicalJsonBytes,
      maxDepth: limits.maxDepth,
      maxMembers: limits.maxMembers,
    }),
    proof = reference.kind === 'inline' ? reference : reference.blob
  assert(
    body.ok && body.value.bytes === proof.bytes && digest(body.value.json) === proof.digest,
    'output byte/digest proof differs',
  )
  const parsed = validateRuntime(name, value)
  assert(parsed.ok, 'output does not satisfy official schema')
  return parsed.value
}
/** Six real public/lifecycle scenarios; each fixture must reopen its actual persistent source. */
export async function runBudgetContractScenario(
  scenario: ScenarioName,
  create: () => Promise<BudgetContractFixture>,
): Promise<{ providerDigest: string; configDigest: string }> {
  const fixture = await create()
  let current = fixture
  const provider = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    assert(provider.control && provider.query, 'complete public Budget control/query methods missing')
    if (scenario === 'select') {
      const methods = fixture.factory.descriptor.operations
        .map((entry) => `${entry.kind}/${entry.method}`)
        .sort()
      assert(
        digest(methods) ===
          digest(
            [
              'control/reconcile',
              'control/releaseQuota',
              'control/reserve',
              'control/reserveQuota',
              'control/settle',
              'query/readSessionBudget',
            ].sort(),
          ),
        'complete six-method descriptor differs',
      )
      assert((await provider.ready(fixture.context)).ok, 'ready failed')
      assert((await provider.health(fixture.context)).ok, 'health failed')
    } else if (scenario === 'normal') {
      const held = await provider.control(fixture.reserve, fixture.context)
      assert(held.ok, 'reserve failed')
      const reserve = await decode(fixture, 'BudgetReserveResult', 'reserve', held.value)
      assert(reserve.reservation.status === 'held', 'reserve did not hold')
      const rows = await fixture.reservations()
      assert(
        rows.some((row) => digest(row) === digest(reserve.reservation)),
        'held obligation is not durable',
      )
      const again = await provider.control(fixture.reserve, fixture.context)
      assert(
        again.ok && digest(again.value) === digest(held.value),
        'repeat reserve changes the original result',
      )
      const settlement = await provider.control(await fixture.settle(reserve.reservation), fixture.context)
      assert(settlement.ok, 'settle failed')
      const settled = await decode(fixture, 'BudgetSettleResult', 'settle', settlement.value)
      assert(settled.reservation.status === 'settled', 'settlement not committed')
      const quota = await provider.control(fixture.quota, fixture.context)
      assert(quota.ok, 'quota reserve failed')
      const occupied = await decode(fixture, 'QuotaReservation', 'reserveQuota', quota.value)
      assert(occupied.status === 'held', 'quota not held')
      const released = await provider.control(await fixture.release(occupied.ref), fixture.context)
      assert(released.ok, 'quota release failed')
      assert(
        (await decode(fixture, 'QuotaReservation', 'releaseQuota', released.value)).status === 'released',
        'quota not released',
      )
      const budget = await provider.query(fixture.readBudget, fixture.context)
      assert(budget.ok && budget.value.kind === 'value', 'authorized budget read failed')
      await decode(fixture, 'SessionBudgetResult', 'readSessionBudget', budget.value.output)
    } else if (scenario === 'deny' || scenario === 'cancel') {
      const before = await fixture.reservations()
      if (scenario === 'deny') await fixture.deny()
      else fixture.cancel()
      assert(
        !(await provider.control(fixture.reserve, fixture.context)).ok,
        'denied/canceled reserve succeeded',
      )
      assert(
        digest(await fixture.reservations()) === digest(before),
        'denied/canceled request left an obligation',
      )
    } else if (scenario === 'recover') {
      const first = await provider.control(fixture.reserve, fixture.context)
      assert(first.ok, 'reserve before recovery failed')
      const held = await decode(fixture, 'BudgetReserveResult', 'reserve', first.value)
      await provider.close('shutdown')
      current = await fixture.recover()
      const cold = await current.factory.create(current.config, current.dependencies, current.factoryContext)
      try {
        assert(cold.control, 'cold control missing')
        const replay = await cold.control(current.reserve, current.context)
        assert(replay.ok && digest(replay.value) === digest(first.value), 'cold retry changed result')
        assert(
          (await current.reservations()).some((row) => row.ref.id === held.reservation.ref.id),
          'cold authority lost the hold',
        )
        const reconciled = await cold.control(await current.reconcile(held.reservation), current.context)
        assert(reconciled.ok, 'confirmed-not-executed reconciliation failed')
        assert(
          (await decode(current, 'BudgetReconcileResult', 'reconcile', reconciled.value)).reservation
            .status === 'released',
          'confirmed not-executed did not release',
        )
      } finally {
        await cold.close('shutdown')
      }
    } else {
      const held = await provider.control(fixture.reserve, fixture.context)
      assert(held.ok, 'reserve before disposal failed')
      const value = await decode(fixture, 'BudgetReserveResult', 'reserve', held.value)
      assert((await provider.drain(fixture.context.deadline, fixture.context)).ok, 'drain failed')
      await provider.close('shutdown')
      current = await fixture.recover()
      assert(
        (await current.reservations()).some(
          (row) => row.ref.id === value.reservation.ref.id && row.status === 'held',
        ),
        'disposal erased durable held work',
      )
    }
    const config = fixture.config.kind === 'inline' ? fixture.config : fixture.config.blob
    return { providerDigest: digest(fixture.factory.descriptor), configDigest: config.digest }
  } finally {
    await provider.close('shutdown')
    await current.finish()
  }
}

export interface BudgetConformanceBinding {
  providerId: string
  command: string
  build: BuildIdentity
  releaseSetDigest: string
  create(): Promise<BudgetContractFixture>
}
export function registerBudgetContract(harness: ConformanceHarness, binding: BudgetConformanceBinding): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.budget',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const evidence = await runBudgetContractScenario(scenario, binding.create)
        return {
          id: `agh.budget/${binding.providerId}/${scenario}`,
          ...evidence,
          recipe: 'original-persistent-authority',
          features: ['reserve', 'settle', 'reconcile', 'reserveQuota', 'releaseQuota', 'readSessionBudget'],
          build: binding.build,
          consumer: 'budget-public-consumer',
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
