import { expect, it } from 'vitest'
import { automaticFastModel } from '../src/configuration-auto-slots.js'

const model = (id: string, input = 0, output = 0) => ({
  id,
  cost: { input, output, cacheRead: 0, cacheWrite: 0 },
})

it('prefers the cheapest priced model by input plus output price, keeping saved order on a tie', () => {
  const models = [model('pro', 3, 15), model('mini', 0.5, 1.5), model('lite', 1, 1), model('unpriced-flash')]
  expect(automaticFastModel(models)?.id).toBe('mini')
  expect(automaticFastModel([model('a', 1, 1), model('b', 1, 1)])?.id).toBe('a')
})

it('reads the light tier from the id only when no model has a price, and otherwise chooses nothing', () => {
  expect(
    automaticFastModel([model('agnes-2.5-pro'), model('agnes-2.5-flash'), model('agnes-2.0-flash')])?.id,
  ).toBe('agnes-2.5-flash')
  expect(automaticFastModel([model('GPT-5-Mini'), model('gpt-5')])?.id).toBe('GPT-5-Mini')
  // A marker inside another word is not a tier.
  expect(automaticFastModel([model('minimax-large'), model('breakfast-xl')])).toBeUndefined()
  expect(automaticFastModel([])).toBeUndefined()
})
