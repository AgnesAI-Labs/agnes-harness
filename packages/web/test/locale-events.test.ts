/** @vitest-environment happy-dom */

import { webLocaleCatalog } from '@agnes/web-foundation/locale-catalog'
import { LOCALE_STORAGE_KEY, writeLocalePreference } from '@agnes/web-foundation/locale-preference'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { afterEach, expect, it, vi } from 'vitest'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  resetWebDom()
})

it('uses the same-document selection when storing the locale fails', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  const runtime = await mountRenderedIndex()
  const label = document.createElement('span')
  label.dataset.i18n = 'settings.appearance.language'
  label.textContent = 'Language'
  const english = document.createElement('input')
  english.type = 'radio'
  english.name = 'agnes-locale'
  english.value = 'en'
  const chinese = document.createElement('input')
  chinese.type = 'radio'
  chinese.name = 'agnes-locale'
  chinese.value = 'zh-CN'
  document.body.append(label, english, chinese)

  const originalSetItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === LOCALE_STORAGE_KEY) throw new Error('storage unavailable')
    originalSetItem(key, value)
  })
  writeLocalePreference(safeThemeStorage(), 'zh-CN')
  runtime.locale.setLocale('zh-CN')
  document.documentElement.lang = 'zh-CN'
  window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'zh-CN' }))

  expect(runtime.locale.locale).toBe('zh-CN')
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(label.textContent).toBe(webLocaleCatalog['zh-CN']?.['settings.appearance.language'])
  expect(chinese.checked).toBe(true)
  expect(english.checked).toBe(false)

  vi.restoreAllMocks()
  originalSetItem(LOCALE_STORAGE_KEY, 'en')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'en' }))
  expect(runtime.locale.locale).toBe('en')

  originalSetItem(LOCALE_STORAGE_KEY, 'zh-CN')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'zh-CN' }))
  expect(runtime.locale.locale).toBe('zh-CN')

  localStorage.removeItem(LOCALE_STORAGE_KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: null }))
  expect(runtime.locale.locale).toBe('en')
  await runtime.dispose()
})
