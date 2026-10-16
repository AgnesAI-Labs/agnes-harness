import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  canonicalJson,
  clip,
  digest16,
  errorCode,
  fingerprint,
  pyJson,
  tail,
  utf8Bytes,
} from '../src/util.js'

describe('util', () => {
  it('serializes canonically and like Python json.dumps(sort_keys=True)', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}')
    expect(pyJson({ path: '.', limit: 200, offset: 1 })).toBe('{"limit": 200, "offset": 1, "path": "."}')
    expect(pyJson({ q: '中文' })).toBe('{"q": "中文"}')
  })
  it('hashes stably', () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }))
    expect(fingerprint('x')).toMatch(/^[0-9a-f]{32}$/)
    expect(digest16({ a: 1 })).toMatch(/^[0-9a-f]{16}$/)
  })
  it('hashes a string as given and any other value as canonical JSON', () => {
    expect(fingerprint('x')).toBe(createHash('sha256').update('x').digest('hex').slice(0, 32))
    expect(fingerprint('x')).not.toBe(fingerprint(['x']))
  })
  it('orders keys by code point, like Python sort_keys', () => {
    expect(canonicalJson({ '\u{1F600}': 1, '\uFFFF': 2 })).toBe('{"\uFFFF":2,"\u{1F600}":1}')
  })
  it('reads the string code of a thrown value', () => {
    expect(errorCode(Object.assign(new Error('x'), { code: 'E_X' }))).toBe('E_X')
    expect(errorCode(new Error('x'))).toBeUndefined()
    expect(errorCode(null)).toBeUndefined()
    expect(errorCode({ code: 7 })).toBeUndefined()
  })
  it('counts and clips text', () => {
    expect(utf8Bytes('中文a')).toBe(7)
    expect(utf8Bytes('😀')).toBe(4)
    expect(utf8Bytes('\ud83d')).toBe(3)
    expect(clip('abcdef', 3)).toBe('abc')
    expect(tail('abcdef', 2)).toBe('ef')
  })
})
