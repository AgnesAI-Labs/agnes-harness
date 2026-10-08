/** @vitest-environment happy-dom */

import { LOCALE_STORAGE_KEY, writeLocalePreference } from '@agnes/web-foundation/locale-preference'
import { indexShellLocaleCatalog } from '@agnes/web-foundation/locales/index-shell'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.removeAttribute('data-agnes-shell')
  document.body.replaceChildren()
})

it('keeps the selected locale through theme repaint after a failed storage write', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  document.documentElement.dataset.agnesShell = 'workbench'
  document.body.innerHTML = '<button data-i18n="index-shell.skip">Skip to main content</button>'
  vi.resetModules()
  await import('../src/theme-boot.js')

  const skipLink = document.querySelector<HTMLButtonElement>('[data-i18n="index-shell.skip"]')
  expect(skipLink?.textContent).toBe(indexShellLocaleCatalog.en?.['index-shell.skip'])

  const originalSetItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === LOCALE_STORAGE_KEY) throw new Error('storage unavailable')
    originalSetItem(key, value)
  })
  writeLocalePreference(safeThemeStorage(), 'zh-CN')
  window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'zh-CN' }))

  expect(document.documentElement.lang).toBe('zh-CN')
  expect(skipLink?.textContent).toBe(indexShellLocaleCatalog['zh-CN']?.['index-shell.skip'])

  window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
  expect(document.documentElement.lang).toBe('zh-CN')
  expect(skipLink?.textContent).toBe(indexShellLocaleCatalog['zh-CN']?.['index-shell.skip'])
})
