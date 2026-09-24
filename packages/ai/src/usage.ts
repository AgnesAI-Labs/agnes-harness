import type { Billing, ModelRecord, TokenCounts } from '@agnes/protocol'

/**
 * What a turn cost, from the catalogue the route declared.
 *
 * The unit contract, in one place. A `ModelRecord.cost` is dollars per million tokens, and this
 * returns dollars multiplied by `creditsPerUsd` - so the number that lands in the ledger's credits
 * column is denominated in whatever unit the deployment chose. With a factor of 1 that unit is the
 * dollar, which is a legal reading for a single-tenant deployment and a silent hundredfold
 * under-count for anyone whose budget cap is written in credits.
 *
 * Rounded to six decimal places, which is finer than any single request is worth and coarse enough
 * that summing a session's rows does not accumulate binary-float dust. Clamped at zero because the
 * value goes into an event whose schema forbids a negative, and a catalogue is configuration.
 */
export function estimateCredits(model: ModelRecord, t: TokenCounts, creditsPerUsd: number): number {
  const usd =
    (t.input * model.cost.input +
      t.output * model.cost.output +
      t.cacheRead * model.cost.cacheRead +
      t.cacheWrite * model.cost.cacheWrite) /
    1e6
  return Math.max(0, Math.round(usd * creditsPerUsd * 1e6) / 1e6)
}

/**
 * A conservative dollar projection in the protocol's integer micro-dollar unit.
 *
 * Unlike ledger credits, this unit is not deployment-defined. Invalid runtime values are omitted
 * instead of clamped: a negative or overflowing result is not a price and must not look like one.
 */
export function estimateBilling(model: ModelRecord, t: TokenCounts): Billing | undefined {
  const tokens = [t.input, t.output, t.cacheRead, t.cacheWrite]
  const rates = [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]
  if (
    tokens.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    rates.some((value) => !Number.isFinite(value) || value < 0)
  )
    return undefined
  // A rate is dollars per million tokens, so tokens * rate is already micro-dollars.
  const usdMicros = Math.round(tokens.reduce((sum, value, index) => sum + value * (rates[index] ?? 0), 0))
  if (!Number.isSafeInteger(usdMicros) || usdMicros < 0) return undefined
  return { usdMicros, source: 'estimated', subscription: false }
}
