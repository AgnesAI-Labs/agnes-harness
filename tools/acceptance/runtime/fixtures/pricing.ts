import { DatabaseSync } from 'node:sqlite'
import { createReferencePricingFactory } from '../../../../examples/runtime-reference/src/index.js'
import {
  createPricingProviderFactory,
  type PricingProviderOwner,
} from '../../../../packages/ai/src/runtime/index.js'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type FactoryContext,
  type Outcome,
  pricingInputSchema,
  type ScopedDependencies,
} from '../../../../packages/extension-api/src/runtime/index.js'
import type { contracts } from '../../../../packages/extension-api/testkit/index.js'
import {
  canonicalJsonDigest,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '../../../../packages/protocol/src/runtime/index.js'

type PricingCatalogRule = contracts.PricingCatalogObservation

function value<T>(outcome: Outcome<T>): T {
  if (!outcome.ok) throw new Error(outcome.error.detailCode)
  return outcome.value
}
const configCodec = defineGeneratedAuthorSchema<Record<string, never>>({
  ownerPackageId: 'fixture.price',
  name: 'Config',
  typeId: 'fixture.price/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Config',
    $defs: { Config: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})
const refs = RuntimeMethodSchemaRefs['agh.pricing'].quote
const scope = { kind: 'workspace' as const, installationId: 'i', runtimeId: 'r', workspaceId: 'w' }
const input = {
  model: 'fixture-model',
  region: null,
  currency: 'XTS',
  priceVersion: 'locked',
  usageUnits: [{ unit: 'token', value: '0.5' }],
}
const catalog: PricingCatalogRule[] = [
  {
    priceVersion: 'locked',
    model: 'fixture-model',
    region: null,
    unit: 'token',
    ruleId: 'fixed-rule',
    unitPrice: { currency: 'XTS', scale: 6, units: '3' },
  },
]
const descriptor: ProviderDescriptor = {
  providerId: 'fixture.pricing',
  contract: 'agh.pricing',
  major: 1,
  logicalName: 'default',
  packageVersion: '1.0.0',
  packageDigest: 'a'.repeat(64),
  features: [],
  scope: 'workspace',
  configSchema: configCodec.ref,
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
const dependencies: ScopedDependencies = {
  get() {
    throw Error('No dependency')
  },
  async openScope() {
    return { ok: true, value: dependencies }
  },
  async close() {},
}

// Restricted selected native catalog/grant issuer; it does not install production C14 or vendor pricing.
export function createPricingContractFixture(
  kind: 'default' | 'reference',
): contracts.PricingContractFixture {
  const db = new DatabaseSync(':memory:')
  db.exec(
    'CREATE TABLE catalog(id TEXT PRIMARY KEY,body TEXT NOT NULL,digest TEXT NOT NULL); CREATE TABLE grants(id TEXT PRIMARY KEY,until REAL NOT NULL)',
  )
  const encodedCatalog = validateRuntime('JsonValue', catalog)
  if (!encodedCatalog.ok) throw Error('Fixture catalog is not JSON')
  const text = JSON.stringify(catalog),
    digest = canonicalJsonDigest(encodedCatalog.value)
  db.prepare('INSERT INTO catalog VALUES(?,?,?)').run('selected', text, digest)
  db.prepare('INSERT INTO grants VALUES(?,?)').run('reader', Date.parse('2027-01-01T00:00:00.000Z'))
  const controller = new AbortController(),
    issued = new WeakSet<CallContext>()
  const call: CallContext = {
    scope,
    bindingId: 'binding',
    principalRef: 'principal',
    authorizationRef: 'grant',
    invocationId: 'quote-invocation',
    traceRef: 'trace',
    deadline: '2027-01-01T00:00:00.000Z',
    signal: controller.signal,
  }
  issued.add(call)
  const factoryContext: FactoryContext = {
    scope,
    bindingId: 'binding',
    instanceId: 'pricing',
    signal: controller.signal,
  }
  const grantStatement = db.prepare('SELECT until FROM grants WHERE id=?'),
    getGrant = grantStatement.get.bind(grantStatement)
  const catalogStatement = db.prepare('SELECT body,digest FROM catalog WHERE id=?'),
    readCatalog = catalogStatement.get.bind(catalogStatement)
  let clockHook: (() => void) | undefined, dynamicHook: (() => void) | undefined
  function grant() {
    const row = getGrant('reader')
    if (typeof row?.until !== 'number') throw Error('Actual grant absent')
    return row.until
  }
  function originalCatalog() {
    const row = readCatalog('selected')
    if (row?.body !== text || row.digest !== digest) throw Error('Actual selected catalog absent')
  }
  const owner: PricingProviderOwner<Record<string, never>> = {
    catalog(configuration, context) {
      if (context !== factoryContext || Object.keys(configuration).length) throw Error('Not selected')
      originalCatalog()
      return {
        catalog,
        until: grant(),
        dynamicCheck() {
          originalCatalog()
        },
        staticCheck() {
          originalCatalog()
        },
      }
    },
    captureCurrent(context, factory) {
      if (!issued.has(context) || factory !== factoryContext) throw Error('Original issued pointer required')
      const until = grant()
      return {
        until,
        dynamicCheck() {
          if (grant() !== until) throw Error('Grant replaced')
          dynamicHook?.()
        },
        staticCheck() {
          if (grant() !== until) throw Error('Grant replaced')
        },
      }
    },
    now() {
      clockHook?.()
      return Date.parse('2026-10-01T00:00:00.000Z')
    },
  }
  const options = { descriptor, configurationSchema: configCodec, owner }
  const factory =
    kind === 'default' ? createPricingProviderFactory(options) : createReferencePricingFactory(options)
  return {
    factory,
    config: value(configCodec.encode({})),
    dependencies,
    factoryContext,
    context: call,
    request: {
      target: {
        bindingId: 'binding',
        contract: 'agh.pricing',
        providerId: descriptor.providerId,
        logicalName: 'default',
      },
      method: 'quote',
      input: value(pricingInputSchema.encode(input)),
    },
    prices() {
      originalCatalog()
      return catalog
    },
    deny() {
      db.prepare('DELETE FROM grants').run()
    },
    cancel() {
      controller.abort()
    },
    async finish() {
      db.close()
    },
  }
}
