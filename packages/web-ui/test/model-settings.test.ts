import { describe, expect, it } from 'vitest'
import {
  contextBudgetLabel,
  contextBudgetPresets,
  modelThinkingOptions,
  parseContextBudget,
} from '../src/model-settings.js'
import { zhT } from './locale.js'

describe('model thinking options', () => {
  it('offers the provider default plus the levels the model declares', () => {
    expect(modelThinkingOptions({ low: 'low', high: 'high' }, zhT)).toEqual([
      { label: '自动（Provider 默认）', value: '' },
      { label: '低 · low', value: 'low' },
      { label: '高 · high', value: 'high' },
    ])
  })

  it('offers only the provider default when the model declares no levels', () => {
    expect(modelThinkingOptions(undefined, zhT)).toEqual([{ label: '自动（Provider 默认）', value: '' }])
  })
})

describe('context budget parsing', () => {
  it('reads a bare number as tokens and K/M as multipliers', () => {
    for (const [input, expected] of [
      ['100', 100],
      ['32K', 32000],
      ['0.032M', 32000],
      ['128000', 128000],
    ] as const)
      expect(parseContextBudget(input), input).toBe(expected)
  })

  it('rejects empty, malformed and non-positive values', () => {
    for (const input of ['', '   ', 'abc', '0', '-1', '1e6'])
      expect(parseContextBudget(input), input).toBeUndefined()
  })
})

describe('context budget presets', () => {
  it('keeps only the presets between the minimum budget and the model capacity', () => {
    expect(contextBudgetPresets(128000)).toEqual([32000, 64000, 128000])
    expect(contextBudgetPresets(20000)).toEqual([])
    expect(contextBudgetPresets(1_000_000)).toEqual([32000, 64000, 128000, 256000, 512000, 1000000])
  })

  it('labels token counts compactly, keeping one decimal for odd capacities', () => {
    expect(contextBudgetLabel(32000)).toBe('32K')
    expect(contextBudgetLabel(128000)).toBe('128K')
    expect(contextBudgetLabel(1000000)).toBe('1M')
    expect(contextBudgetLabel(131072)).toBe('131.1K')
    expect(contextBudgetLabel(2000)).toBe('2K')
    expect(contextBudgetLabel(0)).toBe('0')
  })
})
