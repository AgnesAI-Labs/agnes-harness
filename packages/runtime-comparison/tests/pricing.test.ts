import { type ModelPricePolicy, type ModelPriceQuote, validModelPricePolicy } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { modelPriceMultiplier, pricingFromModelQuote } from '../src/pricing.js'

const at = (value: string) => Date.parse(value)
const policy: ModelPricePolicy = {
  currency: 'CNY',
  unit: 'per-million-tokens',
  perMillion: { inputUncached: 1, output: 2 },
  source: { url: 'https://example.test/prices', checkedAt: '2026-10-01' },
  validFrom: at('2026-09-10T04:00:00Z'),
  validUntil: at('2027-01-01T00:00:00+08:00'),
  offPeak: {
    multiplier: 0.5,
    utcOffsetMinutes: 480,
    peakWeekdays: [1, 2, 3, 4, 5],
    peakWindows: [
      { startMinute: 540, endMinute: 720 },
      { startMinute: 840, endMinute: 1080 },
    ],
    excludedDates: ['2026-10-01', '2026-10-02', '2026-10-05'],
  },
}
const quote: ModelPriceQuote = {
  version: 1,
  basis: 'configured',
  route: 'gw',
  model: 'm',
  admittedAt: at('2026-10-08T08:00:00+08:00'),
  policy,
}

describe('frozen price calendar', () => {
  it('requires inclusive start/exclusive end and rejects every internal rate transition', () => {
    expect(validModelPricePolicy(policy)).toBe(true)
    expect(modelPriceMultiplier(policy, policy.validFrom!, null)).toBe(0.5)
    expect(modelPriceMultiplier(policy, policy.validUntil!, null)).toBeNull()
    expect(
      modelPriceMultiplier(policy, 0, { start: quote.admittedAt, end: at('2026-10-08T08:59:59+08:00') }),
    ).toBe(0.5)
    // Both endpoints are off-peak, but the persisted interval crosses the morning peak.
    expect(
      modelPriceMultiplier(policy, 0, { start: quote.admittedAt, end: at('2026-10-08T13:00:00+08:00') }),
    ).toBeNull()
    expect(modelPriceMultiplier(policy, at('2026-10-05T10:00:00+08:00'), null)).toBe(0.5)
    expect(
      modelPriceMultiplier(policy, 0, { start: at('2026-12-31T23:00:00+08:00'), end: policy.validUntil! }),
    ).toBeNull()
  })
  it('binds exact persisted route/model and refuses observed model mismatch and missing legacy prices', () => {
    const end = at('2026-10-08T08:30:00+08:00')
    expect(pricingFromModelQuote(quote, { route: 'gw', model: 'm' }, end)).toMatchObject({
      currency: 'CNY',
      multiplier: 0.5,
    })
    for (const binding of [
      { route: 'other', model: 'm' },
      { route: 'gw', model: 'other' },
      { route: 'gw', model: 'm', observedModel: 'other' },
    ])
      expect(pricingFromModelQuote(quote, binding, end)).toBeNull()
    expect(pricingFromModelQuote(undefined, { route: 'gw', model: 'm' }, end)).toBeNull()
    expect(
      pricingFromModelQuote(quote, { route: 'gw', model: 'm' }, at('2026-10-08T13:00:00+08:00'))?.multiplier,
    ).toBeNull()
  })
  it.each([
    { validUntil: policy.validFrom },
    { source: { url: 'http://example.test', checkedAt: '2026-10-01' } },
    { source: { url: 'https://example.test', checkedAt: '2026-02-30' } },
    {
      offPeak: {
        ...policy.offPeak!,
        peakWindows: [
          { startMinute: 10, endMinute: 20 },
          { startMinute: 15, endMinute: 30 },
        ],
      },
    },
    { perMillion: { output: Infinity } },
  ])('rejects malformed or contradictory policy %j', (change) => {
    expect(validModelPricePolicy({ ...policy, ...change })).toBe(false)
  })
})
