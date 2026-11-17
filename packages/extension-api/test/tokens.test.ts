import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/index.js'

describe('estimateTokens', () => {
  it('counts four Latin characters to a token, rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts CJK-range characters at about 1.7 to a token', () => {
    expect(estimateTokens('中文测试')).toBe(Math.ceil(4 / 1.7))
    expect(estimateTokens('日本語')).toBe(Math.ceil(3 / 1.7))
    expect(estimateTokens('한국어')).toBe(Math.ceil(3 / 1.7))
  })

  it('adds the two scripts per character in mixed text', () => {
    expect(estimateTokens('abcd中文测试')).toBe(Math.ceil(4 / 4 + 4 / 1.7))
    expect(estimateTokens('src/a.ts 修复')).toBe(Math.ceil(9 / 4 + 2 / 1.7))
  })
})
