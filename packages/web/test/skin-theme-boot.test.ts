/** @vitest-environment happy-dom */

import { LOCALE_STORAGE_KEY } from '@agnes/web-foundation/locale-preference'
import { THEME_STORAGE_KEY } from '@agnes/web-foundation/theme'
import { expect, it, vi } from 'vitest'

const SKIN_STORAGE_KEY = 'agnes-skin'

it('keeps the first frame and storage updates host-only, preserving theme and language', async () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light')
  localStorage.setItem(
    SKIN_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      id: 'mint',
      revision: 'sha256-test',
      css: 'body { --old-cache-must-not-paint: 1 }',
      tokens: { '--agnes-brand-primary': { light: '#167c55', dark: '#72d6aa' } },
    }),
  )
  const css = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync')
  await import('../src/theme-boot.js')
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
  localStorage.setItem(THEME_STORAGE_KEY, 'dark')
  window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY }))
  expect(css).not.toHaveBeenCalled()
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
  expect(document.documentElement.lang).toBe('en')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY }))
  expect(document.documentElement.lang).toBe('zh-CN')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'fr' }))
  expect(document.documentElement.lang).toBe('en')
  css.mockRestore()
  localStorage.clear()
})

it('does not evaluate cached application CSS or tokens in the independent admin bootstrap', async () => {
  history.replaceState({}, '', '/?admin&skin=broken')
  localStorage.setItem(
    SKIN_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      id: 'broken',
      revision: 'bad',
      css: 'body { display:none }',
      tokens: { '--agnes-brand-primary': { light: '#123456', dark: '#654321' } },
    }),
  )
  const css = vi.spyOn(CSSStyleSheet.prototype, 'replaceSync')
  vi.resetModules()
  await import('../src/theme-boot.js')
  expect(css).not.toHaveBeenCalled()
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
  css.mockRestore()
  history.replaceState({}, '', '/')
  localStorage.clear()
})
