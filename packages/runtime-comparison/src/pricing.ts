// Calendar selection adapted from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT.
// See DEEPSEEK-LICENSE.txt and UPSTREAM.json for exact provenance and local changes.
import { type ModelPricePolicy, validModelPricePolicy, validModelPriceQuote } from '@agnes/protocol'
import type { Pricing } from './accounting.js'

const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs
const weekMs = 7 * dayMs
const timestamp = (value: number) => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime())

/** An interval must stay inside one valid price band, including internal calendar transitions. */
export function modelPriceMultiplier(
  price: ModelPricePolicy,
  time: number,
  range: { readonly start: number; readonly end: number } | null,
): number | null {
  if (!validModelPricePolicy(price)) return null
  const start = range?.start ?? time
  const end = range?.end ?? time
  if (
    !timestamp(start) ||
    !timestamp(end) ||
    end < start ||
    (price.validFrom !== undefined && start < price.validFrom) ||
    (price.validUntil !== undefined && end >= price.validUntil)
  )
    return null
  const schedule = price.offPeak
  if (schedule === undefined || schedule.multiplier === 1) return 1
  const offset = schedule.utcOffsetMinutes * minuteMs
  if (!timestamp(start + offset) || !timestamp(end + offset)) return null
  const excluded = new Set(schedule.excludedDates)
  const factorAt = (instant: number): number => {
    const local = new Date(instant + offset)
    const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
    return schedule.peakWeekdays.includes(local.getUTCDay()) &&
      !excluded.has(local.toISOString().slice(0, 10)) &&
      schedule.peakWindows.some((window) => minute >= window.startMinute && minute < window.endMinute)
      ? 1
      : schedule.multiplier
  }
  const factor = factorAt(start)
  const differsAt = (instant: number): boolean =>
    instant >= start && instant <= end && factorAt(instant) !== factor
  if (differsAt(end)) return null
  if (start === end) return factor

  // Weekly transitions repeat except on excluded dates. Inspect the first normal
  // occurrence of each transition, then each excluded day's entrance and exit.
  const firstDay = Math.floor((start + offset) / dayMs) * dayMs
  const firstWeekday = new Date(firstDay).getUTCDay()
  for (const weekday of schedule.peakWeekdays)
    for (const window of schedule.peakWindows) {
      for (const minute of [window.startMinute, window.endMinute]) {
        let day = firstDay + ((weekday - firstWeekday + 7) % 7) * dayMs
        if (day + minute * minuteMs - offset < start) day += weekMs
        while (
          day + minute * minuteMs - offset <= end &&
          excluded.has(new Date(day).toISOString().slice(0, 10))
        )
          day += weekMs
        const boundary = day + minute * minuteMs - offset
        if (differsAt(boundary) || differsAt(boundary - 1)) return null
      }
    }
  for (const value of excluded) {
    const midnight = Date.parse(`${value}T00:00:00Z`) - offset
    for (const boundary of [midnight, midnight + dayMs]) {
      if (differsAt(boundary) || differsAt(boundary - 1)) return null
    }
  }
  return factor
}

/** No current-price fallback, observed-model substitution, currency conversion or invoice inference. */
export function pricingFromModelQuote(
  value: unknown,
  binding: {
    route: string | null | undefined
    model: string | null | undefined
    observedModel?: string | null
  },
  settledAt: number,
): Pricing | null {
  if (
    !validModelPriceQuote(value) ||
    value.route !== binding.route ||
    value.model !== binding.model ||
    (binding.observedModel != null && binding.observedModel !== value.model)
  )
    return null
  const multiplier = modelPriceMultiplier(value.policy, settledAt, {
    start: value.admittedAt,
    end: settledAt,
  })
  return { currency: value.policy.currency, perMillion: structuredClone(value.policy.perMillion), multiplier }
}
