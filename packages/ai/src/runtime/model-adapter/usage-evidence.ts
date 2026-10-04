import type { Billing, ModelRecord, TokenCounts } from '@agnes/protocol'
import { estimateBilling, estimateCredits } from '../../usage.js'

export type ModelUsageEvidence = {
  billing?: Billing
  credits?: number
  creditSource?: 'gateway' | 'estimated'
}

/** Preserve reported charges; estimates use the original model cost and selected credit rate. */
export function modelUsageEvidence(
  model: ModelRecord,
  event: { tokens: TokenCounts; billing?: unknown; credits?: unknown; creditSource?: unknown },
  creditsPerUsd?: number,
): ModelUsageEvidence {
  const result: ModelUsageEvidence = {}
  const billing = event.billing
  if (billing !== null && typeof billing === 'object' && !Array.isArray(billing)) {
    const descriptors = Object.getOwnPropertyDescriptors(billing)
    const amount: unknown = descriptors.usdMicros?.value,
      source: unknown = descriptors.source?.value,
      subscription: unknown = descriptors.subscription?.value
    if (
      Reflect.ownKeys(billing).length === 3 &&
      ['usdMicros', 'source', 'subscription'].every((key) => {
        const field = descriptors[key]
        return field !== undefined && Object.hasOwn(field, 'value')
      }) &&
      typeof amount === 'number' &&
      Number.isSafeInteger(amount) &&
      amount >= 0 &&
      (source === 'gateway' || source === 'estimated') &&
      typeof subscription === 'boolean'
    )
      result.billing = { usdMicros: amount, source, subscription }
  }
  const estimated = estimateBilling(model, event.tokens)
  if (!result.billing && estimated) result.billing = estimated
  if (typeof event.credits === 'number' && Number.isFinite(event.credits) && event.credits >= 0) {
    result.credits = event.credits
    if (event.creditSource === 'gateway' || event.creditSource === 'estimated')
      result.creditSource = event.creditSource
  } else if (
    creditsPerUsd !== undefined &&
    Number.isFinite(creditsPerUsd) &&
    creditsPerUsd > 0 &&
    estimated
  ) {
    const credits = estimateCredits(model, event.tokens, creditsPerUsd)
    if (Number.isFinite(credits) && credits >= 0) {
      result.credits = credits
      result.creditSource = 'estimated'
    }
  }
  return result
}
