import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/step/inference.js'

describe('estimateTokens', () => {
  it('keeps the existing chars/4 estimate for pure ASCII text, unchanged', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('1234')).toBe(1)
    expect(estimateTokens('12345678')).toBe(2)
  })

  it('prices CJK-range characters at roughly 1.7 characters per token, not 4', () => {
    // 4 CJK characters at /4 would read 1 token; at /1.7 it is ceil(4/1.7) = 3.
    expect(estimateTokens('你好世界')).toBe(3)
    expect(estimateTokens('日本語')).toBe(2)
    expect(estimateTokens('한국어')).toBe(2)
  })

  it("prices a mixed ASCII/CJK string per character, not by the string's dominant script", () => {
    // 2 ASCII chars at /4 (0.5) plus 2 CJK chars at /1.7 (1.176...) = 1.676..., ceil = 2.
    expect(estimateTokens('hi你好')).toBe(2)
  })
})
