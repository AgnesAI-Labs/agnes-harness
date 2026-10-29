import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex, utf8 } from '../src/request/hash.js'

describe('sha256Hex', () => {
  it('matches known vectors across the padding boundaries', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    // 55 / 56 / 64 bracket the point where the length word no longer fits in the first block and a
    // second block has to be padded: an off-by-one in the pad length is invisible on short inputs.
    expect(sha256Hex('a'.repeat(55))).toBe('9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318')
    expect(sha256Hex('a'.repeat(56))).toBe('b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a')
    expect(sha256Hex('a'.repeat(64))).toBe('ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb')
    expect(sha256Hex('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    )
  })

  it('hashes the UTF-8 bytes of a string, not its UTF-16 units', () => {
    // '你好' is 2 UTF-16 units and 6 UTF-8 bytes. Hashing the unit count pads at the wrong offset
    // and produces a different digest, so this fails the moment the encoder is skipped.
    expect(sha256Hex('你好')).toBe('670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e')
    expect(utf8('你好')).toHaveLength(6)
    expect(sha256Hex(utf8('你好'))).toBe(sha256Hex('你好'))
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively by code unit and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    )
    // Two objects built in opposite orders must produce one byte sequence; that equality is the
    // whole reason derived_hash can be compared across two derivations of the same turn.
    expect(canonicalJson({ z: 1, a: 2, m: 3 })).toBe(canonicalJson({ m: 3, z: 1, a: 2 }))
    // Code-unit order, not locale order: 'Z' sorts before 'a'.
    expect(canonicalJson({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}')
  })

  it('keeps array order and writes an undefined member as null rather than dropping it', () => {
    // Dropping it would shift every later index, so two different arrays would canonicalize alike.
    expect(canonicalJson([3, undefined, 1])).toBe('[3,null,1]')
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('passes scalars through JSON.stringify and round-trips to an equal value', () => {
    expect(canonicalJson('x')).toBe('"x"')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(JSON.parse(canonicalJson({ b: [1, { d: 2, c: 3 }], a: null }))).toEqual({
      a: null,
      b: [1, { c: 3, d: 2 }],
    })
  })

  it('always returns a string, including for what JSON.stringify answers undefined for', () => {
    // The signature says string, and the caller hashes the result. `JSON.stringify` returns the
    // value undefined — not the text — for these three at the top level, so a bare pass-through
    // handed sha256Hex a non-string. They are written as `null`, the same way an undefined array
    // member already is.
    for (const v of [undefined, () => 1, Symbol('s')]) expect(canonicalJson(v)).toBe('null')
    expect(canonicalJson([undefined, () => 1])).toBe('[null,null]')
  })
})
