import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  createDefaultBudgetFactory,
  createDefaultUsageFactory,
  type DefaultBudgetAuthority,
  type DefaultUsageAuthority,
} from '@agnes/core'
import {
  type CallContext,
  defineGeneratedAuthorSchema,
  type EmptyAuthorConfig,
  type Outcome,
  type ScopedDependencies,
  type ServiceProvider,
} from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs } from '@agnes/protocol/runtime'
import type { BillingAccountingPorts } from '../../src/runtime/billing/accounting.js'
import { inline, read, refused } from '../../src/runtime/trace/provider-support.js'
import { createBillingPricingFixture } from './billing-pricing-fixture.js'

type UsageTx = Parameters<Parameters<DefaultUsageAuthority['store']['transaction']>[1]>[0]
type BudgetTx = Parameters<Parameters<DefaultBudgetAuthority['store']['transaction']>[1]>[0]
const codec = defineGeneratedAuthorSchema<EmptyAuthorConfig>({
  ownerPackageId: 'synthetic-accounting',
  name: 'Config',
  typeId: 'synthetic-accounting/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Config',
    $defs: { Config: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})

const measurementCodec = defineGeneratedAuthorSchema<W.UsageMeasurement>({
  ownerPackageId: 'synthetic-accounting',
  name: 'Measurement',
  typeId: 'synthetic-accounting/measurement@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/Measurement',
    $defs: {
      Measurement: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
        properties: {
          kind: { const: 'reported' },
          quantities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['unit', 'value'],
              properties: { unit: { type: 'string' }, value: { type: 'string' } },
            },
          },
          actualModel: { type: 'string' },
          source: { const: 'adapter-counter' },
          sourceReceipt: { type: 'null' },
          billing: {
            type: 'object',
            additionalProperties: false,
            required: ['usdMicros', 'source', 'subscription'],
            properties: {
              usdMicros: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
              source: { const: 'estimated' },
              subscription: { type: 'boolean' },
            },
          },
          credits: { type: 'number', minimum: 0 },
          creditSource: { const: 'gateway' },
          replacesFactIds: { type: 'array', items: { type: 'string' }, maxItems: 0 },
        },
      },
    },
  },
})

/** Real Core public providers over isolated SQLite owners and an explicit synthetic original source. */
export async function createAccountingChainFixture(
  directory: string,
  scope: W.ScopeRef,
  original: W.BillingPostRequest,
  crash: (boundary: string) => void,
  rate = '100',
) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(directory, 'accounting.sqlite'))
  db.exec(
    'PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS facts(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id));CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY);',
  )
  const get = <T>(kind: string, id: string): T | undefined => {
    const row = db.prepare('SELECT body FROM facts WHERE kind=? AND id=?').get(kind, id)
    return row ? (JSON.parse(String(row.body)) as T) : undefined
  }
  const put = (kind: string, id: string, value: unknown) => {
    db.prepare('INSERT INTO facts VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(
      kind,
      id,
      JSON.stringify(value),
    )
  }
  const measurement: W.UsageMeasurement = {
    kind: 'reported',
    quantities: [{ unit: 'request', value: '1' }],
    actualModel: 'synthetic-model',
    source: 'adapter-counter',
    sourceReceipt: null,
    billing: { usdMicros: Number(rate), source: 'estimated', subscription: false },
    credits: 0,
    creditSource: 'gateway',
    replacesFactIds: [],
  }
  const encodedMeasurement = measurementCodec.encode(measurement)
  if (!encodedMeasurement.ok) throw new Error('Synthetic measurement codec')
  const source = {
    authorityId: 'synthetic-usage',
    actionId: 'synthetic-action',
    attemptId: 'synthetic-attempt',
    source: {
      contract: 'agh.model',
      providerId: 'synthetic-model',
      logicalName: 'model',
      bindingId: 'synthetic-model-binding',
    },
    externalRequest: {
      system: 'synthetic-model',
      requestId: 'synthetic-external-receipt',
      requestDigest: canonicalJsonDigest({ input: 'synthetic-model-input' }),
    },
    scope,
    observedAt: '2026-10-04T00:00:00.000Z',
    measurement,
    measurementRef: encodedMeasurement.value,
    certainty: 'measured' as const,
    sourceDigest: canonicalJsonDigest({ measurement, receipt: 'synthetic-external-receipt' }),
    purpose: 'primary-model',
    parentActionId: null,
  }
  if (!get('source', 'attempt')) put('source', 'attempt', source)
  const pricing = await createBillingPricingFixture(directory, scope, rate)
  const initialQuote = read<W.PriceQuote>(
    original.quoteRef,
    RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
    'PriceQuote',
  )
  if (!initialQuote.ok) throw new Error('Synthetic original price missing')
  const reservationRef: W.DomainObjectRef = {
    authorityId: 'synthetic-budget',
    typeId: 'agh.budget/reservation@1',
    id: 'synthetic-reservation',
    revision: 1,
  }
  const check = (ctx: CallContext) => {
    if (
      ctx.signal.aborted ||
      ctx.authorizationRef !== 'synthetic-auth' ||
      ctx.principalRef !== 'synthetic-principal' ||
      canonicalJsonDigest(ctx.scope) !== canonicalJsonDigest(scope)
    )
      throw new Error('Synthetic authority qualification absent')
  }
  const transaction = async <T, Tx>(ctx: CallContext, tx: Tx, fn: (tx: Tx) => T): Promise<T> => {
    db.exec('BEGIN IMMEDIATE')
    try {
      check(ctx)
      const result = fn(tx)
      check(ctx)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const usageTx: UsageTx = {
    verify(input, ctx) {
      check(ctx)
      const known = get<typeof source>('source', 'attempt')
      if (
        !known ||
        input.attemptRef.actionId !== known.actionId ||
        input.attemptRef.attemptId !== known.attemptId ||
        canonicalJsonDigest(input.measurement) !== canonicalJsonDigest(known.measurement)
      )
        throw new Error('Original source differs')
      return known
    },
    origin: (authority, key) => get('usage-origin', canonicalJsonDigest({ authority, key })),
    fact: (id) => get('usage-fact', id),
    putFact(value) {
      if (get('usage-fact', value.fact.usageId)) throw new Error('Immutable source changed')
      put('usage-fact', value.fact.usageId, value)
    },
    putOrigin: (value) =>
      put('usage-origin', canonicalJsonDigest({ authority: value.authorityId, key: value.originKey }), value),
    replay: (id) => get('usage-replay', id),
    remember: (id, fingerprint, result) => put('usage-replay', id, { fingerprint, result }),
    nextRevision: () => Number(db.prepare('INSERT INTO revisions DEFAULT VALUES').run().lastInsertRowid),
    assertCurrent: check,
  }
  type StoredFact = NonNullable<ReturnType<UsageTx['fact']>>
  const budgetTx: BudgetTx = {
    now: () => new Date().toISOString(),
    authorizeReserve(input, ctx) {
      check(ctx)
      if (
        !('existingActionId' in input.actionRef) ||
        input.actionRef.existingActionId !== source.actionId ||
        input.attemptId !== source.attemptId
      )
        throw new Error('Original attempt missing')
      return {
        identity: source.attemptId,
        actionId: source.actionId,
        sourceDigest: source.sourceDigest,
        accountIds: [original.accountRef.id],
        scopeIds: ['synthetic-scope'],
        reservationRef,
        expiresAt: '2099-01-01T00:00:00.000Z',
        mode: 'cost-hard',
      }
    },
    authorizeQuota() {
      throw new Error('No quota source')
    },
    authorizeExisting(ref, ctx) {
      check(ctx)
      if (canonicalJsonDigest(ref) !== canonicalJsonDigest(reservationRef))
        throw new Error('Reservation absent')
    },
    settlement(input, reservation, ctx) {
      check(ctx)
      const invoice = get<W.BillingPostRequest>('source', 'invoice')
      if (
        !invoice ||
        invoice.chargeKey !== original.chargeKey ||
        canonicalJsonDigest(invoice.accountRef) !== canonicalJsonDigest(original.accountRef)
      )
        throw new Error('Original price source changed')
      const quote = read<W.PriceQuote>(
        invoice.quoteRef,
        RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
        'PriceQuote',
      )
      if (!quote.ok) throw new Error('Original quote absent')
      const records = input.usageRefs.map((ref) => {
        const known = get<StoredFact>('usage-fact', ref.usageId)
        if (
          !known ||
          canonicalJsonDigest(known.ref) !== canonicalJsonDigest(ref) ||
          known.fact.actionId !== reservation.actionId ||
          known.fact.attemptId !== reservation.attemptId
        )
          throw new Error('Original Usage source absent')
        return known
      })
      if (!records.length || records.some((r) => r.fact.certainty === 'unknown'))
        throw new Error('Unknown usage source')
      return {
        sourceDigest: canonicalJsonDigest({ refs: input.usageRefs, original: invoice }),
        amount: quote.value.amount,
        priceVersion: quote.value.priceVersion,
        units: measurement.quantities,
        origins: records.map((r) => r.fact.originKey),
        certainty: 'known',
      }
    },
    reconciliation() {
      throw new Error('No reconciliation source')
    },
    quotaCompletion() {
      throw new Error('No quota source')
    },
    account: (id) => get('budget-account', id),
    putAccount: (value) => put('budget-account', value.ref.id, value),
    reservation: (id) => get('budget-reservation', id),
    putReservation: (value) => put('budget-reservation', value.reservation.ref.id, value),
    quota: (id) => get('budget-quota', id),
    putQuota: (value) => put('budget-quota', value.reservation.ref.id, value),
    replay: (id) => get('budget-replay', id),
    remember: (id, fingerprint, result) => put('budget-replay', id, { fingerprint, result }),
    origin: (id) => get('budget-origin', id),
    claimOrigin: (id, value) => {
      if (get('budget-origin', id)) throw new Error('Duplicate origin')
      put('budget-origin', id, value)
    },
    assertCurrent: check,
  }
  if (!get('budget-account', original.accountRef.id))
    put('budget-account', original.accountRef.id, {
      ref: original.accountRef,
      parentId: null,
      currency: initialQuote.value.amount.currency,
      cap: '1000000',
      held: '0',
      settled: '0',
      units: { request: { scale: 0, cap: '1000', held: '0', settled: '0' } },
      quotas: {},
    })
  const dependencies: ScopedDependencies = {
    get: () => refused('denied', 'fixture_no_dependencies'),
    openScope: async () => refused('denied', 'fixture_no_scope'),
    close: async () => {},
  }
  const providers = new Map<string, ServiceProvider>()
  const descriptors = new Map<string, W.ProviderDescriptor>()
  const authority = {
    now: budgetTx.now,
    open: async () => ({ ok: true as const, value: undefined }),
    readConfig: async (ref: W.DataRef) =>
      ref.kind === 'inline' ? { ok: true as const, value: ref.value } : refused('denied', 'fixture_blob'),
    read: async (ref: W.DataRef) =>
      ref.kind === 'inline' ? { ok: true as const, value: ref.value } : refused('denied', 'fixture_blob'),
    checkCurrent: async (ctx: CallContext): Promise<Outcome<void>> => {
      check(ctx)
      return { ok: true, value: undefined }
    },
    operationOwner: async (method: string, input: W.JsonValue) => ({
      ok: true as const,
      value: { kind: 'reconciliation' as const, id: canonicalJsonDigest({ method, input }) },
    }),
    publish: async (schema: W.SchemaRef, value: W.JsonValue) => ({
      ok: true as const,
      value: inline(schema, value),
    }),
    health: async () => ({ ok: true as const, value: { status: 'ready' as const, diagnosticIds: [] } }),
    drain: async () => ({
      ok: true as const,
      value: { state: 'drained' as const, activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
    }),
    close: async () => {},
  }
  for (const service of ['usage', 'budget'] as const) {
    const contract = service === 'usage' ? 'agh.usage' : 'agh.budget'
    const schemas = RuntimeMethodSchemaRefs[contract]
    const names =
      service === 'usage'
        ? ['record', 'query']
        : ['reserve', 'settle', 'reconcile', 'reserveQuota', 'releaseQuota', 'readSessionBudget']
    const descriptor: W.ProviderDescriptor = {
      providerId: `synthetic-${service}`,
      contract,
      major: 1,
      logicalName: service,
      packageVersion: '1.0.0',
      packageDigest: 'a'.repeat(64),
      features: [],
      scope: 'workspace',
      configSchema: codec.ref,
      requires: [],
      capabilities: [],
      recovery: 'R1',
      isolation: ['trusted-in-process'],
      stateCodecs: [],
      activationMode: 'eager',
      operations: Object.entries(schemas)
        .filter(([method]) => names.includes(method))
        .map(([method, refs]) => ({
          method,
          kind: method === 'query' || method === 'readSessionBudget' ? 'query' : 'control',
          inputSchema: refs.input,
          outputSchema: refs.output,
          requiredCapabilities: [],
          retrySafety: method === 'query' || method === 'readSessionBudget' ? 'read-only' : 'idempotent',
        })),
    }
    const factory =
      service === 'usage'
        ? createDefaultUsageFactory(
            descriptor,
            {
              ...authority,
              store: { transaction: (ctx, fn) => transaction(ctx, usageTx, fn) },
              async query(input, ctx) {
                check(ctx)
                if (
                  input.cursor !== null ||
                  canonicalJsonDigest(input.scopeRef) !== canonicalJsonDigest(scope)
                )
                  return refused('denied', 'fixture_query')
                const items = db
                  .prepare("SELECT body FROM facts WHERE kind='usage-fact'")
                  .all()
                  .map((row) => (JSON.parse(String(row.body)) as StoredFact).fact)
                return {
                  ok: true,
                  value: {
                    value: { items, snapshot: 'synthetic-snapshot', nextCursor: null, complete: true },
                    snapshot: 'synthetic-snapshot',
                  },
                }
              },
            },
            codec,
          )
        : createDefaultBudgetFactory(
            descriptor,
            {
              ...authority,
              store: { transaction: (ctx, fn) => transaction(ctx, budgetTx, fn) },
              readSessionBudget: async () => refused('denied', 'fixture_no_view'),
            },
            codec,
          )
    const config = codec.encode({})
    if (!config.ok) throw new Error('Fixture codec')
    providers.set(
      service,
      await factory.create(config.value, dependencies, {
        instanceId: 'synthetic-instance',
        bindingId: `synthetic-${service}-binding`,
        scope,
        signal: new AbortController().signal,
      }),
    )
    descriptors.set(service, descriptor)
  }
  const invoke = async <K extends keyof W.RuntimeWireTypes>(
    service: 'usage' | 'budget',
    method: string,
    input: unknown,
    output: K,
    ctx: CallContext,
  ): Promise<Outcome<W.RuntimeWireTypes[K]>> => {
    const provider = providers.get(service),
      descriptor = descriptors.get(service)
    if (!provider || !descriptor) throw new Error('Selected fixture provider absent')
    const schemas = RuntimeMethodSchemaRefs[service === 'usage' ? 'agh.usage' : 'agh.budget'] as Record<
      string,
      { input: W.SchemaRef; output: W.SchemaRef }
    >
    const schema = schemas[method]
    if (!schema) throw new Error('Public fixture method absent')
    const target = {
      bindingId: `synthetic-${service}-binding`,
      contract: descriptor.contract,
      logicalName: service,
      providerId: descriptor.providerId,
    }
    const call = { ...ctx, bindingId: target.bindingId }
    if (method === 'query') {
      if (!provider.query) throw new Error('Public fixture query absent')
      const result = await provider.query({ target, method, input: inline(schema.input, input) }, call)
      if (!result.ok) return result
      return result.value.kind === 'value'
        ? read<W.RuntimeWireTypes[K]>(result.value.output, schema.output, output)
        : refused('denied', 'fixture_refresh')
    }
    if (!provider.control) throw new Error('Public fixture control absent')
    const result = await provider.control({ target, method, input: inline(schema.input, input) }, call)
    return result.ok ? read<W.RuntimeWireTypes[K]>(result.value, schema.output, output) : result
  }
  const ports: BillingAccountingPorts = {
    pricing: pricing.ports,
    async readUsage(ref, ctx) {
      const page = await invoke(
        'usage',
        'query',
        { scopeRef: scope, cursor: null, limit: 100 },
        'UsageQueryResult',
        ctx,
      )
      if (!page.ok) return page
      const fact = page.value.items.find((f) => f.usageId === ref.usageId)
      return fact ? { ok: true, value: fact } : refused('denied', 'fixture_usage_absent')
    },
    async reservation(_input, ctx) {
      check(ctx)
      return { ok: true, value: reservationRef }
    },
    async settle(input, ctx) {
      const result = await invoke('budget', 'settle', input, 'BudgetSettleResult', ctx)
      if (result.ok) crash('budget')
      return result
    },
  }
  return {
    ports,
    async prepare(ctx: CallContext): Promise<W.BillingPostRequest> {
      const result = await invoke(
        'usage',
        'record',
        {
          attemptRef: {
            run: {
              runId: 'synthetic-run',
              session: {
                authority: {
                  authorityId: 'synthetic-state',
                  tenantId: 'synthetic-tenant',
                  authorityEpoch: 1,
                },
                sessionId: 'synthetic-session',
              },
            },
            actionId: source.actionId,
            attemptId: source.attemptId,
          },
          externalReceiptRef: null,
          measurement,
        },
        'UsageRecordResult',
        ctx,
      )
      if (!result.ok) throw new Error(`Usage: ${result.error.detailCode}`)
      crash('usage')
      const selected = await pricing.prepare(ctx, measurement.quantities)
      const invoice = { ...original, usageRefs: result.value.factRefs, quoteRef: selected.quoteRef }
      const previous = get<W.BillingPostRequest>('source', 'invoice')
      if (previous && canonicalJsonDigest(previous) !== canonicalJsonDigest(invoice))
        throw new Error('Original pricing changed')
      if (!previous) put('source', 'invoice', invoice)
      crash('quote')
      const quote = read<W.PriceQuote>(
        selected.quoteRef,
        RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
        'PriceQuote',
      )
      if (!quote.ok) throw new Error('Computed quote absent')
      const reserved = await invoke(
        'budget',
        'reserve',
        {
          actionRef: { existingActionId: source.actionId },
          attemptId: source.attemptId,
          accountRef: original.accountRef,
          unitsByKind: measurement.quantities,
          maxCost: quote.value.amount,
          priceVersion: quote.value.priceVersion,
          parentReservationRef: null,
        },
        'BudgetReserveResult',
        ctx,
      )
      if (!reserved.ok) throw new Error(`Reserve: ${reserved.error.detailCode}`)
      return invoice
    },
    stats() {
      const count = (kind: string) =>
        Number(db.prepare('SELECT COUNT(*) AS n FROM facts WHERE kind=?').get(kind)?.n)
      return {
        usageFacts: count('usage-fact'),
        pricingProviderId: pricing.descriptor.providerId,
        measurements: db
          .prepare("SELECT body FROM facts WHERE kind='usage-fact'")
          .all()
          .map((row) => (JSON.parse(String(row.body)) as StoredFact).fact.dimensions),
        origins: count('budget-origin'),
        settled: get<ReturnType<BudgetTx['account']>>('budget-account', original.accountRef.id)?.settled,
        reservation: get<ReturnType<BudgetTx['reservation']>>('budget-reservation', reservationRef.id)
          ?.reservation,
      }
    },
    async close() {
      for (const provider of providers.values()) await provider.close('shutdown')
      await pricing.close()
      db.close()
    },
  }
}
