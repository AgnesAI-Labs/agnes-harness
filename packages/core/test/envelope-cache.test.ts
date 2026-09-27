import { describe, expect, it } from 'vitest'
import { createEnvelopeCache } from '../src/request/envelope-cache.js'

describe('envelope wrapping memo', () => {
  it('keeps different nonces for one node in separate entries', () => {
    const memo = createEnvelopeCache()
    memo.set('12\0first', ['first wrapping'])
    memo.set('12\0second', ['second wrapping'])
    expect(memo.get('12\0first')).toEqual(['first wrapping'])
    expect(memo.get('12\0second')).toEqual(['second wrapping'])
  })
})
