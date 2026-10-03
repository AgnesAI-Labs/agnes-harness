import {
  type AuthorSchema,
  type CallContext,
  defineGeneratedAuthorSchema,
  type EmptyAuthorConfig,
  type Outcome,
  type ScopedDependencies,
} from '@agnes/extension-api/runtime'
import { contracts } from '@agnes/extension-api/testkit'
import { jcs } from '@agnes/protocol'
import {
  canonicalJsonDigest,
  type DataRef,
  type JsonValue,
  type ProviderDescriptor,
  RuntimeMethodSchemaRefs,
  type RuntimeWireTypes,
  type SchemaRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { describe, expect, it } from 'vitest'

const { runBudgetContractScenario } = contracts
type BudgetContractFixture = contracts.BudgetContractFixture

import { createDefaultBudgetFactory, type DefaultBudgetAuthority } from '@agnes/core'
import { BudgetAuthorityFault } from '../../src/runtime/budget/reservations.js'
import { budgetContext, budgetFixture, budgetRequest } from './fixtures/budget-authority.js'

const codec: AuthorSchema<EmptyAuthorConfig> = defineGeneratedAuthorSchema({
  ownerPackageId: 'budget-provider-test',
  name: 'BudgetConfig',
  typeId: 'budget-provider-test/config@1',
  revision: 1,
  document: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/BudgetConfig',
    $defs: { BudgetConfig: { type: 'object', properties: {}, required: [], additionalProperties: false } },
  },
})
const fail = (detailCode: string): Outcome<never> => ({
  ok: false,
  error: {
    code: 'denied',
    detailCode,
    message: 'Actual fixture qualification missing',
    retryAdvice: { kind: 'never' },
    diagnosticId: 'test-owner',
  },
})
function encoded<K extends keyof RuntimeWireTypes>(
  schema: SchemaRef,
  name: K,
  value: RuntimeWireTypes[K],
): DataRef {
  const parsed = validateRuntime(name, value),
    json = validateRuntime('JsonValue', value)
  if (!parsed.ok || !json.ok) throw new TypeError('Invalid fixture input')
  return {
    kind: 'inline',
    schema,
    value: json.value,
    digest: canonicalJsonDigest(json.value),
    bytes: Buffer.byteLength(jcs(json.value)),
  }
}
function fixture(path?: string) {
  const owner = budgetFixture(path),
    schemas = RuntimeMethodSchemaRefs['agh.budget']
  const descriptor: ProviderDescriptor = {
    providerId: 'budget-provider',
    contract: 'agh.budget',
    major: 1,
    logicalName: 'budget',
    packageVersion: '1.0.0',
    packageDigest: 'a'.repeat(64),
    features: [],
    scope: 'session',
    configSchema: codec.ref,
    requires: [],
    capabilities: [],
    recovery: 'R1',
    isolation: ['trusted-in-process'],
    stateCodecs: [],
    activationMode: 'eager',
    operations: Object.entries(schemas)
      .filter(([name]) =>
        ['reserve', 'settle', 'reconcile', 'reserveQuota', 'releaseQuota', 'readSessionBudget'].includes(
          name,
        ),
      )
      .map(([method, refs]) => ({
        method,
        kind: method === 'readSessionBudget' ? ('query' as const) : ('control' as const),
        inputSchema: refs.input,
        outputSchema: refs.output,
        requiredCapabilities: [],
        retrySafety: method === 'readSessionBudget' ? ('read-only' as const) : ('idempotent' as const),
      })),
  }
  let closed = false,
    queryComplete = true,
    afterPublish: (() => void) | undefined,
    corruptPublish = false
  // This explicit retained source represents the fixture's known absent legacy credits configuration, not an invented Money balance.
  if (!owner.get('session-budget-view', 'session'))
    owner.put('session-budget-view', 'session', {
      scope: budgetContext.scope,
      value: { state: null, ledger: [] },
    })
  const authority: DefaultBudgetAuthority = {
    store: owner.store,
    now: owner.tx.now,
    async open() {
      return { ok: true, value: undefined }
    },
    async readConfig(config) {
      return config.kind === 'inline' ? { ok: true, value: config.value } : fail('blob_config')
    },
    async read(reference) {
      if (reference.kind !== 'inline') return fail('blob_fixture')
      return { ok: true, value: reference.value }
    },
    async checkCurrent(ctx) {
      try {
        owner.tx.assertCurrent(ctx)
        return { ok: true, value: undefined }
      } catch {
        return fail('current_revoked')
      }
    },
    async operationOwner(method, input, ctx) {
      owner.tx.assertCurrent(ctx)
      const key = canonicalJsonDigest({ method, input, binding: ctx.bindingId, scope: ctx.scope })
      const original = owner.get<{ kind: 'reconciliation'; id: string }>('operation-owner', key)
      if (original) return { ok: true, value: original }
      const value = { kind: 'reconciliation' as const, id: `operation-${key}` }
      owner.put('operation-owner', key, value)
      return { ok: true, value }
    },
    async publish(schema, value) {
      const ref: DataRef = {
        kind: 'inline',
        schema,
        value,
        digest: canonicalJsonDigest(value),
        bytes: Buffer.byteLength(jcs(value)),
      }
      afterPublish?.()
      return { ok: true, value: corruptPublish ? { ...ref, digest: 'b'.repeat(64) } : ref }
    },
    async readSessionBudget(input, ctx, snapshot) {
      owner.tx.assertCurrent(ctx)
      const row = owner.get<{ scope: CallContext['scope']; value: RuntimeWireTypes['SessionBudgetResult'] }>(
        'session-budget-view',
        input.sessionId,
      )
      if (!queryComplete || !row || canonicalJsonDigest(row.scope) !== canonicalJsonDigest(ctx.scope))
        return fail('budget_view_unavailable')
      const actual = `budget-view-${canonicalJsonDigest(row)}`
      if (snapshot !== undefined && snapshot !== actual) return fail('snapshot_unavailable')
      return { ok: true, value: { value: row.value, snapshot: actual } }
    },
    async health() {
      return { ok: true, value: { status: closed ? 'failed' : 'ready', diagnosticIds: [] } }
    },
    async drain() {
      return {
        ok: true,
        value: { state: 'drained', activeInvocationIds: [], durableOwnerRefs: [], diagnosticIds: [] },
      }
    },
    async close() {
      if (!closed) {
        closed = true
        owner.close()
      }
    },
  }
  const dependencies: ScopedDependencies = {
    get: () => fail('no_dependencies'),
    async openScope() {
      return { ok: true, value: dependencies }
    },
    async close() {},
  }
  const factoryContext = {
    instanceId: 'budget-instance',
    bindingId: budgetContext.bindingId,
    scope: budgetContext.scope,
    signal: new AbortController().signal,
  }
  return {
    owner,
    authority,
    descriptor,
    dependencies,
    factoryContext,
    context: budgetContext,
    config: codec.encode({}),
    factory: () => createDefaultBudgetFactory(descriptor, authority, codec),
    async provider() {
      const config = codec.encode({})
      if (!config.ok) throw new Error('fixture')
      const provider = await createDefaultBudgetFactory(descriptor, authority, codec).create(
        config.value,
        dependencies,
        factoryContext,
      )
      if (!provider.control || !provider.query) throw new TypeError('Complete public methods are missing')
      return { ...provider, control: provider.control, query: provider.query }
    },
    operation<K extends keyof RuntimeWireTypes>(
      method: keyof typeof schemas,
      name: K,
      input: RuntimeWireTypes[K],
    ) {
      return {
        target: {
          bindingId: budgetContext.bindingId,
          contract: 'agh.budget',
          logicalName: 'budget',
          providerId: descriptor.providerId,
        },
        method,
        input: encoded(schemas[method].input, name, input),
      }
    },
    revoke: () => owner.revoke(),
    incomplete: () => {
      queryComplete = false
    },
    afterPublish: (fn: () => void) => {
      afterPublish = fn
    },
    corruptOutput: () => {
      corruptPublish = true
    },
    validOutput: () => {
      corruptPublish = false
    },
  }
}

describe('default Budget public methods over actual persistent owner', () => {
  it('declares all six official methods and rejects a descriptor with the query missing', async () => {
    const f = fixture()
    expect(f.descriptor.operations).toHaveLength(6)
    f.descriptor.operations = f.descriptor.operations.filter((x) => x.method !== 'readSessionBudget')
    expect(() => f.factory()).toThrow('complete')
    f.owner.close()
  })
  it('commits reserve through the public wire and preserves original source and exact result across cold reopen', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a'))
    const first = await p.control(input, f.context)
    expect(first.ok).toBe(true)
    expect(f.owner.writes()).toBe(1)
    const file = f.owner.file
    await p.close('shutdown')
    const cold = fixture(file),
      reopened = await cold.provider()
    expect(await reopened.control(input, cold.context)).toEqual(first)
    expect(cold.owner.writes()).toBe(1)
    await reopened.close('shutdown')
  })
  it('rejects unknown or incomplete session budget source rather than returning an empty successful budget', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('readSessionBudget', 'SessionBudgetClientReadRequest', { sessionId: 'session' })
    const original = await p.query(input, f.context)
    expect(original.ok).toBe(true)
    expect(f.owner.writes()).toBe(0)
    f.incomplete()
    expect(await p.query(input, f.context)).toMatchObject({
      ok: false,
      error: { code: 'denied', detailCode: 'budget_view_unavailable' },
    })
    expect(f.owner.writes()).toBe(0)
    await p.close('shutdown')
  })
  it('returns a genuine durable reconciliation owner if output publication fails after the original reserve committed', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a'))
    f.corruptOutput()
    expect(await p.control(input, f.context)).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_effect',
        retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'reconciliation' } },
      },
    })
    expect(f.owner.writes()).toBe(1)
    f.validOutput()
    expect((await p.control(input, f.context)).ok).toBe(true)
    expect(f.owner.writes()).toBe(1)
    await p.close('shutdown')
  })
  it('retains the durable owner when publication throws a business fault after actual commit', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a'))
    f.afterPublish(() => {
      throw new BudgetAuthorityFault('denied', 'publisher lost capability after commit')
    })
    expect(await p.control(input, f.context)).toMatchObject({
      ok: false,
      error: {
        code: 'unknown_effect',
        retryAdvice: { kind: 'reconcile', ownerRef: { kind: 'reconciliation' } },
      },
    })
    expect(f.owner.writes()).toBe(1)
    expect(f.owner.get('reservation', 'reservation-attempt-a')).toBeDefined()
    f.afterPublish(() => {})
    expect((await p.control(input, f.context)).ok).toBe(true)
    expect(f.owner.writes()).toBe(1)
    await p.close('shutdown')
  })
  it('denies a query when qualification is revoked by the asynchronous publisher before return', async () => {
    const f = fixture(),
      p = await f.provider()
    f.afterPublish(f.revoke)
    expect(
      await p.query(
        f.operation('readSessionBudget', 'SessionBudgetClientReadRequest', { sessionId: 'session' }),
        f.context,
      ),
    ).toMatchObject({ ok: false, error: { code: 'denied' } })
    expect(f.owner.writes()).toBe(0)
    await p.close('shutdown')
  })
  it('blocks wrong targets, source scopes and tampered input before any Budget write', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a'))
    expect(
      (await p.control({ ...input, target: { ...input.target, bindingId: 'wrong' } }, f.context)).ok,
    ).toBe(false)
    expect(
      (await p.control(input, { ...f.context, scope: { ...f.context.scope, installationId: 'other' } })).ok,
    ).toBe(false)
    expect(
      (
        await p.control(
          {
            ...input,
            input: {
              ...input.input,
              kind: 'inline',
              schema: input.input.schema,
              value: { tampered: true },
              digest: 'c'.repeat(64),
              bytes: 1,
            },
          },
          f.context,
        )
      ).ok,
    ).toBe(false)
    expect(f.owner.writes()).toBe(0)
    await p.close('shutdown')
  })
  it('drains and closes the actual owner without erasing obligations and refuses a new operation after drain', async () => {
    const f = fixture(),
      p = await f.provider(),
      input = f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a'))
    expect((await p.ready(f.context)).ok).toBe(true)
    await p.control(input, f.context)
    expect(await p.drain(f.context.deadline, f.context)).toMatchObject({
      ok: true,
      value: { state: 'drained' },
    })
    expect((await p.control(input, f.context)).ok).toBe(false)
    const file = f.owner.file
    await p.close('shutdown')
    const cold = fixture(file)
    expect(cold.owner.get('reservation', 'reservation-attempt-a')).toBeDefined()
    cold.owner.close()
  })
})

async function contractFixture(path?: string): Promise<BudgetContractFixture> {
  const f = fixture(path),
    cancel = new AbortController(),
    context = { ...f.context, signal: cancel.signal }
  const config = codec.encode({})
  if (!config.ok) throw new Error('fixture config')
  return {
    factory: f.factory(),
    config: config.value,
    dependencies: f.dependencies,
    factoryContext: f.factoryContext,
    context,
    reserve: f.operation('reserve', 'BudgetReserveRequest', budgetRequest('a')),
    quota: f.operation('reserveQuota', 'BudgetReserveQuotaRequest', {
      actionRef: { existingActionId: 'b' },
      attemptId: 'attempt-b',
      dimensions: [{ name: 'parallel-action', amount: 1 }],
    }),
    readBudget: f.operation('readSessionBudget', 'SessionBudgetClientReadRequest', { sessionId: 'session' }),
    async read(reference) {
      if (reference.kind !== 'inline') throw new Error('fixture blob unavailable')
      return reference.value
    },
    async settle(reservation) {
      return f.operation('settle', 'BudgetSettleRequest', {
        reservationRef: reservation.ref,
        usageRefs: f.owner.usageRefs(),
      })
    },
    async reconcile(reservation) {
      const evidence = f.owner.reconciliationProof(reservation.ref.id, {
        kind: 'not-executed',
        sourceDigest: canonicalJsonDigest({ request: reservation.ref.id, actualControlledFixtureSends: 0 }),
      })
      return f.operation('reconcile', 'BudgetReconcileRequest', {
        reservationRef: reservation.ref,
        evidenceRef: evidence,
      })
    },
    async release(reference) {
      return f.operation('releaseQuota', 'BudgetReleaseQuotaRequest', {
        reservationRef: reference,
        completionEvidence: f.owner.quotaCompletionProof(reference.id),
      })
    },
    async reservations() {
      return (
        f.owner.db.prepare("SELECT value FROM facts WHERE kind='reservation' ORDER BY key").all() as {
          value: string
        }[]
      ).map((row) => {
        const value = JSON.parse(row.value)
        const parsed = validateRuntime('BudgetReservation', value.reservation)
        if (!parsed.ok) throw new Error('original reservation damaged')
        return parsed.value
      })
    },
    async deny() {
      f.revoke()
    },
    cancel() {
      cancel.abort()
    },
    async recover() {
      return contractFixture(f.owner.file)
    },
    async finish() {
      await f.authority.close('shutdown')
    },
  }
}
for (const scenario of ['select', 'normal', 'deny', 'cancel', 'recover', 'dispose'] as const)
  it(`executes default Budget contract slot ${scenario} with original persistent sources`, async () => {
    await runBudgetContractScenario(scenario, () => contractFixture())
  })
