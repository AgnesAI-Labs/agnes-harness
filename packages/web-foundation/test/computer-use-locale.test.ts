import { describe, expect, it } from 'vitest'
import { computerUseCatalog } from '../src/locales/computer-use.js'

describe('computer use locale catalog', () => {
  it('gives English and Simplified Chinese the same keys', () => {
    const english = Object.keys(computerUseCatalog.en ?? {}).sort()
    const chinese = Object.keys(computerUseCatalog['zh-CN'] ?? {}).sort()
    expect(chinese).toEqual(english)
    expect(english.length).toBeGreaterThan(0)
    for (const key of english) {
      expect(computerUseCatalog.en?.[key]).toBeTruthy()
      expect(computerUseCatalog['zh-CN']?.[key]).toBeTruthy()
    }
  })
})
