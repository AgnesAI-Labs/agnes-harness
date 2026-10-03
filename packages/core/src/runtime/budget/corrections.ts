import {
  type BudgetSettleRequest,
  type BudgetSettleResult,
  canonicalJsonDigest,
  type DomainObjectRef,
  validateRuntime,
} from '@agnes/protocol/runtime'
import {
  type BudgetAccount,
  BudgetAuthorityFault,
  exactMoney,
  exactQuantity,
  type VerifiedSettlement,
} from './reservations.js'

/** Fixed original event body; the digest is external to these bytes. */
export interface BudgetSettlementEvent {
  previous: string | null
  input: BudgetSettleRequest
  settlement: VerifiedSettlement
  result: BudgetSettleResult
  accountRefs: readonly DomainObjectRef[]
}
export interface BudgetSettlementSource {
  eventDigest: string
  event: BudgetSettlementEvent
}
const fail = (message: string): never => {
  throw new BudgetAuthorityFault('integrity', message)
}
export function verifiedSettlementEvent(source: BudgetSettlementSource): BudgetSettlementEvent {
  const value = validateRuntime('JsonValue', source.event)
  if (
    !value.ok ||
    !validateRuntime('Digest', source.eventDigest).ok ||
    canonicalJsonDigest(value.value) !== source.eventDigest ||
    !validateRuntime('BudgetSettleRequest', source.event.input).ok ||
    !validateRuntime('BudgetSettleResult', source.event.result).ok ||
    (source.event.previous !== null && !validateRuntime('Digest', source.event.previous).ok)
  )
    fail('Original settlement event bytes or full digest differ')
  return source.event
}
/** Pure delta: original hold was already released; other owners' balances are untouched. */
export function correctedBudgetAccounts(
  chain: readonly BudgetAccount[],
  previous: VerifiedSettlement,
  next: VerifiedSettlement,
): BudgetAccount[] {
  if (
    previous.certainty !== 'known' ||
    next.certainty !== 'known' ||
    previous.priceVersion !== next.priceVersion ||
    (previous.amount === null) !== (next.amount === null) ||
    previous.origins.length === 0 ||
    new Set(next.origins).size !== next.origins.length ||
    JSON.stringify([...previous.origins].sort()) !== JSON.stringify([...next.origins].sort())
  )
    fail('Correction changes original price, certainty or origin ownership')
  const oldMoney = previous.amount === null ? 0n : exactMoney(previous.amount),
    newMoney = next.amount === null ? 0n : exactMoney(next.amount)
  return chain.map((account) => {
    if (
      previous.amount !== null &&
      (account.currency !== previous.amount.currency || next.amount?.currency !== account.currency)
    )
      fail('Correction currency differs from original ancestor')
    const read = (actual: VerifiedSettlement): Map<string, bigint> => {
      const out = new Map<string, bigint>()
      for (const quantity of actual.units) {
        const unit = account.units[quantity.unit] ?? fail('Correction unit is unknown')
        if (out.has(quantity.unit)) fail('Correction unit is unknown or duplicated')
        out.set(quantity.unit, exactQuantity(quantity.value, unit.scale))
      }
      return out
    }
    const before = read(previous),
      after = read(next),
      units = { ...account.units }
    for (const name of new Set([...before.keys(), ...after.keys()])) {
      const unit = units[name]!
      if (!/^(0|[1-9]\d*)$/.test(unit.settled) || BigInt(unit.settled) < (before.get(name) ?? 0n))
        fail('Original unit charge is missing from ancestor')
      units[name] = {
        ...unit,
        settled: (BigInt(unit.settled) - (before.get(name) ?? 0n) + (after.get(name) ?? 0n)).toString(),
      }
    }
    if (!/^(0|[1-9]\d*)$/.test(account.settled) || BigInt(account.settled) < oldMoney)
      fail('Original money charge is missing from ancestor')
    return { ...account, settled: (BigInt(account.settled) - oldMoney + newMoney).toString(), units }
  })
}
