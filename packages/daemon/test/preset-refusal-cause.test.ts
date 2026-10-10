import { describe, expect, it } from 'vitest'
import { mapCore } from '../src/local/methods/agnes.js'

const caught = (error: unknown): { code: number; data: Record<string, unknown> } => {
  try {
    mapCore(error)
  } catch (thrown) {
    return thrown as { code: number; data: Record<string, unknown> }
  }
  throw new Error('mapCore returned')
}

describe('the cause a refused preset or model carries', () => {
  it.each([
    ['E_PRESET_UNSUPPORTED', { rule: 'not-allowed' }, 'not-allowed'],
    ['E_PRESET_UNSUPPORTED', { capability: 'sandbox' }, 'preset-unsupported'],
    ['E_PRESET_UNSUPPORTED', undefined, 'preset-unsupported'],
    ['E_PRESET_UNRESOLVED', undefined, 'preset-unresolved'],
    ['E_MODEL_UNSUPPORTED', undefined, 'model-unsupported'],
    ['E_MODEL_UNKNOWN', undefined, 'model-unknown'],
  ])('maps %s %j to %s', (code, detail, cause) => {
    const error = caught(Object.assign(new Error(`${code}: anything`), { code, detail }))
    expect(error.code).toBe(-32008)
    expect(error.data).toMatchObject({ code: 'PRESET_SWITCH_REJECTED', cause })
  })

  it('keeps the free-form reason apart from the cause', () => {
    const error = caught(
      Object.assign(new Error('E_PRESET_UNRESOLVED: slot primary wants a route'), {
        code: 'E_PRESET_UNRESOLVED',
      }),
    )
    expect(error.data.reason).toBe('E_PRESET_UNRESOLVED: slot primary wants a route')
    expect(error.data.cause).toBe('preset-unresolved')
  })

  it('rethrows anything that is not a refusal untouched', () => {
    const original = Object.assign(new Error('boom'), { code: 'E_SOMETHING_ELSE' })
    expect(() => mapCore(original)).toThrow(original)
  })
})
