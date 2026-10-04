import { DatabaseSync } from 'node:sqlite'
import { createPricingProviderFactory, type PricingProviderOwner } from '@agnes/ai/runtime'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type FactoryContext,
  type Outcome,
  pricingInputSchema,
  pricingQuoteSchema,
  type ScopedDependencies,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import {
  canonicalJsonDigest,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, expect, it } from 'vitest'
import type { PricingCatalogRule } from '../../src/runtime/providers/pricing.js'

const close: DatabaseSync[] = []
afterEach(() => {
  for (const db of close.splice(0)) db.close()
})
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
function fixture() {
  const db = new DatabaseSync(':memory:')
  close.push(db)
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
  const getCatalog = db
    .prepare('SELECT body,digest FROM catalog WHERE id=?')
    .get.bind(db.prepare('SELECT body,digest FROM catalog WHERE id=?'))
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
  const factory = createPricingProviderFactory({ descriptor, configurationSchema: configCodec, owner })
  return {
    db,
    call,
    factory,
    factoryContext,
    owner,
    controller,
    request: () => ({
      target: {
        bindingId: 'binding',
        contract: 'agh.pricing',
        providerId: descriptor.providerId,
        logicalName: 'default',
      },
      method: 'quote',
      input: value(pricingInputSchema.encode(input)),
    }),
    async open() {
      return factory.create(value(configCodec.encode({})), dependencies, factoryContext)
    },
    onClock(fn: () => void) {
      clockHook = fn
    },
    onDynamic(fn: () => void) {
      dynamicHook = fn
    },
    reads() {
      return getCatalog('selected')
    },
  }
}
function compute(provider: ServiceProvider) {
  if (!provider.compute) throw Error('Compute absent')
  return provider.compute.bind(provider)
}
it('consumes official full codecs through complete pricing compute and lifecycle SPI', async () => {
  const f = fixture(),
    p = await f.open()
  value(await p.ready(f.call))
  const output = value(await compute(p)(f.request(), f.call))
  expect(output.schema).toEqual(refs.output)
  if (output.kind !== 'inline') throw Error('Unexpected blob')
  expect(value(pricingQuoteSchema.parse(output.value)).amount).toEqual({
    currency: 'XTS',
    scale: 6,
    units: '2',
  })
  expect(value(await p.health(f.call)).status).toBe('ready')
  expect(value(await p.drain(f.call.deadline, f.call)).state).toBe('drained')
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
  await p.close('shutdown')
  expect((await p.ready(f.call)).ok).toBe(false)
})
it('refuses missing native catalog and copied rather than original reader qualification', async () => {
  const f = fixture(),
    p = await f.open()
  value(await p.ready(f.call))
  expect((await compute(p)(f.request(), { ...f.call })).ok).toBe(false)
  f.db.prepare('DELETE FROM catalog').run()
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
  await expect(f.open()).rejects.toThrow()
})
it('refuses actual grant removal by the last Clock and leaves no result or new native rows', async () => {
  const f = fixture(),
    p = await f.open()
  value(await p.ready(f.call))
  const before = f.reads()
  f.onClock(() => {
    f.db.prepare('DELETE FROM grants').run()
  })
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
  expect(f.reads()).toEqual(before)
  expect(f.db.prepare('SELECT COUNT(*) n FROM grants').get()?.n).toBe(0)
})
it('refuses ready revival when a current-source callback closes the original instance', async () => {
  const f = fixture(),
    p = await f.open()
  f.onDynamic(() => {
    void p.close('shutdown')
  })
  expect((await p.ready(f.call)).ok).toBe(false)
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
})
it('refuses malformed input content proof, foreign target, cancelled call and changed context', async () => {
  const f = fixture(),
    p = await f.open()
  value(await p.ready(f.call))
  const request = f.request()
  if (request.input.kind !== 'inline') throw Error('Unexpected fixture blob')
  request.input = { ...request.input, digest: '0'.repeat(64) }
  expect((await compute(p)(request, f.call)).ok).toBe(false)
  const foreign = f.request()
  foreign.target.providerId = 'foreign'
  expect((await compute(p)(foreign, f.call)).ok).toBe(false)
  f.onDynamic(() => {
    Object.defineProperty(f.call, 'authorizationRef', { value: 'changed' })
  })
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
  f.controller.abort()
  expect((await compute(p)(f.request(), f.call)).ok).toBe(false)
})
