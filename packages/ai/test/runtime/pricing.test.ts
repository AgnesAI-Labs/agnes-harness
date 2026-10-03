import { canonicalJsonDigest, type PricingQuoteInput, validateRuntime } from '@agnes/protocol/runtime'
import { expect, it } from 'vitest'
import {
  createPricingAlgorithm,
  type PricingCatalogRule,
  pricingLineAmount,
} from '../../src/runtime/providers/pricing.js'

// Explicit synthetic catalog: it is neither a vendor tariff nor a production installation.
const catalog: PricingCatalogRule[] = [
  {
    priceVersion: 'fixed-v1',
    model: 'fixture-model',
    region: null,
    unit: 'input-token',
    ruleId: 'input-v1',
    unitPrice: { currency: 'XTS', scale: 6, units: '3' },
  },
  {
    priceVersion: 'fixed-v1',
    model: 'fixture-model',
    region: null,
    unit: 'output-token',
    ruleId: 'output-v1',
    unitPrice: { currency: 'XTS', scale: 6, units: '5' },
  },
]
const input: PricingQuoteInput = {
  usageUnits: [
    { unit: 'input-token', value: '0.5' },
    { unit: 'output-token', value: '0.5' },
  ],
  model: 'fixture-model',
  region: null,
  priceVersion: 'fixed-v1',
  currency: 'XTS',
}

it('quotes official input with fixed catalog identity, exact half-even lines and total', () => {
  const algorithm = createPricingAlgorithm(catalog),
    quote = algorithm.quote(input)
  expect(validateRuntime('PriceQuote', quote).ok).toBe(true)
  expect(quote.inputDigest).toBe(canonicalJsonDigest(input))
  expect(quote.lineItems.map((line) => line.amount.units)).toEqual(['2', '2'])
  expect(quote.amount).toEqual({ currency: 'XTS', scale: 6, units: '4' })
  expect(quote.rounding).toBe('half-even')
  expect(algorithm.quote(input)).toEqual(quote)
  expect(algorithm.quote({ ...input, usageUnits: [] }).amount.units).toBe('0')
})
it('captures catalog bytes and keeps a prepared version independent of replacement prices', () => {
  const original = structuredClone(catalog),
    first = createPricingAlgorithm(original)
  const locked = first.quote(input)
  const rule = original[0]
  if (!rule) throw Error('Fixture rule absent')
  rule.unitPrice.units = '999'
  expect(first.quote(input)).toEqual(locked)
  expect(createPricingAlgorithm(original).quote(input)).not.toEqual(locked)
  expect(() => first.quote({ ...input, priceVersion: 'latest' })).toThrow()
})
it('refuses unknown model, region, currency, unit and version even for empty usage', () => {
  const algorithm = createPricingAlgorithm(catalog)
  for (const changed of [
    { model: 'foreign' },
    { region: 'foreign' },
    { currency: 'USD' },
    { priceVersion: 'foreign' },
  ]) {
    expect(() => algorithm.quote({ ...input, ...changed })).toThrow()
    expect(() => algorithm.quote({ ...input, ...changed, usageUnits: [] })).toThrow()
  }
  expect(() => algorithm.quote({ ...input, currency: '' })).toThrow()
  expect(() => algorithm.quote({ ...input, usageUnits: [{ unit: 'foreign', value: '1' }] })).toThrow()
})
it('multiplies without floating point, including large exact values and tie parity', () => {
  expect(pricingLineAmount('0.5', '1')).toBe('0')
  expect(pricingLineAmount('0.5', '3')).toBe('2')
  expect(pricingLineAmount('0.5', '5')).toBe('2')
  expect(pricingLineAmount('0.5001', '1')).toBe('1')
  expect(pricingLineAmount('9007199254740993', '3')).toBe('27021597764222979')
  expect(pricingLineAmount('0.000001', '1000000')).toBe('1')
})
it('refuses noncanonical or negative quantities and malformed catalog money', () => {
  for (const value of ['-1', '01', '1.0', '1e3', 'NaN', 'unknown', '', '0'.repeat(257)]) {
    expect(() => pricingLineAmount(value, '1')).toThrow()
    expect(() => pricingLineAmount('1', value)).toThrow()
  }
  expect(() => createPricingAlgorithm([])).toThrow()
  expect(() => createPricingAlgorithm([...catalog, ...catalog])).toThrow()
  expect(() =>
    createPricingAlgorithm(
      catalog.map((rule) => ({ ...rule, unitPrice: { ...rule.unitPrice, currency: '' } })),
    ),
  ).toThrow()
  expect(() =>
    createPricingAlgorithm(
      catalog.map((rule) => ({ ...rule, unitPrice: { ...rule.unitPrice, units: '-1' } })),
    ),
  ).toThrow()
})
