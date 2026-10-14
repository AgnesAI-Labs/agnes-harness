/** @vitest-environment happy-dom */

import { bindAppearance } from '@agnes/web-foundation/appearance'
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
  const picker = document.querySelector<HTMLSelectElement>('#appearance-settings-pane #locale-select')!
  // The picker is named by its setting row's label.
  const label = document.getElementById(picker.getAttribute('aria-labelledby') ?? '')
  expect(label?.textContent).toBe(webLocaleCatalog.en?.['settings.appearance.language'])
  const storage = safeThemeStorage()
  bindAppearance({
    scope: document,
    root: document.documentElement,
    storage,
    locale: {
      rendered: true,
      current: () => runtime.locale.locale,
      select: (value) => {
        writeLocalePreference(storage, value)
        window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: value }))
      },
      text: (key) => runtime.locale.t(key),
    },
  })

  const originalSetItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === LOCALE_STORAGE_KEY) throw new Error('storage unavailable')
    originalSetItem(key, value)
  })
  expect([...picker.options].map((option) => option.value)).toEqual(['en', 'zh-CN'])
  picker.value = 'zh-CN'
  picker.dispatchEvent(new Event('change', { bubbles: true }))

  expect(runtime.locale.locale).toBe('zh-CN')
  expect(document.documentElement.lang).toBe('zh-CN')
  await vi.waitFor(() =>
    expect(label?.textContent).toBe(webLocaleCatalog['zh-CN']?.['settings.appearance.language']),
  )
  expect(picker.value).toBe('zh-CN')

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
