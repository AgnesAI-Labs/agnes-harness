import { type ModelPricePolicy, type ModelPriceQuote, validModelPriceQuote } from '@agnes/protocol'

/** DSH apps/cli/config/examples/jev-comparison/cordis.yml:89-108 (checked 2026-09-30).
 * These are explicit route/model estimates, not provider-reported billing or credits. */
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const MODELS = new Set(['jev-latest', 'jev-1.13.0'])
const POLICY: ModelPricePolicy = {
  currency: 'USD',
  unit: 'per-million-tokens',
  // System One bills total input. Equal rates permit pricing the total without inventing cache counts.
  perMillion: { inputUncached: 0.042, cacheRead: 0.042, cacheWrite: 0.042, output: 0 },
  source: {
    url: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
    checkedAt: '2026-09-30',
  },
}
interface JevPriceIdentity {
  backend: string
  endpoint: string
  model: string
  admittedAt: number
}
function supported(input: JevPriceIdentity): boolean {
  return (
    input.backend === 'jev' &&
    input.endpoint === ENDPOINT &&
    MODELS.has(input.model) &&
    Number.isSafeInteger(input.admittedAt) &&
    Number.isFinite(new Date(input.admittedAt).getTime())
  )
}

/** Capture before model.requested; callers persist this separately from the actual wire input. */
export function captureJevPriceQuote(input: JevPriceIdentity): ModelPriceQuote | null {
  if (!supported(input)) return null
  return {
    version: 1,
    basis: 'configured',
    route: 'jev',
    model: input.model,
    admittedAt: input.admittedAt,
    policy: structuredClone(POLICY),
  }
}

export interface JevPriceEstimate {
  quote: ModelPriceQuote
  basis: 'recorded' | 'current'
  inputBasis: 'inputTotal'
}

/** Read-only historical estimate. An invalid recorded quote is never repaired by current prices.
 * A current estimate is not an admission receipt and must never be written back as one. */
export function resolveJevPriceEstimate(input: {
  backend: string
  endpoint: string
  requestedModel: string
  observedModel?: string | null
  admittedAt: number
  quote?: unknown
}): JevPriceEstimate | null {
  const current = captureJevPriceQuote({ ...input, model: input.requestedModel })
  if (!current || (input.observedModel != null && !MODELS.has(input.observedModel))) return null
  const recorded = input.quote !== undefined && input.quote !== null
  const quote = recorded ? input.quote : current
  if (
    !validModelPriceQuote(quote) ||
    quote.route !== 'jev' ||
    quote.model !== input.requestedModel ||
    quote.admittedAt > input.admittedAt
  )
    return null
  const rates = quote.policy.perMillion
  if (
    typeof rates.inputUncached !== 'number' ||
    rates.cacheRead !== rates.inputUncached ||
    rates.cacheWrite !== rates.inputUncached
  )
    return null
  // The known alias relation belongs to this explicit source/rate policy, not arbitrary future models.
  if (
    input.observedModel != null &&
    input.observedModel !== quote.model &&
    (quote.policy.currency !== POLICY.currency ||
      quote.policy.unit !== POLICY.unit ||
      rates.inputUncached !== POLICY.perMillion.inputUncached ||
      rates.output !== POLICY.perMillion.output ||
      quote.policy.source?.url !== POLICY.source?.url ||
      quote.policy.source?.checkedAt !== POLICY.source?.checkedAt ||
      quote.policy.offPeak !== undefined ||
      quote.policy.validFrom !== undefined ||
      quote.policy.validUntil !== undefined)
  )
    return null
  return { quote: structuredClone(quote), basis: recorded ? 'recorded' : 'current', inputBasis: 'inputTotal' }
}
