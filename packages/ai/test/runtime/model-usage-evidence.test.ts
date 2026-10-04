import { describe, expect, it } from 'vitest'
import { modelUsageEvidence } from '../../src/runtime/model-adapter/usage-evidence.js'
import { estimateBilling, estimateCredits } from '../../src/usage.js'
import { fakeModel } from '../../testkit/index.js'

const model = fakeModel({
  id: 'model',
  route: 'route',
  cost: { input: 2, output: 3, cacheRead: 1, cacheWrite: 4 },
})
const tokens = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 }
describe('runtime model wire usage evidence', () => {
  it('preserves reported zero billing and credits instead of estimating', () => {
    expect(
      modelUsageEvidence(
        model,
        {
          tokens,
          billing: { usdMicros: 0, source: 'gateway', subscription: true },
          credits: 0,
          creditSource: 'gateway',
        },
        100,
      ),
    ).toEqual({
      billing: { usdMicros: 0, source: 'gateway', subscription: true },
      credits: 0,
      creditSource: 'gateway',
    })
  })
  it('uses the original estimate functions only with a selected rate for credits', () => {
    expect(modelUsageEvidence(model, { tokens }, 100)).toEqual({
      billing: estimateBilling(model, tokens),
      credits: estimateCredits(model, tokens, 100),
      creditSource: 'estimated',
    })
    expect(modelUsageEvidence(model, { tokens })).toEqual({ billing: estimateBilling(model, tokens) })
  })
  it.each([
    { usdMicros: -1, source: 'gateway', subscription: false },
    { usdMicros: 0, source: 'gateway', subscription: false, extra: true },
    { usdMicros: Number.MAX_SAFE_INTEGER + 1, source: 'gateway', subscription: false },
    { usdMicros: 0, source: 'other', subscription: false },
    { usdMicros: 0, source: 'gateway', subscription: 0 },
    [],
  ])('does not retain malformed billing %j', (billing) => {
    expect(modelUsageEvidence(model, { tokens, billing })).toEqual({
      billing: estimateBilling(model, tokens),
    })
  })
  it('rejects billing accessors without reading them', () => {
    let reads = 0
    const billing = {
      get usdMicros() {
        reads++
        return 0
      },
      source: 'gateway',
      subscription: false,
    }
    expect(modelUsageEvidence(model, { tokens, billing })).toEqual({
      billing: estimateBilling(model, tokens),
    })
    expect(reads).toBe(0)
  })
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'omits invalid credits without an invented rate %s',
    (credits) => {
      expect(modelUsageEvidence(model, { tokens, credits, creditSource: 'gateway' })).toEqual({
        billing: estimateBilling(model, tokens),
      })
    },
  )
  it('does not fabricate costs from invalid token quantities', () => {
    expect(modelUsageEvidence(model, { tokens: { ...tokens, input: -1 } }, 100)).toEqual({})
  })
})
