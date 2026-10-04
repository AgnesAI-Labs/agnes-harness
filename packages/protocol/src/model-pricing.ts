import { ModelPricePolicy, ModelPriceQuote } from '../gen/ts/model.js'
import { validateAgainst } from './validate.js'

const timestamp = (value: number) => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())
const date = (value: string) => {
  const time = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
}

/** Structural and semantic validation; absent rates remain unknown, including explicit nulls. */
export function validModelPricePolicy(value: unknown): value is ModelPricePolicy {
  if (!validateAgainst(ModelPricePolicy, value).ok) return false
  const policy = value as ModelPricePolicy
  if (Object.values(policy.perMillion).some((rate) => rate !== null && !Number.isFinite(rate))) return false
  if (
    (policy.validFrom !== undefined && !timestamp(policy.validFrom)) ||
    (policy.validUntil !== undefined && !timestamp(policy.validUntil)) ||
    (policy.validFrom !== undefined &&
      policy.validUntil !== undefined &&
      policy.validFrom >= policy.validUntil)
  )
    return false
  if (policy.source) {
    try {
      const url = new URL(policy.source.url)
      if (url.protocol !== 'https:' || url.username || url.password || !date(policy.source.checkedAt))
        return false
    } catch {
      return false
    }
  }
  const schedule = policy.offPeak
  if (!schedule) return true
  if (!Number.isFinite(schedule.multiplier) || schedule.excludedDates.some((value) => !date(value)))
    return false
  const windows = [...schedule.peakWindows].sort((a, b) => a.startMinute - b.startMinute)
  return windows.every(
    (window, index) =>
      window.startMinute < window.endMinute && (windows[index - 1]?.endMinute ?? 0) <= window.startMinute,
  )
}

/** A durable quote binds the exact admitted route and requested model, never current catalog state. */
export function validModelPriceQuote(value: unknown): value is ModelPriceQuote {
  if (!validateAgainst(ModelPriceQuote, value).ok) return false
  const quote = value as ModelPriceQuote
  return (
    timestamp(quote.admittedAt) &&
    !/[\p{Cc}]/u.test(quote.route + quote.model) &&
    validModelPricePolicy(quote.policy)
  )
}
