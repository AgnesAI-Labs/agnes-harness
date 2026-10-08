import { canonicalJson as coreCanonicalJson } from '@agnes/core'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256hex } from '../../src/profile/canonical.js'

describe('canonicalJson (RFC 8785 subset)', () => {
  it('sorts keys recursively and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    )
  })
  it('is byte-stable across insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
  })
  it('writes an undefined array member as null rather than shifting later indices', () => {
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]')
  })
  // The one canonicalization in the repo. A second implementation here would be a second byte
  // sequence for the same value, and the hashes on either side of the seam would stop agreeing.
  it('is core.canonicalJson itself, not a copy of it', () => {
    expect(canonicalJson).toBe(coreCanonicalJson)
  })
  it('hashes deterministically', () => {
    expect(sha256hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('agrees with the hash core stamps on a request', async () => {
    const { sha256Hex } = await import('@agnes/core')
    for (const s of ['', 'abc', canonicalJson({ a: [1, 2, 3], b: 'x' })])
      expect(sha256hex(s)).toBe(sha256Hex(s))
  })
})
