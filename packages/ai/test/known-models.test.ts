import { describe, expect, it } from 'vitest'
import { knownModel } from '../src/known-models.js'

const DEEPSEEK = { contextWindow: 1_000_000, maxTokens: 256_000, thinkingReplay: 'native' }

describe('knownModel', () => {
  it('matches DeepSeek V4 ids and dated v4.1 flash builds', () => {
    expect(knownModel('deepseek-v4.1-flash-1017')).toEqual(DEEPSEEK)
    expect(knownModel('deepseek-v4.1-flash')).toEqual(DEEPSEEK)
    expect(knownModel('deepseek-v4-pro')).toEqual(DEEPSEEK)
    expect(knownModel('deepseek-v4-flash')).toEqual(DEEPSEEK)
  })
  it('does not match other ids', () => {
    expect(knownModel('deepseek-v4.10-flash')).toBeUndefined()
    expect(knownModel('deepseek-v4-pro-max')).toBeUndefined()
    expect(knownModel('gpt-4o')).toBeUndefined()
  })
})
