import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalizeIntegrity } from '../../src/runtime/integrity/canonicalize.js'

describe('integrity canonicalization', () => {
  it('preserves canonical Unicode bytes and is independent of object insertion order', () => {
    const first = canonicalizeIntegrity({ value: { z: -0, a: '你好' } })
    const second = canonicalizeIntegrity({ value: { a: '你好', z: 0 } })
    const expected = '{"a":"你好","z":0}'
    expect(first).toEqual(second)
    expect(first.canonical).toBe(expected)
    expect(first.bytes).toBe(Buffer.byteLength(expected, 'utf8'))
    expect(first.digest).toBe(createHash('sha256').update(expected).digest('hex'))
  })

  it.each([
    {},
    { value: null, extra: true },
    { value: Number.NaN },
    { value: { nested: undefined } },
    { value: [Infinity] },
  ])('rejects invalid wire input before producing a digest: %j', (input) => {
    expect(() => canonicalizeIntegrity(input)).toThrow(TypeError)
  })
})
