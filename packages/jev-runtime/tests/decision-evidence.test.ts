import { describe, expect, it } from 'vitest'
import { decisionEvidence, jsonBytes } from '../src/decision-evidence.js'

describe('structured decision evidence', () => {
  it('preserves JSON values and marks the exact shortened text and collection', () => {
    expect(decisionEvidence({ path: 'a', lines: ['x'.repeat(100), 'second'], total: 2 }, 40)).toMatchObject({
      value: { path: 'a', lines: [expect.any(String)] },
      projection: { truncated: true, truncatedPaths: ['/lines/0', '/lines', ''] },
    })
    const value = { enabled: true, absent: null, count: 3, rows: [{ value: 'text' }] }
    expect(decisionEvidence(value, 500)).toEqual({
      value,
      projection: {
        truncated: false,
        truncatedPaths: [],
        originalBytes: jsonBytes(value),
      },
    })
  })

  it('counts escaped UTF-8 bytes without splitting Unicode scalars or parsing text as JSON', () => {
    for (const text of ['🐉'.repeat(10), '\n\t"\\'.repeat(10), '{"already":"text"}']) {
      for (let limit = 2; limit < 40; limit++) {
        const evidence = decisionEvidence(text, limit)
        expect(jsonBytes(evidence.value)).toBeLessThanOrEqual(limit)
        expect(typeof evidence.value).toBe('string')
        if (typeof evidence.value !== 'string') throw new Error('Expected text evidence')
        expect(new TextDecoder().decode(new TextEncoder().encode(evidence.value))).toBe(evidence.value)
      }
    }
  })

  it('preserves literal object keys and escapes truncation pointers', () => {
    const value = { ['__proto__']: { 'a/b~': 'xxxxxxxxxxxxxxxx' } }
    const result = decisionEvidence(value, 32)
    expect(JSON.stringify(result.value)).toBe('{"__proto__":{"a/b~":"xxxxxxx"}}')
    expect(result.projection.truncatedPaths).toEqual(['/__proto__/a~1b~0'])
    expect(decisionEvidence(12345, 2)).toMatchObject({
      value: null,
      projection: { truncated: true, truncatedPaths: [''] },
    })
  })
})
