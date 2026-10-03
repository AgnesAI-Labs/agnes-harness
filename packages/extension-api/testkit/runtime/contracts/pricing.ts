import type {
  CallContext,
  FactoryContext,
  ProviderFactory,
  ScopedDependencies,
  ServiceProvider,
} from '@agnes/extension-api/runtime'
import { pricingInputSchema, pricingQuoteSchema } from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type DataRef,
  type Money,
  type PriceQuote,
  RuntimeAuthorCodecPolicy,
  RuntimeMethodSchemaRefs,
  type ServiceOperation,
} from '@agnes/protocol/runtime'
import { type BuildIdentity, SCENARIOS, type ScenarioName } from '../evidence.js'
import type { ConformanceHarness } from '../harness.js'

export interface PricingCatalogObservation {
  readonly priceVersion: string
  readonly model: string
  readonly region: string | null
  readonly unit: string
  readonly ruleId: string
  readonly unitPrice: Money
}
export interface PricingRecoveryObservation {
  readonly originalPid: number
  readonly freshPid: number
  readonly originalExitSignal: 'SIGKILL'
  readonly input: DataRef
  readonly output: DataRef
  readonly catalogDigest: string
}
export interface PricingContractFixture {
  readonly factory: ProviderFactory<ServiceProvider>
  readonly config: DataRef
  readonly dependencies: ScopedDependencies
  readonly factoryContext: FactoryContext
  readonly context: CallContext
  readonly request: ServiceOperation
  /** Read actual original source rows, independent of the provider's returned quote. */
  prices(): readonly PricingCatalogObservation[]
  deny(): void
  cancel(): void
  /** Absent means recover cannot pass; same-process reopening is not recovery evidence. */
  recover?(): Promise<PricingRecoveryObservation>
  finish(): Promise<void>
}
function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(`Pricing conformance failed: ${message}`)
}
function digest(value: unknown): string {
  const limits = RuntimeAuthorCodecPolicy.payload
  const safe = boundedCanonicalJson(value, {
    maxBytes: limits.maxCanonicalJsonBytes,
    maxDepth: limits.maxDepth,
    maxMembers: limits.maxMembers,
  })
  requireFact(safe.ok, 'unsafe source JSON')
  return canonicalJsonDigest(safe.value.json)
}
function body(reference: DataRef, schema: DataRef['schema']) {
  requireFact(
    reference.kind === 'inline' && digest(reference.schema) === digest(schema),
    'official full reference',
  )
  const limits = RuntimeAuthorCodecPolicy.payload,
    safe = boundedCanonicalJson(reference.value, {
      maxBytes: limits.maxCanonicalJsonBytes,
      maxDepth: limits.maxDepth,
      maxMembers: limits.maxMembers,
    })
  requireFact(
    safe.ok && safe.value.bytes === reference.bytes && digest(safe.value.json) === reference.digest,
    'original content proof',
  )
  return safe.value.json
}
function exactAmount(quantity: string, units: string): string {
  requireFact(
    /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(quantity) && /^(0|[1-9][0-9]*)$/.test(units),
    'exact quantity',
  )
  const pieces = quantity.split('.'),
    divisor = 10n ** BigInt(pieces[1]?.length ?? 0)
  const product = BigInt(pieces.join('')) * BigInt(units),
    lower = product / divisor,
    remainder = product % divisor
  return (
    lower + (remainder * 2n > divisor || (remainder * 2n === divisor && lower % 2n !== 0n) ? 1n : 0n)
  ).toString()
}
function verifyQuote(f: PricingContractFixture, reference: DataRef): PriceQuote {
  const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote
  const decoded = pricingInputSchema.parse(body(f.request.input, refs.input))
  requireFact(decoded.ok, 'official fixed input')
  const parsed = pricingQuoteSchema.parse(body(reference, refs.output))
  requireFact(parsed.ok, 'official quote')
  const input = decoded.value,
    quote = parsed.value,
    catalog = f.prices()
  requireFact(
    quote.inputDigest === digest(input) &&
      quote.priceVersion === input.priceVersion &&
      quote.rounding === 'half-even' &&
      quote.amount.currency === input.currency &&
      quote.lineItems.length === input.usageUnits.length,
    'fixed selection and input association',
  )
  let total = 0n
  for (const [index, line] of quote.lineItems.entries()) {
    const quantity = input.usageUnits[index]
    requireFact(quantity && line.unit === quantity.unit && line.quantity === quantity.value, 'original units')
    const rules = catalog.filter(
      (rule) =>
        rule.priceVersion === input.priceVersion &&
        rule.model === input.model &&
        rule.region === input.region &&
        rule.unit === quantity.unit &&
        rule.unitPrice.currency === input.currency,
    )
    requireFact(rules.length === 1, 'unique native catalog price')
    const rule = rules[0]
    requireFact(
      rule &&
        line.ruleId === rule.ruleId &&
        digest(line.unitPrice) === digest(rule.unitPrice) &&
        line.amount.currency === input.currency &&
        line.amount.units === exactAmount(quantity.value, rule.unitPrice.units),
      'native price and half-even amount',
    )
    total += BigInt(line.amount.units)
  }
  requireFact(quote.amount.units === total.toString(), 'exact aggregate money')
  return quote
}
export async function runPricingContractScenario(
  scenario: ScenarioName,
  create: () => Promise<PricingContractFixture>,
) {
  const fixture = await create(),
    service = await fixture.factory.create(fixture.config, fixture.dependencies, fixture.factoryContext)
  try {
    requireFact(
      service.compute && fixture.factory.descriptor.contract === 'agh.pricing',
      'full pricing surface',
    )
    const compute = service.compute.bind(service)
    requireFact((await service.ready(fixture.context)).ok, 'ready')
    const quote = async () => {
      const result = await compute(fixture.request, fixture.context)
      requireFact(result.ok, 'quote accepted')
      return { ref: result.value, quote: verifyQuote(fixture, result.value) }
    }
    if (scenario === 'select') {
      requireFact(
        fixture.factory.descriptor.operations.length === 1 &&
          fixture.factory.descriptor.operations[0]?.method === 'quote' &&
          fixture.factory.descriptor.operations[0]?.kind === 'compute',
        'exact descriptor table',
      )
      requireFact((await service.health(fixture.context)).ok, 'health')
      await quote()
    } else if (scenario === 'normal') {
      const original = await quote(),
        replay = await quote()
      requireFact(digest(original.ref) === digest(replay.ref), 'same fixed request stable quote')
    } else if (scenario === 'deny') {
      fixture.deny()
      requireFact(!(await compute(fixture.request, fixture.context)).ok, 'actual source revocation refused')
    } else if (scenario === 'cancel') {
      fixture.cancel()
      requireFact(!(await compute(fixture.request, fixture.context)).ok, 'original call cancellation refused')
    } else if (scenario === 'dispose') {
      const native = digest(fixture.prices()),
        drained = await service.drain(fixture.context.deadline, fixture.context)
      requireFact(
        drained.ok &&
          drained.value.state === 'drained' &&
          drained.value.activeInvocationIds.length === 0 &&
          drained.value.durableOwnerRefs.length === 0,
        'actual drained',
      )
      requireFact(!(await compute(fixture.request, fixture.context)).ok, 'no admission after drain')
      await service.close('shutdown')
      requireFact(
        !(await compute(fixture.request, fixture.context)).ok && digest(fixture.prices()) === native,
        'close and retained source',
      )
    } else {
      const original = await quote()
      requireFact(fixture.recover, 'real process recovery consumer is missing')
      const recovered = await fixture.recover()
      requireFact(
        Number.isSafeInteger(recovered.originalPid) &&
          recovered.originalPid > 0 &&
          Number.isSafeInteger(recovered.freshPid) &&
          recovered.freshPid > 0 &&
          recovered.freshPid !== recovered.originalPid &&
          recovered.originalExitSignal === 'SIGKILL',
        'fresh process after physical kill',
      )
      requireFact(
        digest(recovered.input) === digest(fixture.request.input) &&
          recovered.catalogDigest === digest(fixture.prices()),
        'original request/catalog retained',
      )
      verifyQuote(fixture, recovered.output)
      requireFact(digest(recovered.output) === digest(original.ref), 'fixed quote survives process recovery')
    }
    return {
      providerDigest: digest(fixture.factory.descriptor),
      configDigest: fixture.config.kind === 'inline' ? fixture.config.digest : fixture.config.blob.digest,
    }
  } finally {
    await service.close('shutdown')
    await fixture.finish()
  }
}
export interface PricingConformanceBinding {
  readonly providerId: string
  readonly command: string
  readonly build: BuildIdentity
  readonly releaseSetDigest: string
  create(): Promise<PricingContractFixture>
}
export function registerPricingContract(
  harness: ConformanceHarness,
  binding: PricingConformanceBinding,
): void {
  for (const scenario of SCENARIOS)
    harness.registerCase({
      contract: 'agh.pricing',
      scenario,
      qualification: 'required',
      providerId: binding.providerId,
      async run() {
        const result = await runPricingContractScenario(scenario, binding.create)
        return {
          id: `agh.pricing/${binding.providerId}/${scenario}`,
          ...result,
          recipe: 'selected-native-fixed-pricing',
          features: [],
          build: binding.build,
          consumer: 'pricing-public-consumer',
          command: binding.command,
          status: 'passed',
          releaseSetDigest: binding.releaseSetDigest,
          attachmentDigest: null,
          fixture: 'test-service-container',
          sharedEvidenceId: null,
          reuse: {
            scope: 'workspace',
            methodKind: 'compute',
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
