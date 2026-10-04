import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PricingProviderOwner } from '@agnes/ai/runtime'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  pricingInputSchema,
  pricingQuoteSchema,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import type { BillingPricingPorts } from '../../src/runtime/billing/accounting.js'
import { read, refused } from '../../src/runtime/trace/provider-support.js'

const codec = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: 'synthetic.pricing',
  name: 'Config',
  typeId: 'synthetic.pricing/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Config',
    $defs: { Config: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})
/** Restricted native catalog owner, not a production installation or a C14 credential issuer. */
export async function createBillingPricingFixture(directory: string, scope: W.ScopeRef, rate = '100') {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'pricing.sqlite'),
    fresh = !existsSync(path)
  const db = new DatabaseSync(path)
  if (fresh) {
    db.exec(
      'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE selection(id INTEGER PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE catalog(id INTEGER PRIMARY KEY,body TEXT NOT NULL)',
    )
    const selection: W.PricingQuoteInput = {
      model: 'synthetic-model',
      region: null,
      currency: 'USD',
      priceVersion: 'synthetic-price-v1',
      usageUnits: [],
    }
    db.prepare('INSERT INTO selection VALUES(1,?)').run(JSON.stringify(selection))
    db.prepare('INSERT INTO catalog VALUES(1,?)').run(
      JSON.stringify([
        {
          priceVersion: selection.priceVersion,
          model: selection.model,
          region: selection.region,
          unit: 'request',
          ruleId: 'synthetic-rule',
          unitPrice: { currency: selection.currency, scale: 6, units: rate },
        },
        {
          priceVersion: 'synthetic-price-v2',
          model: selection.model,
          region: selection.region,
          unit: 'request',
          ruleId: 'replacement-rule',
          unitPrice: { currency: selection.currency, scale: 6, units: '999' },
        },
      ]),
    )
  }
  const selection = JSON.parse(
    String(db.prepare('SELECT body FROM selection WHERE id=1').get()?.body),
  ) as W.PricingQuoteInput
  type Catalog = Awaited<ReturnType<PricingProviderOwner<Record<string, never>>['catalog']>>['catalog']
  const body = String(db.prepare('SELECT body FROM catalog WHERE id=1').get()?.body)
  const catalog = JSON.parse(body) as Catalog
  const issued = new WeakSet<CallContext>(),
    bindingId = 'synthetic-pricing-binding'
  const fixed = () => {
    if (
      String(db.prepare('SELECT body FROM catalog WHERE id=1').get()?.body) !== body ||
      canonicalJsonDigest(
        JSON.parse(String(db.prepare('SELECT body FROM selection WHERE id=1').get()?.body)),
      ) !== canonicalJsonDigest(selection)
    )
      throw new Error('Original pricing source changed')
  }
  const current = () => {
    fixed()
    if (existsSync(join(directory, 'retired-price'))) throw new Error('Pricing source retired')
  }
  const owner: PricingProviderOwner<Record<string, never>> = {
    catalog: () => ({
      catalog,
      until: Date.parse('2099-01-01T00:00:00.000Z'),
      dynamicCheck: current,
      staticCheck: current,
    }),
    captureCurrent(call) {
      if (
        !issued.has(call) ||
        call.authorizationRef !== 'synthetic-auth' ||
        call.principalRef !== 'synthetic-principal'
      )
        throw new Error('Unissued pricing call')
      return { until: Date.parse(call.deadline), dynamicCheck: current, staticCheck: current }
    },
    now: () => Date.now(),
  }
  const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote
  const encodedCatalog = validateRuntime('JsonValue', catalog)
  if (!encodedCatalog.ok) throw new Error('Catalog is not JSON')
  const descriptor: W.ProviderDescriptor = {
    providerId: rate === '100' ? 'synthetic.catalog' : 'synthetic.replacement-catalog',
    contract: 'agh.pricing',
    major: 1,
    logicalName: 'pricing',
    packageVersion: '1.0.0',
    packageDigest: canonicalJsonDigest({ catalog: encodedCatalog.value }),
    features: [],
    scope: 'workspace',
    configSchema: codec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: [
      {
        method: 'quote',
        kind: 'compute',
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: 'read-only',
      },
    ],
  }
  const { createPricingProviderFactory } = await import('@agnes/ai/runtime')
  const { createReferencePricingFactory } = await import(
    '../../../../examples/runtime-reference/src/index.js'
  )
  const selectedFactory = rate === '100' ? createPricingProviderFactory : createReferencePricingFactory
  const factory = selectedFactory({ descriptor, configurationSchema: codec, owner })
  const config = codec.encode({})
  if (!config.ok) throw new Error('Pricing config')
  const dependencies: ScopedDependencies = {
    get: () => refused('denied', 'fixture_no_dependencies'),
    openScope: async () => refused('denied', 'fixture_no_scope'),
    close: async () => {},
  }
  const provider = await factory.create(config.value, dependencies, {
    instanceId: 'synthetic-pricing',
    bindingId,
    scope,
    signal: new AbortController().signal,
  })
  let ready = false
  const quote: BillingPricingPorts['quote'] = async (input, context) => {
    const call = { ...context, bindingId, invocationId: randomUUID() }
    issued.add(call)
    if (!ready) {
      const result = await provider.ready(call)
      if (!result.ok) return result
      ready = true
    }
    const encoded = pricingInputSchema.encode(input)
    if (!encoded.ok) return encoded
    if (!provider.compute) throw new Error('Pricing compute absent')
    const result = await provider.compute(
      {
        target: {
          contract: descriptor.contract,
          providerId: descriptor.providerId,
          logicalName: descriptor.logicalName,
          bindingId,
        },
        method: 'quote',
        input: encoded.value,
      },
      call,
    )
    if (!result.ok) return result
    const decoded = read<W.PriceQuote>(result.value, pricingQuoteSchema.ref, 'PriceQuote')
    if (!decoded.ok) return decoded
    return pricingQuoteSchema.encode(decoded.value)
  }
  const ports: BillingPricingPorts = {
    async input(_request, facts) {
      fixed()
      const quantities: W.ExactQuantity[] = []
      for (const fact of facts) {
        const measurement = read<W.UsageMeasurement>(
          fact.dimensions,
          fact.dimensions.schema,
          'UsageMeasurement',
        )
        if (!measurement.ok || measurement.value.actualModel !== selection.model)
          return refused('conflict', 'billing_pricing_source')
        quantities.push(...measurement.value.quantities)
      }
      return { ok: true, value: { ...selection, usageUnits: quantities } }
    },
    quote,
  }
  return {
    descriptor: factory.descriptor,
    ports,
    async prepare(context: CallContext, quantities: W.ExactQuantity[]) {
      const input = { ...selection, usageUnits: quantities }
      const result = await quote(input, context)
      if (!result.ok) throw new Error(`Pricing: ${result.error.detailCode}`)
      return { input, quoteRef: result.value }
    },
    async close() {
      await provider.close('shutdown')
      db.close()
    },
  }
}
