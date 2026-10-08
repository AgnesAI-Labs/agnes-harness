import { describe, expect, it } from 'vitest'
import { serverErrorCatalog } from '../src/locales/server-errors.js'

describe('server error locale catalog', () => {
  it('gives English and Simplified Chinese the same keys', () => {
    const english = Object.keys(serverErrorCatalog.en ?? {}).sort()
    const chinese = Object.keys(serverErrorCatalog['zh-CN'] ?? {}).sort()
    expect(chinese).toEqual(english)
    expect(english.length).toBeGreaterThan(0)
    for (const key of english) {
      expect(key.startsWith('error.')).toBe(true)
      expect(serverErrorCatalog.en?.[key]).toBeTruthy()
      expect(serverErrorCatalog['zh-CN']?.[key]).toBeTruthy()
    }
  })
})
