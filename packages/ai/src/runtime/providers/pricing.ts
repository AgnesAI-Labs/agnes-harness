import type { AlgorithmImplementationMap } from '@agnes/extension-api/runtime'
import {
  boundedCanonicalJson,
  canonicalJsonDigest,
  type Money,
  type PriceQuote,
  type PricingQuoteInput,
  validateRuntime,
} from '@agnes/protocol/runtime'

export interface PricingCatalogRule {
  readonly priceVersion: string
  readonly model: string
  readonly region: string | null
  readonly unit: string
  readonly ruleId: string
  readonly unitPrice: Money
}
const integer = /^(0|[1-9][0-9]*)$/
const decimal = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/

/** Multiply exact units by integer micro units, with explicit half-even rounding. */
export function pricingLineAmount(quantity: string, microUnits: string): string {
  if (
    quantity.length > 256 ||
    microUnits.length > 256 ||
    !decimal.test(quantity) ||
    !integer.test(microUnits)
  )
    throw new TypeError('Invalid exact pricing quantity')
  const [whole, fraction = ''] = quantity.split('.')
  const divisor = 10n ** BigInt(fraction.length)
  const numerator = BigInt(`${whole}${fraction}`) * BigInt(microUnits)
  const floor = numerator / divisor
  const remainder = numerator % divisor
  return (
    floor + (remainder * 2n > divisor || (remainder * 2n === divisor && floor % 2n !== 0n) ? 1n : 0n)
  ).toString()
}
const key = (version: string, model: string, region: string | null, currency: string, unit: string) =>
  JSON.stringify([version, model, region, currency, unit])

/** Capture an explicitly selected catalog; this function does not install or authenticate a provider. */
export function createPricingAlgorithm(catalog: readonly PricingCatalogRule[]) {
  const safe = boundedCanonicalJson(catalog, { maxBytes: 1048576, maxDepth: 8, maxMembers: 100000 })
  if (!safe.ok || !Array.isArray(safe.value.json) || safe.value.json.length === 0)
    throw new TypeError('Invalid pricing catalog')
  const rules = new Map<string, Readonly<PricingCatalogRule>>()
  for (const item of safe.value.json) {
    if (
      item === null ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'model,priceVersion,region,ruleId,unit,unitPrice' ||
      typeof item.priceVersion !== 'string' ||
      !item.priceVersion ||
      typeof item.model !== 'string' ||
      !item.model ||
      typeof item.unit !== 'string' ||
      !item.unit ||
      typeof item.ruleId !== 'string' ||
      !item.ruleId ||
      (item.region !== null && typeof item.region !== 'string')
    )
      throw new TypeError('Invalid pricing catalog rule')
    const money = validateRuntime('Money', item.unitPrice)
    if (!money.ok || !money.value.currency) throw new TypeError('Invalid pricing currency')
    pricingLineAmount('0', money.value.units)
    const rule = Object.freeze({
      priceVersion: item.priceVersion,
      model: item.model,
      region: item.region,
      unit: item.unit,
      ruleId: item.ruleId,
      unitPrice: Object.freeze({ ...money.value }),
    })
    const identity = key(rule.priceVersion, rule.model, rule.region, rule.unitPrice.currency, rule.unit)
    if (rules.has(identity)) throw new TypeError('Duplicate pricing catalog rule')
    rules.set(identity, rule)
  }
  function quote(original: Readonly<PricingQuoteInput>): PriceQuote {
    const safeInput = boundedCanonicalJson(original, { maxBytes: 1048576, maxDepth: 8, maxMembers: 100000 })
    if (!safeInput.ok) throw new TypeError('Invalid pricing input')
    const parsed = validateRuntime('PricingQuoteInput', safeInput.value.json)
    if (!parsed.ok) throw new TypeError('Invalid pricing input')
    const input = parsed.value
    if (
      !input.model ||
      !input.priceVersion ||
      !input.currency ||
      ![...rules.values()].some(
        (rule) =>
          rule.priceVersion === input.priceVersion &&
          rule.model === input.model &&
          rule.region === input.region &&
          rule.unitPrice.currency === input.currency,
      )
    )
      throw new TypeError('Unknown locked pricing catalog selection')
    const lineItems = input.usageUnits.map((quantity) => {
      const rule = rules.get(
        key(input.priceVersion, input.model, input.region, input.currency, quantity.unit),
      )
      if (!rule) throw new TypeError('No locked price for this usage')
      return {
        unit: quantity.unit,
        quantity: quantity.value,
        unitPrice: { ...rule.unitPrice },
        amount: {
          currency: input.currency,
          scale: 6 as const,
          units: pricingLineAmount(quantity.value, rule.unitPrice.units),
        },
        ruleId: rule.ruleId,
      }
    })
    const body = {
      priceVersion: input.priceVersion,
      inputDigest: canonicalJsonDigest(input),
      lineItems,
      amount: {
        currency: input.currency,
        scale: 6 as const,
        units: lineItems.reduce((sum, line) => sum + BigInt(line.amount.units), 0n).toString(),
      },
      rounding: 'half-even' as const,
    }
    const result = { quoteId: `quote:${canonicalJsonDigest(body)}`, ...body }
    if (!validateRuntime('PriceQuote', result).ok) throw new TypeError('Invalid pricing quote')
    return result
  }
  const algorithm = { quote } satisfies AlgorithmImplementationMap['agh.pricing']
  return Object.freeze(algorithm)
}
