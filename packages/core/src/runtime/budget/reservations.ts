import type { CallContext } from '@agnes/extension-api/runtime'
import {
  type BudgetReconcileRequest,
  type BudgetReconcileResult,
  type BudgetReleaseQuotaRequest,
  type BudgetReservation,
  type BudgetReserveQuotaRequest,
  type BudgetReserveRequest,
  type BudgetReserveResult,
  type BudgetSettleRequest,
  type BudgetSettleResult,
  canonicalJsonDigest,
  type DomainObjectRef,
  type ExactQuantity,
  type Money,
  type QuotaReservation,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type BudgetSettlementEvent,
  type BudgetSettlementSource,
  correctedBudgetAccounts,
  verifiedSettlementEvent,
} from './corrections.js'
import {
  type BudgetFundingEvent,
  type BudgetFundingGraph,
  type BudgetFundingPorts,
  type BudgetFundingSnapshot,
  type BudgetFundingSource,
  fundedTerminalAccounts,
  fundingCovered,
  fundingDigest,
  fundingGraph,
  verifiedFunding,
  verifyFundingTransfer,
} from './funding.js'

export class BudgetAuthorityFault extends Error {
  constructor(
    readonly detail: 'invalid' | 'conflict' | 'denied' | 'insufficient' | 'integrity',
    message: string,
  ) {
    super(message)
  }
}
const fault = (detail: BudgetAuthorityFault['detail'], message: string): never => {
  throw new BudgetAuthorityFault(detail, message)
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const digest = (value: unknown) => {
  const parsed = validateRuntime('JsonValue', value)
  if (!parsed.ok) return fault('integrity', 'budget source is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}

/** Exact nonnegative decimals. Unit precision is supplied by the registered authority, not a caller. */
export function exactQuantity(value: string, scale: number): bigint {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value))
    fault('invalid', 'quantity is not a canonical nonnegative decimal')
  const [whole = '', fraction = ''] = value.split('.')
  if (fraction.length > scale || value.length > 8192) fault('invalid', 'quantity precision exceeds its unit')
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt((fraction || '0').padEnd(scale, '0'))
}
export function exactMoney(value: Money): bigint {
  if (!validateRuntime('Money', value).ok || !/^(0|[1-9]\d*)$/.test(value.units) || value.units.length > 8192)
    fault('invalid', 'money is not an exact nonnegative micro-unit amount')
  return BigInt(value.units)
}
export type BudgetAccount = Readonly<{
  ref: DomainObjectRef
  parentId: string | null
  currency: string | null
  cap: string | null
  held: string
  settled: string
  units: Readonly<Record<string, { scale: number; cap: string; held: string; settled: string }>>
  quotas: Readonly<Record<string, { cap: string; held: string }>>
}>
export type ReservationState = {
  reservation: BudgetReservation
  identity: string
  fingerprint: string
  accountIds: string[]
  moneyHeld: string | null
  unitsHeld: Record<string, string>
  parentId: string | null
  allocations: Record<string, { money: string | null; units: Record<string, string> }>
  /** New funding sources must never fall back to historical projection-only behavior. */
  fundingSourceRequired?: boolean
}
export type QuotaState = {
  reservation: QuotaReservation
  identity: string
  fingerprint: string
  accountIds: string[]
}
export type BudgetAdmission = Readonly<{
  identity: string
  actionId: string
  sourceDigest: string
  accountIds: readonly string[]
  scopeIds: readonly string[]
  reservationRef: DomainObjectRef
  expiresAt: string
  mode: 'bounded-units' | 'cost-hard'
}>
export type VerifiedSettlement = Readonly<{
  sourceDigest: string
  amount: Money | null
  priceVersion: string | null
  units: readonly ExactQuantity[]
  /** Actual origin identities, supplied by the original Usage authority. */
  origins: readonly string[]
  certainty: 'known' | 'unknown'
  /** Verified original Usage replacement; absence permits legacy one-shot sources only. */
  replacesEventDigest?: string | null
}>
/** Host-private capability over one actual durable Budget authority transaction. */
export interface BudgetTransaction extends BudgetFundingPorts {
  now(): string
  authorizeReserve(input: BudgetReserveRequest, context: CallContext): BudgetAdmission
  authorizeQuota(
    input: BudgetReserveQuotaRequest,
    context: CallContext,
  ): Omit<BudgetAdmission, 'mode' | 'expiresAt'>
  authorizeExisting(reference: DomainObjectRef, context: CallContext): void
  settlement(
    input: BudgetSettleRequest,
    reservation: BudgetReservation,
    context: CallContext,
  ): VerifiedSettlement
  reconciliation(
    input: BudgetReconcileRequest,
    reservation: BudgetReservation,
    context: CallContext,
  ):
    | { kind: 'unknown'; sourceDigest: string }
    | { kind: 'not-executed'; sourceDigest: string }
    | { kind: 'settled'; sourceDigest: string; settlement: VerifiedSettlement }
  quotaCompletion(input: BudgetReleaseQuotaRequest, reservation: QuotaReservation, context: CallContext): void
  account(id: string): BudgetAccount | undefined
  putAccount(account: BudgetAccount): void
  reservation(id: string): ReservationState | undefined
  putReservation(value: ReservationState): void
  quota(id: string): QuotaState | undefined
  putQuota(value: QuotaState): void
  replay(identity: string): { fingerprint: string; result: unknown } | undefined
  remember(identity: string, fingerprint: string, result: unknown): void
  origin(origin: string): string | undefined
  claimOrigin(origin: string, reservationId: string): void
  /** Original durable event chain capabilities; never inferred from projections. */
  latestSettlement?(reference: DomainObjectRef): BudgetSettlementSource | undefined
  appendSettlementSource?(event: BudgetSettlementEvent, expectedPrevious: string | null): string
  /** The concrete owner repeats this check directly before durable COMMIT, after all callbacks. */
  assertCurrent(context: CallContext): void
}
export interface BudgetStore {
  transaction<T>(context: CallContext, body: (tx: BudgetTransaction) => T): Promise<T>
}
function replay<T>(tx: BudgetTransaction, identity: string, fingerprint: string): T | undefined {
  const prior = tx.replay(identity)
  if (!prior) return undefined
  if (prior.fingerprint !== fingerprint) fault('conflict', 'budget identity has different admitted input')
  return clone(prior.result) as T
}
function accounts(tx: BudgetTransaction, ids: readonly string[], leaf: DomainObjectRef): BudgetAccount[] {
  if (!ids.length || ids.length > 10000 || new Set(ids).size !== ids.length)
    fault('integrity', 'account chain is incomplete or cyclic')
  const chain = ids.map((id) => tx.account(id) ?? fault('integrity', 'account ancestor is missing'))
  if (chain[0]?.ref.id !== leaf.id || digest(chain[0]?.ref) !== digest(leaf))
    fault('conflict', 'account reference is stale')
  for (let i = 0; i < chain.length; i++) {
    const account = chain[i]!
    if (account.parentId !== (chain[i + 1]?.ref.id ?? null) || account.ref.authorityId !== leaf.authorityId)
      fault('integrity', 'account ancestor authority or parent differs')
    for (const n of [account.held, account.settled, ...(account.cap === null ? [] : [account.cap])])
      if (!/^(0|[1-9]\d*)$/.test(n)) fault('integrity', 'account amount is invalid')
  }
  return chain.map(clone)
}
function quantities(input: readonly ExactQuantity[], account: BudgetAccount): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of input) {
    const unit = account.units[item.unit] ?? fault('invalid', 'unknown measurement unit')
    if (Object.hasOwn(out, item.unit)) fault('invalid', 'unknown or duplicate measurement unit')
    out[item.unit] = exactQuantity(item.value, unit.scale).toString()
  }
  return out
}
function balance(account: BudgetAccount): Money | null {
  if (account.cap === null || account.currency === null) return null
  const n = BigInt(account.cap) - BigInt(account.held) - BigInt(account.settled)
  // Actual debt remains in settled; the public available balance cannot claim spendable credit.
  return { currency: account.currency, scale: 6, units: (n < 0n ? 0n : n).toString() }
}
function effectiveBalance(tx: BudgetTransaction, ids: readonly string[]): Money | null {
  const values = ids.map((id) => balance(tx.account(id) ?? fault('integrity', 'account disappeared')))
  if (values.some((value) => value === null)) return null
  const first = values[0] ?? fault('integrity', 'balance chain is empty')
  if (values.some((value) => value!.currency !== first.currency))
    fault('integrity', 'ancestor currencies differ')
  return {
    ...first,
    units: values
      .reduce((n, value) => (BigInt(value!.units) < n ? BigInt(value!.units) : n), BigInt(first.units))
      .toString(),
  }
}
type FundingPrior = { own?: BudgetFundingSource; parents: BudgetFundingSource[] }
function fundingPrior(tx: BudgetTransaction, state: ReservationState): FundingPrior | undefined {
  if (!tx.latestFunding || !tx.appendFundingEvent || !tx.verifyFundingAdmission) {
    if (state.fundingSourceRequired) fault('denied', 'original funding source capability missing')
    return undefined
  }
  const own = tx.latestFunding(state.reservation.ref)
  if (!own) {
    if (state.fundingSourceRequired) fault('denied', 'original funding event missing')
    return undefined
  }
  verifiedFunding(own, state)
  const parents: BudgetFundingSource[] = [],
    seen = new Set([state.reservation.ref.id])
  let id = state.parentId
  while (id !== null) {
    if (seen.has(id) || seen.size > 10000) fault('integrity', 'funding lineage cycle')
    seen.add(id)
    const parent = tx.reservation(id) ?? fault('integrity', 'funding parent source missing'),
      source =
        tx.latestFunding(parent.reservation.ref) ?? fault('denied', 'original funding parent event missing')
    verifiedFunding(source, parent)
    parents.push(clone(source))
    id = parent.parentId
  }
  return { own: clone(own), parents }
}
function recordFunding(
  tx: BudgetTransaction,
  state: ReservationState,
  graph: BudgetFundingGraph,
  admissionSourceDigest: string,
  prior: FundingPrior,
  input: unknown,
  result: unknown,
  sourceDigest: string,
): void {
  const snapshots: BudgetFundingSnapshot[] = [
    { state: clone(state), graph: clone(graph), admissionSourceDigest },
    ...prior.parents.map((p) => ({
      ...clone(p.snapshot),
      state: clone(
        tx.reservation(p.snapshot.state.reservation.ref.id) ??
          fault('integrity', 'funding after-image missing'),
      ),
    })),
  ]
  const parse = (value: unknown) => {
    const json = validateRuntime('JsonValue', value)
    return json.ok ? json.value : fault('integrity', 'funding after-image is not canonical JSON')
  }
  const event: BudgetFundingEvent = {
    input: parse(input),
    result: parse(result),
    sourceDigest,
    previous: [
      { ref: state.reservation.ref, digest: prior.own?.eventDigest ?? null },
      ...prior.parents.map((p) => ({ ref: p.snapshot.state.reservation.ref, digest: p.eventDigest })),
    ],
    snapshots,
    accounts: [...new Set(snapshots.flatMap((p) => p.state.accountIds))].map((id) =>
      clone(tx.account(id) ?? fault('integrity', 'funding ancestor missing')),
    ),
  }
  const expected = fundingDigest(event),
    actual = tx.appendFundingEvent!(clone(event))
  if (expected !== actual) fault('integrity', 'funding append full digest differs')
}
function adjust(
  tx: BudgetTransaction,
  state: ReservationState,
  actual: VerifiedSettlement | undefined,
): BudgetAccount[] {
  const chain = accounts(tx, state.accountIds, state.reservation.accountRef),
    original = fundingPrior(tx, state)
  if (original) {
    const parents = original.parents.map((p) => p.snapshot),
      all = [...new Set([...state.accountIds, ...parents.flatMap((p) => p.state.accountIds)])].map(
        (id) => tx.account(id) ?? fault('integrity', 'funding ancestor missing'),
      ),
      changed = fundedTerminalAccounts(state, parents, chain, all, actual)
    for (const account of changed.accounts) tx.putAccount(account)
    for (const parent of changed.parents) tx.putReservation(parent)
    return changed.accounts
  }
  for (const account of chain) {
    const held = state.moneyHeld === null ? 0n : BigInt(state.moneyHeld)
    if (BigInt(account.held) < held) fault('integrity', 'held account is below its reservation')
    const charge = actual?.amount === null || actual?.amount === undefined ? 0n : exactMoney(actual.amount)
    if (actual?.amount && account.currency !== actual.amount.currency)
      fault('invalid', 'settlement currency differs')
    const usage = actual ? quantities(actual.units, account) : {}
    const units = { ...clone(account.units) }
    for (const unit of new Set([...Object.keys(state.unitsHeld), ...Object.keys(usage)])) {
      const row = units[unit] ?? fault('integrity', 'reservation unit disappeared')
      const h = BigInt(state.unitsHeld[unit] ?? '0')
      if (BigInt(row.held) < h) fault('integrity', 'unit hold is below its reservation')
      units[unit] = {
        ...row,
        held: (BigInt(row.held) - h).toString(),
        settled: (BigInt(row.settled) + BigInt(usage[unit] ?? '0')).toString(),
      }
    }
    tx.putAccount({
      ...account,
      held: (BigInt(account.held) - held).toString(),
      settled: (BigInt(account.settled) + charge).toString(),
      units,
    })
  }
  if (state.parentId !== null) {
    const parent = tx.reservation(state.parentId) ?? fault('integrity', 'funding parent is missing')
    const allocation =
      parent.allocations[state.reservation.ref.id] ?? fault('integrity', 'parent allocation is missing')
    if (digest(allocation) !== digest({ money: state.moneyHeld, units: state.unitsHeld }))
      fault('integrity', 'parent allocation differs')
    const next = clone(parent)
    if (next.moneyHeld !== null)
      next.moneyHeld = (BigInt(next.moneyHeld) - BigInt(state.moneyHeld ?? '0')).toString()
    for (const [unit, value] of Object.entries(state.unitsHeld))
      next.unitsHeld[unit] = (BigInt(next.unitsHeld[unit] ?? '0') - BigInt(value)).toString()
    delete next.allocations[state.reservation.ref.id]
    tx.putReservation(next)
  }
  return chain
}
function existing(tx: BudgetTransaction, ref: DomainObjectRef, context: CallContext): ReservationState {
  tx.authorizeExisting(ref, context)
  const state = tx.reservation(ref.id) ?? fault('invalid', 'reservation is absent')
  if (digest(state.reservation.ref) !== digest(ref)) fault('conflict', 'reservation reference differs')
  return clone(state)
}
export function createBudgetReservations(store: BudgetStore) {
  return {
    reserve(input: BudgetReserveRequest, context: CallContext): Promise<BudgetReserveResult> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('BudgetReserveRequest', input).ok) fault('invalid', 'invalid reserve request')
        const admitted = tx.authorizeReserve(input, context)
        const fingerprint = digest({ input, sourceDigest: admitted.sourceDigest })
        const prior = replay<BudgetReserveResult>(tx, `reserve:${admitted.identity}`, fingerprint)
        if (prior) return prior
        if (
          (input.maxCost === null) !== (input.priceVersion === null) ||
          (admitted.mode === 'cost-hard' && input.maxCost === null) ||
          (admitted.mode === 'bounded-units' && input.maxCost !== null) ||
          !input.unitsByKind.length
        )
          fault('invalid', 'reservation does not match its trusted budget mode')
        if (
          !Number.isFinite(Date.parse(admitted.expiresAt)) ||
          !Number.isFinite(Date.parse(tx.now())) ||
          Date.parse(admitted.expiresAt) <= Date.parse(tx.now())
        )
          fault('denied', 'new reservation dispatch permission is expired')
        const chain = accounts(tx, admitted.accountIds, input.accountRef)
        const held = input.maxCost === null ? null : exactMoney(input.maxCost).toString()
        const units = quantities(input.unitsByKind, chain[0]!)
        for (const account of chain) {
          if (digest(quantities(input.unitsByKind, account)) !== digest(units))
            fault('integrity', 'ancestor unit precision differs')
          if (input.maxCost && account.currency !== input.maxCost.currency)
            fault('invalid', 'account currency differs')
        }
        let parent: ReservationState | undefined,
          parentSources: BudgetFundingSource[] = []
        const modern = !!(tx.latestFunding && tx.appendFundingEvent && tx.verifyFundingAdmission)
        let covered = new Set<string>()
        if (input.parentReservationRef !== null) {
          parent = existing(tx, input.parentReservationRef, context)
          if (parent.fundingSourceRequired && !modern)
            fault('denied', 'original funding source capability missing')
          if (modern) {
            const source =
                tx.latestFunding!(parent.reservation.ref) ??
                fault('denied', 'original funding reserve event missing'),
              snapshot = verifiedFunding(source, parent),
              lineage = fundingPrior(tx, parent) ?? fault('denied', 'funding lineage unavailable'),
              proof = tx.verifyFundingAdmission!(clone(input), clone(admitted), clone(snapshot), context)
            verifyFundingTransfer(input, admitted, snapshot, fundingGraph(chain), proof)
            parentSources = [clone(source), ...lineage.parents]
            covered = fundingCovered(parentSources.map((p) => p.snapshot))
            for (const p of parentSources) {
              const oldChain = accounts(
                tx,
                p.snapshot.state.accountIds,
                p.snapshot.state.reservation.accountRef,
              )
              if (fundingDigest(fundingGraph(oldChain)) !== fundingDigest(p.snapshot.graph))
                fault('denied', 'original funding graph changed')
              for (const [unit] of Object.entries(units))
                if (p.snapshot.graph[0]?.units[unit]?.scale !== chain[0]?.units[unit]?.scale)
                  fault('integrity', 'funding unit registry differs')
            }
          } else if (
            parent.reservation.status !== 'held' ||
            digest(parent.accountIds) !== digest(admitted.accountIds)
          )
            fault('denied', 'parent reservation does not fund this exact account chain')
          const allocations = Object.values(parent.allocations)
          const allocatedMoney = allocations.reduce((n, row) => n + BigInt(row.money ?? '0'), 0n)
          if (
            (held === null) !== (parent.moneyHeld === null) ||
            (held !== null && allocatedMoney + BigInt(held) > BigInt(parent.moneyHeld!))
          )
            fault('insufficient', 'parent reservation is exhausted')
          for (const [unit, value] of Object.entries(units)) {
            const allocated = allocations.reduce((n, row) => n + BigInt(row.units[unit] ?? '0'), 0n)
            if (allocated + BigInt(value) > BigInt(parent.unitsHeld[unit] ?? '0'))
              fault('insufficient', 'parent unit reservation is exhausted')
          }
        }
        if (!parent || modern) {
          for (const account of chain.filter((a) => !covered.has(a.ref.id))) {
            if (
              held !== null &&
              (account.cap === null ||
                BigInt(account.held) + BigInt(account.settled) + BigInt(held) > BigInt(account.cap))
            )
              fault('insufficient', 'ancestor monetary budget is exhausted')
            const nextUnits = { ...clone(account.units) }
            for (const [unit, value] of Object.entries(units)) {
              const row = nextUnits[unit]!
              if (BigInt(row.held) + BigInt(row.settled) + BigInt(value) > BigInt(row.cap))
                fault('insufficient', 'ancestor unit budget is exhausted')
              nextUnits[unit] = { ...row, held: (BigInt(row.held) + BigInt(value)).toString() }
            }
            tx.putAccount({
              ...account,
              held: (BigInt(account.held) + BigInt(held ?? '0')).toString(),
              units: nextUnits,
            })
          }
        }
        if (tx.reservation(admitted.reservationRef.id))
          fault('conflict', 'reservation identity already exists')
        const reservation: BudgetReservation = {
          ref: admitted.reservationRef,
          actionId: admitted.actionId,
          attemptId: input.attemptId,
          accountRef: input.accountRef,
          parentReservationRef: input.parentReservationRef,
          scopeIds: [...admitted.scopeIds],
          unitsByKind: clone(input.unitsByKind),
          held: clone(input.maxCost),
          priceVersion: input.priceVersion,
          status: 'held',
          revision: 1,
          expiresAt: admitted.expiresAt,
          settledAmount: null,
          usageRefs: [],
        }
        if (!validateRuntime('BudgetReservation', reservation).ok)
          fault('integrity', 'owner reservation does not match official schema')
        tx.putReservation({
          reservation,
          identity: admitted.identity,
          fingerprint,
          accountIds: [...admitted.accountIds],
          moneyHeld: held,
          unitsHeld: units,
          parentId: parent?.reservation.ref.id ?? null,
          allocations: {},
          ...(modern ? { fundingSourceRequired: true } : {}),
        })
        if (parent) {
          const next = clone(parent)
          next.allocations[reservation.ref.id] = { money: held, units }
          tx.putReservation(next)
        }
        const result = {
          reservation,
          remaining: held === null ? null : effectiveBalance(tx, admitted.accountIds),
        }
        if (modern)
          recordFunding(
            tx,
            tx.reservation(reservation.ref.id)!,
            fundingGraph(chain),
            admitted.sourceDigest,
            { parents: parentSources },
            input,
            result,
            admitted.sourceDigest,
          )
        tx.remember(`reserve:${admitted.identity}`, fingerprint, result)
        tx.assertCurrent(context)
        return clone(result)
      })
    },
    settle(input: BudgetSettleRequest, context: CallContext): Promise<BudgetSettleResult> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('BudgetSettleRequest', input).ok) fault('invalid', 'invalid settle request')
        const state = existing(tx, input.reservationRef, context)
        const priorFunding = fundingPrior(tx, state)
        const actual = clone(tx.settlement(input, state.reservation, context))
        if (actual.priceVersion !== state.reservation.priceVersion)
          fault('conflict', 'settlement price version differs from original reservation')
        const legacyKey = `settle:${state.reservation.ref.id}`,
          fingerprint = digest({ input, sourceDigest: actual.sourceDigest }),
          legacy = tx.replay(legacyKey),
          hasSource =
            typeof tx.latestSettlement === 'function' && typeof tx.appendSettlementSource === 'function',
          key = hasSource ? `settle-event:${state.reservation.ref.id}:${fingerprint}` : legacyKey
        if (legacy?.fingerprint === fingerprint) return clone(legacy.result) as BudgetSettleResult
        const prior = replay<BudgetSettleResult>(tx, key, fingerprint)
        if (prior) return prior
        const foundSource = hasSource ? tx.latestSettlement!(input.reservationRef) : undefined,
          source = foundSource ? clone(foundSource) : undefined,
          original = source ? verifiedSettlementEvent(source) : undefined,
          replacement = actual.replacesEventDigest ?? null,
          correcting = state.reservation.status === 'settled'
        if (correcting && actual.certainty !== 'known')
          fault('conflict', 'known settlement cannot revert to unknown')
        if (
          Object.keys(state.allocations).length ||
          !['held', 'unknown', 'settled'].includes(state.reservation.status)
        )
          fault('conflict', 'reservation cannot settle with active children or terminal state')
        if (correcting || source) {
          if (
            !source ||
            !original ||
            replacement !== source.eventDigest ||
            digest([...original.settlement.origins].sort()) !== digest([...actual.origins].sort()) ||
            digest(original.result.reservation) !== digest(state.reservation) ||
            digest(original.accountRefs) !==
              digest(accounts(tx, state.accountIds, state.reservation.accountRef).map((a) => a.ref))
          )
            fault('conflict', 'replacement does not name the exact original settlement event')
        } else if (replacement !== null) fault('conflict', 'replacement names an absent original event')
        if (new Set(actual.origins).size !== actual.origins.length || !actual.origins.length)
          fault('integrity', 'settlement origin source is incomplete')
        for (const origin of actual.origins)
          if (tx.origin(origin) !== undefined && (tx.origin(origin) !== state.reservation.ref.id || !source))
            fault('conflict', 'usage origin already settled')
        if (actual.certainty === 'unknown') {
          state.reservation = {
            ...state.reservation,
            status: 'unknown',
            revision: state.reservation.revision + 1,
            usageRefs: clone(input.usageRefs),
          }
        } else {
          if ((state.moneyHeld === null) !== (actual.amount === null))
            fault('invalid', 'settlement cannot invent or discard a known price')
          if (correcting) {
            const chain = accounts(tx, state.accountIds, state.reservation.accountRef)
            for (const account of correctedBudgetAccounts(chain, original!.settlement, actual))
              tx.putAccount(account)
          } else adjust(tx, state, actual)
          state.reservation = {
            ...state.reservation,
            status: 'settled',
            revision: state.reservation.revision + 1,
            settledAmount: actual.amount,
            usageRefs: clone(input.usageRefs),
          }
          for (const origin of actual.origins)
            if (tx.origin(origin) === undefined) tx.claimOrigin(origin, state.reservation.ref.id)
        }
        for (const origin of actual.origins)
          if (tx.origin(origin) === undefined) tx.claimOrigin(origin, state.reservation.ref.id)
        tx.putReservation(state)
        const result = {
          reservation: state.reservation,
          balance: state.moneyHeld === null ? null : effectiveBalance(tx, state.accountIds),
        }
        if (hasSource) {
          const event: BudgetSettlementEvent = {
            previous: source?.eventDigest ?? null,
            input: clone(input),
            settlement: clone(actual),
            result: clone(result),
            accountRefs: accounts(tx, state.accountIds, state.reservation.accountRef).map((a) => a.ref),
          }
          const expectedEventDigest = digest(event),
            eventDigest = tx.appendSettlementSource!(clone(event), event.previous)
          if (eventDigest !== expectedEventDigest)
            fault('integrity', 'immutable append returned another full event digest')
          verifiedSettlementEvent({ eventDigest, event })
        }
        if (priorFunding?.own)
          recordFunding(
            tx,
            state,
            priorFunding.own.snapshot.graph,
            priorFunding.own.snapshot.admissionSourceDigest,
            priorFunding,
            input,
            result,
            actual.sourceDigest,
          )
        tx.remember(key, fingerprint, result)
        tx.assertCurrent(context)
        return clone(result)
      })
    },
    reconcile(input: BudgetReconcileRequest, context: CallContext): Promise<BudgetReconcileResult> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('BudgetReconcileRequest', input).ok)
          fault('invalid', 'invalid reconcile request')
        const state = existing(tx, input.reservationRef, context)
        const priorFunding = fundingPrior(tx, state)
        const evidence = tx.reconciliation(input, state.reservation, context)
        const key = `reconcile:${state.reservation.ref.id}:${digest(input.evidenceRef)}`,
          fingerprint = digest({ input, evidence })
        const prior = replay<BudgetReconcileResult>(tx, key, fingerprint)
        if (prior) return prior
        if (!['held', 'unknown'].includes(state.reservation.status) || Object.keys(state.allocations).length)
          fault('conflict', 'reservation cannot reconcile this state')
        if (evidence.kind === 'settled') {
          const actual = clone(evidence.settlement)
          if (actual.priceVersion !== state.reservation.priceVersion)
            fault('conflict', 'reconciliation price version differs from original reservation')
          if (
            actual.certainty !== 'known' ||
            !actual.origins.length ||
            new Set(actual.origins).size !== actual.origins.length ||
            (state.moneyHeld === null) !== (actual.amount === null)
          )
            fault('integrity', 'reconciliation settlement is not complete')
          for (const origin of actual.origins)
            if (tx.origin(origin) !== undefined && tx.origin(origin) !== state.reservation.ref.id)
              fault('conflict', 'origin belongs to another settlement')
          adjust(tx, state, actual)
          for (const origin of actual.origins)
            if (tx.origin(origin) === undefined) tx.claimOrigin(origin, state.reservation.ref.id)
          state.reservation = {
            ...state.reservation,
            status: 'settled',
            settledAmount: actual.amount,
            revision: state.reservation.revision + 1,
          }
        } else if (evidence.kind === 'not-executed') {
          if (priorFunding) adjust(tx, state, undefined)
          else if (state.parentId !== null) {
            const parent = tx.reservation(state.parentId) ?? fault('integrity', 'parent is absent')
            if (!parent.allocations[state.reservation.ref.id])
              fault('integrity', 'parent allocation is absent')
            const next = clone(parent)
            delete next.allocations[state.reservation.ref.id]
            tx.putReservation(next)
          } else adjust(tx, state, undefined)
          state.reservation = {
            ...state.reservation,
            status: 'released',
            revision: state.reservation.revision + 1,
          }
        } else
          state.reservation = {
            ...state.reservation,
            status: 'unknown',
            revision: state.reservation.revision + 1,
          }
        tx.putReservation(state)
        const result = {
          reservation: state.reservation,
          balance: state.moneyHeld === null ? null : effectiveBalance(tx, state.accountIds),
        }
        if (priorFunding?.own)
          recordFunding(
            tx,
            state,
            priorFunding.own.snapshot.graph,
            priorFunding.own.snapshot.admissionSourceDigest,
            priorFunding,
            input,
            result,
            evidence.sourceDigest,
          )
        tx.remember(key, fingerprint, result)
        tx.assertCurrent(context)
        return clone(result)
      })
    },
    reserveQuota(input: BudgetReserveQuotaRequest, context: CallContext): Promise<QuotaReservation> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('BudgetReserveQuotaRequest', input).ok) fault('invalid', 'invalid quota request')
        const admitted = tx.authorizeQuota(input, context)
        const fingerprint = digest({ input, sourceDigest: admitted.sourceDigest }),
          key = `quota:${admitted.identity}`
        const prior = replay<QuotaReservation>(tx, key, fingerprint)
        if (prior) return prior
        const leaf = tx.account(admitted.accountIds[0] ?? '') ?? fault('integrity', 'quota account is absent')
        const chain = accounts(tx, admitted.accountIds, leaf.ref)
        if (
          !input.dimensions.length ||
          new Set(input.dimensions.map((d) => d.name)).size !== input.dimensions.length
        )
          fault('invalid', 'quota dimensions are empty or duplicate')
        for (const account of chain) {
          const quotas = { ...clone(account.quotas) }
          for (const dimension of input.dimensions) {
            const row = quotas[dimension.name] ?? fault('denied', 'quota dimension is not authorized')
            if (BigInt(row.held) + BigInt(dimension.amount) > BigInt(row.cap))
              fault('insufficient', 'ancestor quota is exhausted')
            quotas[dimension.name] = {
              ...row,
              held: (BigInt(row.held) + BigInt(dimension.amount)).toString(),
            }
          }
          tx.putAccount({ ...account, quotas })
        }
        if (tx.quota(admitted.reservationRef.id)) fault('conflict', 'quota identity exists')
        const reservation: QuotaReservation = {
          ref: admitted.reservationRef,
          actionId: admitted.actionId,
          attemptId: input.attemptId,
          scopeIds: [...admitted.scopeIds],
          dimensions: clone(input.dimensions),
          status: 'held',
          revision: 1,
        }
        if (!validateRuntime('QuotaReservation', reservation).ok)
          fault('integrity', 'quota owner output is invalid')
        tx.putQuota({
          reservation,
          identity: admitted.identity,
          fingerprint,
          accountIds: [...admitted.accountIds],
        })
        tx.remember(key, fingerprint, reservation)
        tx.assertCurrent(context)
        return clone(reservation)
      })
    },
    releaseQuota(input: BudgetReleaseQuotaRequest, context: CallContext): Promise<QuotaReservation> {
      return store.transaction(context, (tx) => {
        if (!validateRuntime('BudgetReleaseQuotaRequest', input).ok)
          fault('invalid', 'invalid quota completion')
        tx.authorizeExisting(input.reservationRef, context)
        const state = clone(tx.quota(input.reservationRef.id) ?? fault('invalid', 'quota is absent'))
        if (digest(state.reservation.ref) !== digest(input.reservationRef))
          fault('conflict', 'quota reference differs')
        tx.quotaCompletion(input, state.reservation, context)
        const key = `release-quota:${state.reservation.ref.id}`,
          fingerprint = digest(input)
        const prior = replay<QuotaReservation>(tx, key, fingerprint)
        if (prior) return prior
        if (state.reservation.status !== 'held') fault('conflict', 'quota is already terminal')
        const leaf = tx.account(state.accountIds[0] ?? '') ?? fault('integrity', 'quota account is absent')
        for (const account of accounts(tx, state.accountIds, leaf.ref)) {
          const quotas = { ...clone(account.quotas) }
          for (const dimension of state.reservation.dimensions) {
            const row = quotas[dimension.name] ?? fault('integrity', 'quota dimension disappeared')
            if (BigInt(row.held) < BigInt(dimension.amount))
              fault('integrity', 'quota occupancy is below its reservation')
            quotas[dimension.name] = {
              ...row,
              held: (BigInt(row.held) - BigInt(dimension.amount)).toString(),
            }
          }
          tx.putAccount({ ...account, quotas })
        }
        state.reservation = {
          ...state.reservation,
          status: 'released',
          revision: state.reservation.revision + 1,
        }
        tx.putQuota(state)
        tx.remember(key, fingerprint, state.reservation)
        tx.assertCurrent(context)
        return clone(state.reservation)
      })
    },
  }
}
