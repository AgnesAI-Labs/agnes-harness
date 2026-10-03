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
import { afterEach } from 'vitest'
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
} from '../../../src/runtime/budget/reservations.js'

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
export const budgetContext: CallContext = {
  principalRef: 'actor',
  scope: { kind: 'session', installationId: 'i', runtimeId: 'r', workspaceId: 'w', sessionId: 's' },
  bindingId: 'budget-binding',
  invocationId: 'invocation',
  deadline: '2199-01-01T00:00:00.000Z',
  traceRef: 'trace',
  authorizationRef: 'auth',
  signal: new AbortController().signal,
}
export function budgetRequest(
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
export function budgetFixture(path?: string) {
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
      ctx.bindingId !== budgetContext.bindingId ||
      ctx.authorizationRef !== budgetContext.authorizationRef ||
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
    reconciliation: (input, reservation, ctx) => {
      check(ctx)
      const original = get<{
        scope: CallContext['scope']
        reservationId: string
        value: ReturnType<BudgetTransaction['reconciliation']>
        reference: typeof input.evidenceRef
      }>('reconciliation-proof', canonicalJsonDigest(input.evidenceRef))
      if (
        !original ||
        original.reservationId !== reservation.ref.id ||
        canonicalJsonDigest(original.scope) !== canonicalJsonDigest(ctx.scope) ||
        canonicalJsonDigest(original.reference) !== canonicalJsonDigest(input.evidenceRef)
      )
        throw new BudgetAuthorityFault('denied', 'original reconciliation evidence is missing')
      return original.value
    },
    quotaCompletion: (input, reservation, ctx) => {
      check(ctx)
      const original = get<{
        scope: CallContext['scope']
        reservationId: string
        reference: typeof input.completionEvidence
      }>('quota-completion-proof', canonicalJsonDigest(input.completionEvidence))
      if (
        !original ||
        original.reservationId !== reservation.ref.id ||
        canonicalJsonDigest(original.scope) !== canonicalJsonDigest(ctx.scope) ||
        canonicalJsonDigest(original.reference) !== canonicalJsonDigest(input.completionEvidence)
      )
        throw new BudgetAuthorityFault('denied', 'original execution completion evidence is missing')
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
  const issueProof = (
    kind: 'reconciliation-proof' | 'quota-completion-proof',
    reservationId: string,
    value: unknown,
  ) => {
    const document = {
      $id: 'https://example.invalid/budget-proof.json',
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'reservationId', 'proofId'],
      properties: {
        kind: { enum: ['reconciliation-proof', 'quota-completion-proof'] },
        reservationId: { type: 'string' },
        proofId: { type: 'string' },
      },
    }
    const body = {
      kind,
      reservationId,
      proofId: canonicalJsonDigest(validateRuntime('JsonValue', value).ok ? JSON.parse(jcs(value)) : null),
    }
    const reference = {
      kind: 'inline' as const,
      schema: { typeId: 'agh.test/budget-proof@1', revision: 1, digest: canonicalJsonDigest(document) },
      value: body,
      digest: canonicalJsonDigest(body),
      bytes: Buffer.byteLength(jcs(body)),
    }
    put(kind, canonicalJsonDigest(reference), { scope: budgetContext.scope, reservationId, value, reference })
    return reference
  }
  return {
    file,
    store,
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
    reconciliationProof: (reservationId: string, value: ReturnType<BudgetTransaction['reconciliation']>) =>
      issueProof('reconciliation-proof', reservationId, value),
    quotaCompletionProof: (reservationId: string) =>
      issueProof('quota-completion-proof', reservationId, {
        executedLocally: false,
        transferredToVerifiedOwner: false,
        completed: true,
      }),
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
