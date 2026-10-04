import { describe, expect, it } from 'vitest'
import { RuntimeMethodSchemaRefs, validateRuntime } from '../../src/runtime/index.js'

const original = {
  kind: 'reported',
  quantities: [],
  actualModel: 'model-a',
  source: 'provider-receipt',
  sourceReceipt: null,
  replacesFactIds: [],
} as const

describe('runtime usage measurement billing compatibility', () => {
  it('keeps original measurements valid and retains reported zero values', () => {
    expect(validateRuntime('UsageMeasurement', original).ok).toBe(true)
    expect(
      validateRuntime('UsageMeasurement', {
        ...original,
        billing: { usdMicros: 0, source: 'gateway', subscription: false },
        credits: 0,
        creditSource: 'gateway',
      }).ok,
    ).toBe(true)
    expect(RuntimeMethodSchemaRefs['agh.usage'].record.input.revision).toBe(3)
  })

  it.each([
    { billing: { usdMicros: -1, source: 'gateway', subscription: false } },
    { billing: { usdMicros: Number.MAX_SAFE_INTEGER + 1, source: 'gateway', subscription: false } },
    { billing: { usdMicros: 1, source: 'gateway', subscription: false, other: true } },
    { billing: { usdMicros: 1, source: 'guess', subscription: false } },
    { credits: -1 },
    { credits: Number.NaN },
    { creditSource: 'guess' },
    { credits: null },
  ])('rejects malformed optional billing evidence: %j', (extra) => {
    expect(validateRuntime('UsageMeasurement', { ...original, ...extra }).ok).toBe(false)
  })
})
