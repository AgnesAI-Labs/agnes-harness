import { expect, it } from 'vitest'
import { captureJevPriceQuote, resolveJevPriceEstimate } from '../src/runtime/jev-pricing.js'

const identity = {
  backend: 'jev',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  admittedAt: Date.parse('2026-10-04T00:00:00Z'),
}
const input = { ...identity, requestedModel: identity.model }
it('uses DSH exact Jev prices for both registered models, independently of unknown cache counts', () => {
  for (const model of ['jev-latest', 'jev-1.13.0']) {
    const quote = captureJevPriceQuote({ ...identity, model })
    expect(quote).toMatchObject({
      basis: 'configured',
      model,
      route: 'jev',
      admittedAt: identity.admittedAt,
      policy: {
        currency: 'USD',
        perMillion: { inputUncached: 0.042, cacheRead: 0.042, cacheWrite: 0.042, output: 0 },
        source: {
          url: 'https://typesafe.ai/blog/introducing-system-one-models-and-jev',
          checkedAt: '2026-09-30',
        },
      },
    })
    expect(resolveJevPriceEstimate({ ...input, requestedModel: model })).toMatchObject({
      basis: 'current',
      inputBasis: 'inputTotal',
      quote,
    })
  }
})
it.each([
  { backend: 'laya' },
  { endpoint: 'https://other.example/v1/systemone' },
  { endpoint: 'https://api.typesafe.ai/v1/systemone?key=hidden' },
  { model: 'jev-next' },
  { admittedAt: NaN },
])('refuses unsupported connection or timestamp %j', (change) => {
  expect(captureJevPriceQuote({ ...identity, ...change })).toBeNull()
})
it('preserves recorded prices and distinguishes current fallback without mutating either source', () => {
  const quote = captureJevPriceQuote(identity)
  if (!quote) throw new Error('Missing quote')
  quote.policy.perMillion = { inputUncached: 0.1, cacheRead: 0.1, cacheWrite: 0.1, output: 0.2 }
  const original = structuredClone(quote)
  const recorded = resolveJevPriceEstimate({ ...input, quote })
  expect(recorded).toEqual({ quote: original, basis: 'recorded', inputBasis: 'inputTotal' })
  if (!recorded) throw new Error('Missing recorded estimate')
  recorded.quote.policy.perMillion.inputUncached = 99
  expect(quote).toEqual(original)
  const current = resolveJevPriceEstimate({ ...input, quote: null })
  expect(current?.basis).toBe('current')
  expect(current?.quote.policy.perMillion.inputUncached).toBe(0.042)
})
it('accepts only explicit same-policy model aliases, and never repairs conflicting recorded evidence', () => {
  const quote = captureJevPriceQuote(identity)
  if (!quote?.policy.source) throw new Error('Missing quote source')
  expect(resolveJevPriceEstimate({ ...input, quote, observedModel: 'jev-1.13.0' })?.basis).toBe('recorded')
  expect(resolveJevPriceEstimate({ ...input, observedModel: 'jev-1.13.0' })?.basis).toBe('current')
  for (const observedModel of ['unknown', 'jev-next', ''])
    expect(resolveJevPriceEstimate({ ...input, quote, observedModel })).toBeNull()
  for (const bad of [
    {},
    { ...quote, model: 'other' },
    { ...quote, route: 'other' },
    { ...quote, admittedAt: identity.admittedAt + 1 },
    {
      ...quote,
      policy: {
        ...quote.policy,
        perMillion: { inputUncached: 0.042, cacheRead: null, cacheWrite: 0.042, output: 0 },
      },
    },
  ]) {
    expect(resolveJevPriceEstimate({ ...input, quote: bad })).toBeNull()
  }
  quote.policy.source.checkedAt = '2026-10-01'
  expect(resolveJevPriceEstimate({ ...input, quote, observedModel: 'jev-1.13.0' })).toBeNull()
})
