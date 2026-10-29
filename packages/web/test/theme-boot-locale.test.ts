/** @vitest-environment happy-dom */

import { LOCALE_STORAGE_KEY, writeLocalePreference } from '@agnes/web-foundation/locale-preference'
import { indexShellLocaleCatalog } from '@agnes/web-foundation/locales/index-shell'
import { safeThemeStorage } from '@agnes/web-foundation/theme'
import { afterEach, expect, it, vi } from 'vitest'

let disposeShell: (() => void) | undefined
afterEach(() => {
  disposeShell?.()
  disposeShell = undefined
  vi.restoreAllMocks()
  localStorage.clear()
  document.documentElement.removeAttribute('data-agnes-shell')
  document.body.replaceChildren()
})

it('keeps the selected locale through theme repaint after a failed storage write', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
  document.documentElement.dataset.agnesShell = 'workbench'
  document.body.innerHTML = '<div id="app-root"></div>'
  vi.resetModules()
  await import('../src/theme-boot.js')
  const { mountAppShell } = await import('../src/app-shell.js')
  disposeShell = mountAppShell().dispose

  const skipLink = document.querySelector<HTMLAnchorElement>('.skip-link')
  expect(skipLink?.textContent).toBe(indexShellLocaleCatalog.en?.['index-shell.skip'])

  const originalSetItem = localStorage.setItem.bind(localStorage)
  vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
    if (key === LOCALE_STORAGE_KEY) throw new Error('storage unavailable')
    originalSetItem(key, value)
  })
  writeLocalePreference(safeThemeStorage(), 'zh-CN')
  window.dispatchEvent(new CustomEvent('agnes:locale-changed', { detail: 'zh-CN' }))

  expect(document.documentElement.lang).toBe('zh-CN')
  await vi.waitFor(() =>
    expect(skipLink?.textContent).toBe(indexShellLocaleCatalog['zh-CN']?.['index-shell.skip']),
  )

  window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
  expect(document.documentElement.lang).toBe('zh-CN')
  await vi.waitFor(() =>
    expect(skipLink?.textContent).toBe(indexShellLocaleCatalog['zh-CN']?.['index-shell.skip']),
  )
})
