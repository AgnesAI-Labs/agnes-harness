import {
  type BudgetReserveRequest,
  canonicalJsonDigest,
  type DomainObjectRef,
  type JsonValue,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type BudgetAccount,
  type BudgetAdmission,
  BudgetAuthorityFault,
  exactMoney,
  exactQuantity,
  type ReservationState,
  type VerifiedSettlement,
} from './reservations.js'
export type BudgetFundingGraph = readonly {
  ref: DomainObjectRef
  parentId: string | null
  currency: string | null
  cap: string | null
  units: Readonly<Record<string, { scale: number; cap: string }>>
  quotas: Readonly<Record<string, { cap: string }>>
}[]
export interface BudgetFundingSnapshot {
  state: ReservationState
  graph: BudgetFundingGraph
  admissionSourceDigest: string
}
export interface BudgetFundingEvent {
  input: JsonValue
  result: JsonValue
  sourceDigest: string
  previous: readonly { ref: DomainObjectRef; digest: string | null }[]
  snapshots: readonly BudgetFundingSnapshot[]
  accounts: readonly BudgetAccount[]
}
export interface BudgetFundingSource {
  eventDigest: string
  event: BudgetFundingEvent
  snapshot: BudgetFundingSnapshot
}
export interface BudgetFundingAdmission {
  sourceDigest: string
  childActionId: string
  parentActionId: string
  parentReservationRef: DomainObjectRef
  parentGraphDigest: string
  childGraphDigest: string
  admissionSourceDigest: string
}
export interface BudgetFundingPorts {
  verifyFundingAdmission?(
    input: BudgetReserveRequest,
    child: BudgetAdmission,
    parent: BudgetFundingSnapshot,
    context: import('@agnes/extension-api/runtime').CallContext,
  ): BudgetFundingAdmission
  latestFunding?(reference: DomainObjectRef): BudgetFundingSource | undefined
  appendFundingEvent?(event: BudgetFundingEvent): string
}
const fail = (message: string): never => {
  throw new BudgetAuthorityFault('integrity', message)
}
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
export const fundingDigest = (x: unknown): string => {
  const parsed = validateRuntime('JsonValue', x)
  if (!parsed.ok) return fail('Funding source is not canonical JSON')
  return canonicalJsonDigest(parsed.value)
}
export function fundingGraph(chain: readonly BudgetAccount[]): BudgetFundingGraph {
  return chain.map((a) => ({
    ref: copy(a.ref),
    parentId: a.parentId,
    currency: a.currency,
    cap: a.cap,
    units: Object.fromEntries(Object.entries(a.units).map(([k, v]) => [k, { scale: v.scale, cap: v.cap }])),
    quotas: Object.fromEntries(Object.entries(a.quotas).map(([k, v]) => [k, { cap: v.cap }])),
  }))
}
export function verifiedFunding(
  source: BudgetFundingSource,
  actual: ReservationState,
): BudgetFundingSnapshot {
  if (
    !validateRuntime('Digest', source.eventDigest).ok ||
    fundingDigest(source.event) !== source.eventDigest ||
    fundingDigest(source.snapshot.state) !== fundingDigest(actual) ||
    !source.event.snapshots.some((s) => fundingDigest(s) === fundingDigest(source.snapshot))
  )
    fail('Original funding event or current state differs')
  const g = source.snapshot.graph
  if (
    g.length !== actual.accountIds.length ||
    g.some(
      (a, i) =>
        a.ref.id !== actual.accountIds[i] ||
        a.parentId !== (g[i + 1]?.ref.id ?? null) ||
        a.ref.authorityId !== actual.reservation.ref.authorityId,
    ) ||
    fundingDigest(g[0]?.ref) !== fundingDigest(actual.reservation.accountRef)
  )
    fail('Original funding graph is incomplete or changes owner')
  return copy(source.snapshot)
}
export function verifyFundingTransfer(
  input: BudgetReserveRequest,
  child: BudgetAdmission,
  parent: BudgetFundingSnapshot,
  graph: BudgetFundingGraph,
  proof: BudgetFundingAdmission,
): void {
  if (
    !validateRuntime('Digest', proof.sourceDigest).ok ||
    proof.childActionId !== child.actionId ||
    proof.parentActionId !== parent.state.reservation.actionId ||
    proof.admissionSourceDigest !== child.sourceDigest ||
    fundingDigest(proof.parentReservationRef) !== fundingDigest(input.parentReservationRef) ||
    proof.parentGraphDigest !== fundingDigest(parent.graph) ||
    proof.childGraphDigest !== fundingDigest(graph) ||
    parent.state.reservation.status !== 'held' ||
    parent.state.reservation.priceVersion !== input.priceVersion ||
    parent.state.reservation.ref.authorityId !== input.accountRef.authorityId
  )
    throw new BudgetAuthorityFault('denied', 'Actual Action funding source or original graph differs')
}
export function fundingCovered(parents: readonly BudgetFundingSnapshot[]): Set<string> {
  return new Set(parents.flatMap((p) => p.graph.map((a) => a.ref.id)))
}
function integer(v: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(v)) return fail('Funding amount is not exact nonnegative')
  return BigInt(v)
}
function subtract(
  state: ReservationState,
  money: string | null,
  units: Readonly<Record<string, string>>,
): void {
  if ((money === null) !== (state.moneyHeld === null)) fail('Funding mode changes')
  if (money !== null) {
    const left = integer(state.moneyHeld!) - integer(money)
    if (left < 0n) fail('Funding parent residual underflow')
    state.moneyHeld = left.toString()
  }
  for (const [name, value] of Object.entries(units)) {
    const left = integer(state.unitsHeld[name] ?? '0') - integer(value)
    if (left < 0n) fail('Funding unit residual underflow')
    state.unitsHeld[name] = left.toString()
  }
}
export function fundedTerminalAccounts(
  state: ReservationState,
  parents: readonly BudgetFundingSnapshot[],
  chain: readonly BudgetAccount[],
  all: readonly BudgetAccount[],
  charge: VerifiedSettlement | undefined,
): { accounts: BudgetAccount[]; parents: ReservationState[] } {
  const actual = new Set(chain.map((a) => a.ref.id)),
    covered = fundingCovered(parents),
    byId = new Map(all.map((a) => [a.ref.id, a])),
    ids = charge ? [...new Set([...actual, ...covered])] : [...actual].filter((id) => !covered.has(id))
  const changed = ids.map((id) => {
    const a = copy(byId.get(id) ?? fail('Funding ancestor disappears')),
      held = state.moneyHeld === null ? 0n : integer(state.moneyHeld),
      money = charge && actual.has(id) && charge.amount !== null ? exactMoney(charge.amount) : 0n
    if (integer(a.held) < held) fail('Funding account hold underflow')
    if (charge?.amount && actual.has(id) && a.currency !== charge.amount.currency)
      fail('Funding currency differs')
    const quantities = new Map<string, bigint>()
    if (charge && actual.has(id))
      for (const q of charge.units) {
        const unit = a.units[q.unit] ?? fail('Funding usage unit missing')
        if (quantities.has(q.unit)) fail('Duplicated funding usage unit')
        quantities.set(q.unit, exactQuantity(q.value, unit.scale))
      }
    const nextUnits = { ...a.units }
    for (const name of new Set([...Object.keys(state.unitsHeld), ...quantities.keys()])) {
      const u = a.units[name] ?? fail('Funding registered unit missing'),
        h = integer(state.unitsHeld[name] ?? '0')
      if (integer(u.held) < h) fail('Funding account unit hold underflow')
      Object.assign(nextUnits, {
        [name]: {
          ...u,
          held: (integer(u.held) - h).toString(),
          settled: (integer(u.settled) + (quantities.get(name) ?? 0n)).toString(),
        },
      })
    }
    return {
      ...a,
      units: nextUnits,
      held: (integer(a.held) - held).toString(),
      settled: (integer(a.settled) + money).toString(),
    }
  })
  const changedParents = parents.map((p) => copy(p.state))
  for (let i = 0; i < changedParents.length; i++) {
    const p = changedParents[i]!,
      child = i === 0 ? state : parents[i - 1]!.state,
      allocation = p.allocations[child.reservation.ref.id] ?? fail('Original funding allocation missing')
    if (
      i === 0 &&
      fundingDigest(allocation) !== fundingDigest({ money: state.moneyHeld, units: state.unitsHeld })
    )
      fail('Original child allocation differs')
    if (charge) {
      subtract(p, state.moneyHeld, state.unitsHeld)
      const row = { moneyHeld: allocation.money, unitsHeld: copy(allocation.units) } as Pick<
        ReservationState,
        'moneyHeld' | 'unitsHeld'
      >
      if (i === 0) delete p.allocations[child.reservation.ref.id]
      else {
        if (state.moneyHeld !== null) {
          const n = integer(row.moneyHeld!) - integer(state.moneyHeld)
          if (n < 0n) fail('Ancestor allocation underflow')
          row.moneyHeld = n.toString()
        }
        for (const [name, value] of Object.entries(state.unitsHeld)) {
          const n = integer(row.unitsHeld[name] ?? '0') - integer(value)
          if (n < 0n) fail('Ancestor unit allocation underflow')
          row.unitsHeld[name] = n.toString()
        }
        p.allocations[child.reservation.ref.id] = { money: row.moneyHeld, units: row.unitsHeld }
      }
    } else if (i === 0) delete p.allocations[child.reservation.ref.id]
  }
  return { accounts: changed, parents: changedParents }
}
