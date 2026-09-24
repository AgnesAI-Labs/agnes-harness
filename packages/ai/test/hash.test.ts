import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../src/hash.js'

describe('canonicalJson', () => {
  it('sorts object keys, so insertion order cannot change a digest', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })
  it('sorts nested keys too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}')
  })
  it('keeps array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]))
  })
  it('drops undefined-valued keys so an absent field hashes like an explicitly undefined one', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson({ a: 1 })).toBe(canonicalJson({ a: 1, b: undefined }))
  })
  it('emits no whitespace and distinguishes null from a missing key', () => {
    expect(canonicalJson({ a: [{ b: 'x' }] })).toBe('{"a":[{"b":"x"}]}')
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })
  it('handles primitives at the top level', () => {
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(3)).toBe('3')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
  })
})

describe('sha256Hex', () => {
  it('is a lowercase hex sha-256 of the input, matching the platform digest', () => {
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'))
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'))
  })
})
