import { describe, expect, it } from 'vitest'
import { canonicalJson, clip, digest16, fingerprint, pyJson, tail, utf8Bytes } from '../src/util.js'

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
  it('counts and clips text', () => {
    expect(utf8Bytes('中文a')).toBe(7)
    expect(clip('abcdef', 3)).toBe('abc')
    expect(tail('abcdef', 2)).toBe('ef')
  })
})
