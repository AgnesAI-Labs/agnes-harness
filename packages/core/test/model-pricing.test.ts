import { type ModelPricePolicy, type ModelRecord, type Provider, validModelPriceQuote } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { captureModelPriceQuote } from '../src/request/model-pricing.js'

const model: ModelRecord = {
  id: 'm',
  name: 'm',
  route: 'gw',
  api: 'test',
  baseUrl: 'https://example.test',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
  contextWindow: 1000,
  maxTokens: 100,
  toolCallFormats: ['native'],
  thinkingReplay: 'drop',
  contract_id: null,
}
const policy: ModelPricePolicy = {
  currency: 'CNY',
  unit: 'per-million-tokens',
  perMillion: { output: 0 },
  validUntil: 1,
}
const provider = (models: ModelRecord[]): Provider => ({ models: () => models, async *infer() {} })

describe('admitted model pricing', () => {
  it('copies only exact route/model and immutable declared rates, never extra request data', () => {
    const records = [structuredClone(model)]
    const request = { route: 'gw', model: 'm', messages: [{ secret: 'private prompt' }], purpose: 'title' }
    const quote = captureModelPriceQuote(provider(records), request, 0)
    expect(validModelPriceQuote(quote)).toBe(true)
    expect(quote).toEqual({
      version: 1,
      basis: 'catalog-estimate',
      route: 'gw',
      model: 'm',
      admittedAt: 0,
      policy: {
        currency: 'USD',
        unit: 'per-million-tokens',
        perMillion: { inputUncached: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      },
    })
    records[0]!.cost.output = 999
    expect(quote?.policy.perMillion.output).toBe(2)
  })
  it('preserves explicit incomplete, expired and intentional zero policies without catalog fallback', () => {
    const record = { ...model, pricePolicy: structuredClone(policy) }
    const quote = captureModelPriceQuote(provider([record]), { route: 'gw', model: 'm' }, 2)
    expect(quote?.basis).toBe('configured')
    expect(quote?.policy).toEqual(policy)
    record.pricePolicy.perMillion.output = 100
    expect(quote?.policy.perMillion.output).toBe(0)
    expect(
      captureModelPriceQuote(
        provider([{ ...model, pricePolicy: { ...policy, currency: 'credits' } }]),
        { route: 'gw', model: 'm' },
        2,
      ),
    ).toBeNull()
  })
  it('leaves unavailable, ambiguous and all-zero catalog estimates unknown without blocking inference', () => {
    for (const models of [
      [],
      [model, model],
      [{ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    ])
      expect(captureModelPriceQuote(provider(models), { route: 'gw', model: 'm' }, 0)).toBeNull()
    expect(
      captureModelPriceQuote(
        {
          ...provider([]),
          models() {
            throw new Error('sensitive provider details')
          },
        },
        { route: 'gw', model: 'm' },
        0,
      ),
    ).toBeNull()
  })
})
