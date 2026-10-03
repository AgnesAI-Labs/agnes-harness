import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CallContext } from '@agnes/extension-api/runtime'
import { jcs } from '@agnes/protocol'
import {
  type BudgetReserveRequest,
  canonicalJsonDigest,
  type DomainObjectRef,
  type Money,
  validateRuntime,
} from '@agnes/protocol/runtime'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type BudgetAccount,
  type BudgetAdmission,
  BudgetAuthorityFault,
  type BudgetStore,
  type BudgetTransaction,
  createBudgetReservations,
  exactMoney,
  exactQuantity,
  type VerifiedSettlement,
} from '../../src/runtime/budget/reservations.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const ref = (id: string): DomainObjectRef => ({
  authorityId: 'test-budget',
  typeId: 'agh.test/budget-account@1',
  id,
  revision: 1,
})
const money = (units: string): Money => ({ currency: 'EUR', scale: 6, units })
const context: CallContext = {
  principalRef: 'actor',
  scope: { kind: 'session', installationId: 'i', runtimeId: 'r', workspaceId: 'w', sessionId: 's' },
  bindingId: 'budget-binding',
  invocationId: 'invocation',
  deadline: '2199-01-01T00:00:00.000Z',
  traceRef: 'trace',
  authorizationRef: 'auth',
  signal: new AbortController().signal,
}
function request(
  action: string,
  units = '4',
  cost: string | null = '40',
  parent: DomainObjectRef | null = null,
): BudgetReserveRequest {
  return {
    actionRef: { existingActionId: action },
    attemptId: `attempt-${action}`,
    accountRef: ref('leaf'),
    unitsByKind: [{ unit: 'token', value: units }],
    maxCost: cost === null ? null : money(cost),
    priceVersion: cost === null ? null : 'price-v1',
    parentReservationRef: parent,
  }
}
/** Restricted durable authority: actual SQLite atomic write sets, original authored action records and owner qualification. Not production assembly. */
function fixture(path?: string) {
  const dir = path ? undefined : mkdtempSync(join(tmpdir(), 'budget-authority-'))
  if (dir) dirs.push(dir)
  const file = path ?? join(dir!, 'budget.sqlite'),
    db = new DatabaseSync(file)
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS facts(kind TEXT,key TEXT,value TEXT,PRIMARY KEY(kind,key)); CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY,identity TEXT)',
  )
  const get = <T>(kind: string, key: string): T | undefined => {
    const r = db.prepare('SELECT value FROM facts WHERE kind=? AND key=?').get(kind, key) as
      | { value: string }
      | undefined
    return r ? (JSON.parse(r.value) as T) : undefined
  }
  const put = (kind: string, key: string, value: unknown) => {
    db.prepare(
      'INSERT INTO facts(kind,key,value) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET value=excluded.value',
    ).run(kind, key, JSON.stringify(value))
  }
  let current = true,
    beforeCommit: (() => void) | undefined
  let measurement: VerifiedSettlement = {
    sourceDigest: 'original-source',
    amount: money('40'),
    priceVersion: 'price-v1',
    units: [{ unit: 'token', value: '4' }],
    origins: ['actual-request-one'],
    certainty: 'known',
  }
  let reconcile: ReturnType<BudgetTransaction['reconciliation']> = {
    kind: 'unknown',
    sourceDigest: 'not-found-is-not-negative-proof',
  }
  let clock = '2026-10-02T00:00:00.000Z'
  let completion = false
  const check = (ctx: CallContext) => {
    if (
      !current ||
      ctx.bindingId !== context.bindingId ||
      ctx.authorizationRef !== context.authorizationRef ||
      ctx.signal.aborted ||
      Date.parse(ctx.deadline) <= Date.parse(clock)
    )
      throw new BudgetAuthorityFault('denied', 'actual owner qualification revoked')
  }
  const admission = (
    input: { actionRef: BudgetReserveRequest['actionRef']; attemptId: string },
    ctx: CallContext,
  ): BudgetAdmission => {
    check(ctx)
    if (!('existingActionId' in input.actionRef))
      throw new BudgetAuthorityFault('denied', 'unresolved local action')
    const action = get<{ attemptId: string; accountIds: string[]; scopeIds: string[] }>(
      'action',
      input.actionRef.existingActionId,
    )
    if (!action || action.attemptId !== input.attemptId)
      throw new BudgetAuthorityFault('denied', 'no genuine original action source')
    return {
      identity: input.attemptId,
      actionId: input.actionRef.existingActionId,
      sourceDigest: canonicalJsonDigest({ action, mode: get('profile', 'mode') ?? 'cost-hard' }),
      accountIds: action.accountIds,
      scopeIds: action.scopeIds,
      reservationRef: { ...ref(`reservation-${input.attemptId}`), typeId: 'agh.test/budget-reservation@1' },
      expiresAt: '2099-01-01T00:00:00.000Z',
      mode: get<'bounded-units' | 'cost-hard'>('profile', 'mode') ?? 'cost-hard',
    }
  }
  const tx: BudgetTransaction = {
    now: () => clock,
    authorizeReserve: admission,
    authorizeQuota: (input, ctx) => ({
      ...admission(input, ctx),
      reservationRef: { ...ref(`quota-${input.attemptId}`), typeId: 'agh.test/quota@1' },
    }),
    authorizeExisting: (reference, ctx) => {
      check(ctx)
      if (reference.authorityId !== 'test-budget') throw new BudgetAuthorityFault('denied', 'wrong authority')
    },
    settlement: (input, reservation, ctx) => {
      check(ctx)
      const observation = get<{ value: VerifiedSettlement; actionId: string; attemptId: string }>(
        'usage-observation',
        'selected',
      )
      if (
        !observation ||
        observation.actionId !== reservation.actionId ||
        observation.attemptId !== reservation.attemptId ||
        canonicalJsonDigest(input.usageRefs) !== canonicalJsonDigest(usageRefs())
      )
        throw new BudgetAuthorityFault('denied', 'original Usage fact source differs')
      return observation.value
    },
    reconciliation: (_input, _reservation, ctx) => {
      check(ctx)
      return reconcile
    },
    quotaCompletion: (_input, _reservation, ctx) => {
      check(ctx)
      if (!completion) throw new BudgetAuthorityFault('denied', 'execution completion is unproved')
    },
    account: (id) => get('account', id),
    putAccount: (value) => put('account', value.ref.id, value),
    reservation: (id) => get('reservation', id),
    putReservation: (value) => put('reservation', value.reservation.ref.id, value),
    quota: (id) => get('quota', id),
    putQuota: (value) => put('quota', value.reservation.ref.id, value),
    replay: (id) => get('replay', id),
    remember: (id, fingerprint, result) => {
      put('replay', id, { fingerprint, result })
      db.prepare('INSERT INTO audit(identity) VALUES(?)').run(id)
    },
    origin: (id) => get('origin', id),
    claimOrigin: (id, reservationId) => {
      if (get('origin', id) !== undefined) throw new BudgetAuthorityFault('conflict', 'origin exists')
      put('origin', id, reservationId)
    },
    assertCurrent: check,
  }
  const usageRefs = (prepare = false) => {
    const observation = get<{ value: VerifiedSettlement; actionId: string; attemptId: string }>(
      'usage-observation',
      'selected',
    )
    if (!observation) throw new BudgetAuthorityFault('integrity', 'usage observation is missing')
    const dimensions = {
      kind: observation.value.certainty === 'unknown' ? 'unknown' : 'reported',
      quantities: [...observation.value.units],
      actualModel: null,
      source: 'adapter-counter',
      sourceReceipt: null,
      replacesFactIds: [],
    }
    const document = {
      $id: 'https://example.invalid/budget-usage-dimensions.json',
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'quantities', 'actualModel', 'source', 'sourceReceipt', 'replacesFactIds'],
      properties: {
        kind: { enum: ['unknown', 'reported'] },
        quantities: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['unit', 'value'],
            properties: { unit: { type: 'string' }, value: { type: 'string' } },
          },
        },
        actualModel: { type: 'null' },
        source: { const: 'adapter-counter' },
        sourceReceipt: { type: 'null' },
        replacesFactIds: { type: 'array', maxItems: 0 },
      },
    }
    return observation.value.origins.map((origin, index) => {
      const fact = {
        usageId: `usage-${observation.value.sourceDigest}-${index}`,
        originKey: origin,
        actionId: observation.actionId,
        attemptId: observation.attemptId,
        source: {
          bindingId: 'fixture-source-binding',
          contract: 'agh.usage',
          logicalName: 'fixture-usage',
          providerId: 'fixture-usage',
        },
        dimensions: {
          kind: 'inline',
          schema: {
            typeId: 'agh.test/budget-usage-dimensions@1',
            revision: 1,
            digest: canonicalJsonDigest(document),
          },
          value: dimensions,
          digest: canonicalJsonDigest(dimensions),
          bytes: Buffer.byteLength(jcs(dimensions)),
        },
        externalRequest: {
          system: 'fixture-adapter',
          requestId: origin,
          requestDigest: canonicalJsonDigest({ original: origin }),
        },
        observedAt: '2026-10-02T00:00:00.000Z',
        certainty: observation.value.certainty === 'unknown' ? 'unknown' : 'measured',
      }
      if (!validateRuntime('UsageFact', fact).ok || !validateRuntime('UsageMeasurement', dimensions).ok)
        throw new BudgetAuthorityFault('integrity', 'fixture original Usage fact is invalid')
      const prior = get<typeof fact>('usage-fact', fact.usageId)
      if (prior !== undefined && canonicalJsonDigest(prior) !== canonicalJsonDigest(fact))
        throw new BudgetAuthorityFault('integrity', 'immutable usage fact differs')
      if (prior === undefined) {
        if (!prepare) throw new BudgetAuthorityFault('integrity', 'original usage fact is missing')
        put('usage-fact', fact.usageId, fact)
      }
      return { authorityId: 'fixture-usage', usageId: fact.usageId, digest: canonicalJsonDigest(fact) }
    })
  }
  if (!get('usage-observation', 'selected'))
    put('usage-observation', 'selected', { value: measurement, actionId: 'a', attemptId: 'attempt-a' })
  usageRefs(true)
  const store: BudgetStore = {
    async transaction(ctx, body) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const result = body(tx)
        beforeCommit?.()
        check(ctx)
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
  }
  const account = (id: string, parentId: string | null, cap: string): BudgetAccount => ({
    ref: ref(id),
    parentId,
    currency: 'EUR',
    cap,
    held: '0',
    settled: '0',
    units: { token: { scale: 0, cap: '100', held: '0', settled: '0' } },
    quotas: { 'parallel-action': { cap: '1', held: '0' }, 'live-agent': { cap: '2', held: '0' } },
  })
  if (!get('account', 'root')) {
    put('account', 'root', account('root', null, '60'))
    put('account', 'leaf', account('leaf', 'root', '100'))
    for (const id of ['a', 'b', 'parent', 'child'])
      put('action', id, {
        attemptId: `attempt-${id}`,
        accountIds: ['leaf', 'root'],
        scopeIds: ['session-s', 'runtime-r'],
      })
  }
  return {
    file,
    operations: createBudgetReservations(store),
    tx,
    get,
    put,
    db,
    close: () => db.close(),
    time: (time: string) => {
      clock = time
    },
    revoke: () => {
      current = false
    },
    beforeCommit: (fn: () => void) => {
      beforeCommit = fn
    },
    usageRefs,
    measurement: (value: VerifiedSettlement, actionId = 'a') => {
      measurement = value
      put('usage-observation', 'selected', { value, actionId, attemptId: `attempt-${actionId}` })
      usageRefs(true)
    },
    reconciliation: (value: typeof reconcile) => {
      reconcile = value
    },
    complete: () => {
      completion = true
    },
    writes: () => Number((db.prepare('SELECT COUNT(*) AS n FROM audit').get() as { n: number }).n),
  }
}
function evidence() {
  const value = { original: 'verified-source' }
  return {
    kind: 'inline' as const,
    schema: { typeId: 'agh.test/completion@1', revision: 1, digest: canonicalJsonDigest(value) },
    value,
    digest: canonicalJsonDigest(value),
    bytes: Buffer.byteLength(JSON.stringify(value)),
  }
}

describe('persistent Budget authority rules', () => {
  it('arbitrates all ancestors, rolls back sibling denial, and replays the original reservation after cold reopen', async () => {
    const f = fixture()
    const first = await f.operations.reserve(request('a'), context)
    const results = await Promise.allSettled([
      f.operations.reserve(request('b'), context),
      f.operations.reserve(request('a'), context),
    ])
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: first })
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('40')
    expect(f.writes()).toBe(1)
    const file = f.file
    f.close()
    const cold = fixture(file)
    expect(await cold.operations.reserve(request('a'), context)).toEqual(first)
    expect(cold.writes()).toBe(1)
    await expect(cold.operations.reserve(request('a', '5', '50'), context)).rejects.toThrow(
      'different admitted input',
    )
    cold.close()
  })
  it('keeps genuine overspend and unique origins without discarding occurred usage', async () => {
    const f = fixture()
    const r = await f.operations.reserve(request('a'), context)
    f.measurement({
      sourceDigest: 'original-overrun',
      amount: money('80'),
      priceVersion: 'price-v1',
      units: [{ unit: 'token', value: '8' }],
      origins: ['request-a'],
      certainty: 'known',
    })
    const input = { reservationRef: r.reservation.ref, usageRefs: f.usageRefs() }
    const settled = await f.operations.settle(input, context)
    expect(settled.reservation.settledAmount).toEqual(money('80'))
    expect(settled.balance).toEqual(money('0'))
    expect(f.get<BudgetAccount>('account', 'root')).toMatchObject({ held: '0', settled: '80' })
    expect(await f.operations.settle(input, context)).toEqual(settled)
    expect(f.writes()).toBe(2)
    f.close()
  })
  it('does not release unknown holds because reservation expiry passed or lookup returned not found', async () => {
    const f = fixture()
    const r = await f.operations.reserve(request('a'), context)
    f.time('2100-01-01T00:00:00.000Z')
    f.measurement({
      sourceDigest: 'actual-ambiguous-send',
      amount: null,
      priceVersion: 'price-v1',
      units: [],
      origins: ['request-a'],
      certainty: 'unknown',
    })
    expect(
      (await f.operations.settle({ reservationRef: r.reservation.ref, usageRefs: f.usageRefs() }, context))
        .reservation.status,
    ).toBe('unknown')
    const input = { reservationRef: r.reservation.ref, evidenceRef: evidence() }
    expect((await f.operations.reconcile(input, context)).reservation.status).toBe('unknown')
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('40')
    f.reconciliation({ kind: 'not-executed', sourceDigest: 'genuine-not-executed' })
    const different = {
      ...input,
      evidenceRef: {
        ...evidence(),
        value: { original: 'proof-two' },
        digest: canonicalJsonDigest({ original: 'proof-two' }),
      },
    }
    expect((await f.operations.reconcile(different, context)).reservation.status).toBe('released')
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('0')
    f.close()
  })
  it('retains unknown amount as null while charging exact registered units', async () => {
    const f = fixture()
    f.put('profile', 'mode', 'bounded-units')
    const r = await f.operations.reserve(request('a', '4', null), context)
    expect(r.remaining).toBeNull()
    f.measurement({
      sourceDigest: 'bounded-units-only',
      amount: null,
      priceVersion: null,
      units: [{ unit: 'token', value: '6' }],
      origins: ['units-request'],
      certainty: 'known',
    })
    const settled = await f.operations.settle(
      { reservationRef: r.reservation.ref, usageRefs: f.usageRefs() },
      context,
    )
    expect(settled.reservation).toMatchObject({
      held: null,
      priceVersion: null,
      settledAmount: null,
      status: 'settled',
    })
    expect(f.get<BudgetAccount>('account', 'root')?.units.token).toMatchObject({ held: '0', settled: '6' })
    f.close()
  })
  it('allocates parent holds once and returns unexecuted child allocation without refunding the parent hold', async () => {
    const f = fixture()
    const parent = await f.operations.reserve(request('parent', '6', '60'), context)
    const child = await f.operations.reserve(request('child', '4', '40', parent.reservation.ref), context)
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('60')
    f.measurement(
      {
        sourceDigest: 'parent-source',
        amount: money('20'),
        priceVersion: 'price-v1',
        units: [{ unit: 'token', value: '2' }],
        origins: ['parent-request'],
        certainty: 'known',
      },
      'parent',
    )
    await expect(
      f.operations.settle({ reservationRef: parent.reservation.ref, usageRefs: f.usageRefs() }, context),
    ).rejects.toThrow('active children')
    f.reconciliation({ kind: 'not-executed', sourceDigest: 'child-never-sent' })
    await f.operations.reconcile({ reservationRef: child.reservation.ref, evidenceRef: evidence() }, context)
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('60')
    f.close()
  })
  it('persists ancestor quota ownership and requires actual completion before release', async () => {
    const f = fixture()
    const input = {
      actionRef: { existingActionId: 'a' },
      attemptId: 'attempt-a',
      dimensions: [{ name: 'parallel-action' as const, amount: 1 }],
    }
    const q = await f.operations.reserveQuota(input, context)
    await expect(
      f.operations.reserveQuota(
        { ...input, actionRef: { existingActionId: 'b' }, attemptId: 'attempt-b' },
        context,
      ),
    ).rejects.toThrow('quota is exhausted')
    const release = { reservationRef: q.ref, completionEvidence: evidence() }
    await expect(f.operations.releaseQuota(release, context)).rejects.toThrow('unproved')
    f.complete()
    const result = await f.operations.releaseQuota(release, context)
    expect(result.status).toBe('released')
    expect(await f.operations.releaseQuota(release, context)).toEqual(result)
    expect(f.get<BudgetAccount>('account', 'root')?.quotas['parallel-action']?.held).toBe('0')
    f.close()
  })
  it('rolls back the complete ancestor write set when current qualification is lost at the last fence', async () => {
    const f = fixture()
    f.beforeCommit(f.revoke)
    await expect(f.operations.reserve(request('a'), context)).rejects.toThrow('revoked')
    expect(f.get<BudgetAccount>('account', 'root')?.held).toBe('0')
    expect(f.get<BudgetAccount>('account', 'leaf')?.held).toBe('0')
    expect(f.writes()).toBe(0)
    f.close()
  })
  it('refuses implicit currencies, floating amounts, unknown unit precision and missing action sources', async () => {
    expect(exactQuantity('0.125', 3)).toBe(125n)
    expect(() => exactQuantity('0.125', 2)).toThrow()
    expect(() => exactQuantity('1e3', 0)).toThrow()
    expect(() => exactMoney(money('1.5'))).toThrow()
    const f = fixture()
    await expect(f.operations.reserve(request('a', '4', null), context)).rejects.toThrow(
      'trusted budget mode',
    )
    await expect(f.operations.reserve(request('unknown'), context)).rejects.toThrow('original action')
    await expect(
      f.operations.reserve({ ...request('a'), maxCost: { ...money('40'), currency: 'USD' } }, context),
    ).rejects.toThrow('currency differs')
    expect(f.writes()).toBe(0)
    f.close()
  })
})
