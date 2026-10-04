/** @vitest-environment happy-dom */
import { resolveUiLocale } from '@agnes/web-client'
import { describe, expect, it } from 'vitest'
import { webLocaleCatalog } from '../src/locale-catalog.js'
import {
  applyDocumentLocale,
  applyLocaleText,
  LOCALE_STORAGE_KEY,
  readLocalePreference,
  syncLocaleRadios,
  writeLocalePreference,
} from '../src/locale-preference.js'

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => void map.set(key, value),
    read: (key: string): string | undefined => map.get(key),
  }
}

describe('locale preference', () => {
  it('matches the client locale resolver and defaults to English', () => {
    const storage = fakeStorage()
    expect(readLocalePreference(storage)).toBe('en')
    expect(readLocalePreference(storage)).toBe(resolveUiLocale(null))
    for (const value of ['en', 'zh-CN', 'fr', 'zh']) {
      const stored = fakeStorage({ [LOCALE_STORAGE_KEY]: value })
      expect(readLocalePreference(stored)).toBe(resolveUiLocale(value))
    }
  })

  it('keeps a failed write from throwing', () => {
    const hostile = {
      getItem: (): string | null => null,
      setItem: (): void => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => writeLocalePreference(hostile, 'zh-CN')).not.toThrow()
    const denied = {
      getItem: (): string | null => {
        throw new Error('denied')
      },
    }
    expect(readLocalePreference(denied)).toBe('en')
  })

  it('applies the document language and the language-switch copy', () => {
    document.body.innerHTML = `
      <section data-i18n-aria="settings.appearance.language" aria-label="Language">
        <span data-i18n="settings.appearance.language">Language</span>
        <input data-i18n-placeholder="settings.appearance.language" placeholder="Language" />
        <button data-i18n-title="settings.appearance.language" title="Language"></button>
        <input type="radio" name="agnes-locale" value="en" checked />
        <input type="radio" name="agnes-locale" value="zh-CN" />
      </section>
    `
    applyDocumentLocale(document.documentElement, 'zh-CN')
    syncLocaleRadios(document, 'zh-CN')
    applyLocaleText(document, (key) => webLocaleCatalog['zh-CN']?.[key] ?? key)
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.querySelector('[data-i18n="settings.appearance.language"]')?.textContent).toBe('语言')
    expect(document.querySelector('section')?.getAttribute('aria-label')).toBe('语言')
    expect(document.querySelector('[data-i18n-placeholder]')?.getAttribute('placeholder')).toBe('语言')
    expect(document.querySelector('[data-i18n-title]')?.getAttribute('title')).toBe('语言')
    expect(document.querySelector<HTMLInputElement>('input[value="zh-CN"]')?.checked).toBe(true)
    expect(document.querySelector<HTMLInputElement>('input[value="en"]')?.checked).toBe(false)
  })

  it('gives English and Simplified Chinese the same keys', () => {
    const english = Object.keys(webLocaleCatalog.en ?? {}).sort()
    const chinese = Object.keys(webLocaleCatalog['zh-CN'] ?? {}).sort()
    expect(chinese).toEqual(english)
    expect(english.length).toBeGreaterThan(0)
    for (const key of english) {
      expect(webLocaleCatalog.en?.[key]).toBeTruthy()
      expect(webLocaleCatalog['zh-CN']?.[key]).toBeTruthy()
    }
  })
})
