import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, validateRuntime } from '@agnes/protocol/runtime'
import { refused } from '../trace/provider-support.js'

/** Trusted adapters consume selected C33/C32 public methods; no pricing fallback. */
export interface BillingAccountingPorts {
  readUsage(reference: W.UsageFactRef, context: CallContext): Promise<Outcome<W.UsageFact>>
  reservation(input: W.BillingPostRequest, context: CallContext): Promise<Outcome<W.DomainObjectRef>>
  settle(input: W.BudgetSettleRequest, context: CallContext): Promise<Outcome<W.BudgetSettleResult>>
}
export async function settleBillingUsage(
  ports: BillingAccountingPorts,
  input: W.BillingPostRequest,
  quote: W.PriceQuote,
  context: CallContext,
): Promise<Outcome<string[]>> {
  const facts: W.UsageFact[] = [],
    origins: string[] = []
  for (const reference of input.usageRefs) {
    if (context.signal.aborted) return refused('denied', 'permission_absent')
    const result = await ports.readUsage(reference, context)
    if (!result.ok) return result
    const parsed = validateRuntime('UsageFact', result.value)
    if (
      !parsed.ok ||
      parsed.value.usageId !== reference.usageId ||
      canonicalJsonDigest(parsed.value) !== reference.digest
    )
      return refused('conflict', 'billing_usage_source')
    const fact = structuredClone(parsed.value)
    const origin = canonicalJsonDigest({
      authorityId: reference.authorityId,
      actionId: fact.actionId,
      attemptId: fact.attemptId,
      externalRequest: { system: fact.externalRequest.system, requestId: fact.externalRequest.requestId },
    })
    facts.push(fact)
    origins.push(origin)
  }
  if (new Set(origins).size !== origins.length) return refused('conflict', 'idempotency_conflict')
  const reference = await ports.reservation(input, context)
  if (!reference.ok) return reference
  if (context.signal.aborted) return refused('denied', 'permission_absent')
  const result = await ports.settle({ reservationRef: reference.value, usageRefs: input.usageRefs }, context)
  if (!result.ok) return result
  if (facts.some((fact) => fact.certainty === 'unknown'))
    return refused('unknown_effect', 'billing_usage_unknown')
  const parsed = validateRuntime('BudgetSettleResult', result.value)
  if (!parsed.ok) return refused('conflict', 'billing_settlement_source')
  const reservation = parsed.value.reservation
  if (reservation.status !== 'settled' || reservation.settledAmount === null)
    return refused('unknown_effect', 'billing_settlement_unknown')
  if (
    canonicalJsonDigest(reservation.ref) !== canonicalJsonDigest(reference.value) ||
    canonicalJsonDigest(reservation.accountRef) !== canonicalJsonDigest(input.accountRef) ||
    canonicalJsonDigest(reservation.usageRefs) !== canonicalJsonDigest(input.usageRefs) ||
    facts.some(
      (fact) => fact.actionId !== reservation.actionId || fact.attemptId !== reservation.attemptId,
    ) ||
    reservation.priceVersion !== quote.priceVersion ||
    canonicalJsonDigest(reservation.settledAmount) !== canonicalJsonDigest(quote.amount)
  )
    return refused('conflict', 'billing_settlement_source')
  return { ok: true, value: origins }
}
