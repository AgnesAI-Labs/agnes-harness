import type { CallContext, Outcome } from '@agnes/extension-api/runtime'
import type * as W from '@agnes/protocol/runtime'
import { canonicalJsonDigest, RuntimeMethodSchemaRefs, validateRuntime } from '@agnes/protocol/runtime'
import { read, refused } from '../trace/provider-support.js'

/** Trusted adapters consume selected C33/C34/C32 methods and the original admitted selection. */
export interface BillingPricingPorts {
  /** Derive exact input from verified facts and the original reservation, never from current prices. */
  input(
    request: W.BillingPostRequest,
    facts: readonly W.UsageFact[],
    context: CallContext,
  ): Promise<Outcome<W.PricingQuoteInput>>
  /** Call the selected public agh.pricing.quote provider with its official input/output codecs. */
  quote(input: W.PricingQuoteInput, context: CallContext): Promise<Outcome<W.DataRef>>
}
export interface BillingAccountingPorts {
  pricing?: BillingPricingPorts
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
  const unknown = facts.some((fact) => fact.certainty === 'unknown')
  if (!unknown) {
    if (!ports.pricing) return refused('denied', 'billing_pricing_absent')
    const selected = await ports.pricing.input(input, structuredClone(facts), context)
    if (!selected.ok) return selected
    const source = validateRuntime('PricingQuoteInput', selected.value)
    if (
      !source.ok ||
      source.value.priceVersion !== quote.priceVersion ||
      source.value.currency !== quote.amount.currency ||
      canonicalJsonDigest(source.value) !== quote.inputDigest ||
      canonicalJsonDigest(source.value.usageUnits) !==
        canonicalJsonDigest(quote.lineItems.map((line) => ({ unit: line.unit, value: line.quantity })))
    )
      return refused('conflict', 'billing_pricing_source')
    if (context.signal.aborted) return refused('denied', 'permission_absent')
    const issued = await ports.pricing.quote(structuredClone(source.value), context)
    if (!issued.ok) return issued
    const verified = read<W.PriceQuote>(
      issued.value,
      RuntimeMethodSchemaRefs['agh.pricing'].quote.output,
      'PriceQuote',
    )
    if (!verified.ok || canonicalJsonDigest(verified.value) !== canonicalJsonDigest(quote))
      return refused('conflict', 'billing_pricing_source')
    if (context.signal.aborted) return refused('denied', 'permission_absent')
  }
  const reference = await ports.reservation(input, context)
  if (!reference.ok) return reference
  if (context.signal.aborted) return refused('denied', 'permission_absent')
  const result = await ports.settle({ reservationRef: reference.value, usageRefs: input.usageRefs }, context)
  if (!result.ok) return result
  if (unknown) return refused('unknown_effect', 'billing_usage_unknown')
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
