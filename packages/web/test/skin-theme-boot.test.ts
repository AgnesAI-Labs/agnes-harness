/** @vitest-environment happy-dom */

import { LOCALE_STORAGE_KEY } from '@agnes/web-foundation/locale-preference'
import { SKIN_CACHE_VERSION, SKIN_STORAGE_KEY } from '@agnes/web-foundation/skin'
import { THEME_STORAGE_KEY } from '@agnes/web-foundation/theme'
import { expect, it, vi } from 'vitest'

it('repaints skin tokens on same-page theme changes and removes them when the skin cache clears', async () => {
  localStorage.setItem(THEME_STORAGE_KEY, 'light')
  localStorage.setItem(
    SKIN_STORAGE_KEY,
    JSON.stringify({
      version: SKIN_CACHE_VERSION,
      id: 'mint',
      revision: 'sha256-test',
      css: '',
      tokens: { '--agnes-brand-primary': { light: '#167c55', dark: '#72d6aa' } },
    }),
  )
  await import('../src/theme-boot.js')
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#167c55')
  localStorage.setItem(THEME_STORAGE_KEY, 'dark')
  window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#72d6aa')
  localStorage.removeItem(SKIN_STORAGE_KEY)
  window.dispatchEvent(new StorageEvent('storage', { key: SKIN_STORAGE_KEY }))
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
  expect(document.documentElement.lang).toBe('en')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY }))
  expect(document.documentElement.lang).toBe('zh-CN')
  localStorage.setItem(LOCALE_STORAGE_KEY, 'fr')
  window.dispatchEvent(new StorageEvent('storage', { key: LOCALE_STORAGE_KEY, newValue: 'fr' }))
  expect(document.documentElement.lang).toBe('en')
  const appSkin = {
    version: SKIN_CACHE_VERSION,
    id: 'acme',
    revision: 'app',
    css: '',
    tokens: { '--agnes-brand-primary': { light: '#123456', dark: '#654321' } },
  }
  window.dispatchEvent(new CustomEvent('agnes:application-skin', { detail: appSkin }))
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('#654321')
  localStorage.setItem('agnes-skin-preference', 'none')
  window.dispatchEvent(new CustomEvent('agnes:theme-changed'))
  expect(document.documentElement.style.getPropertyValue('--agnes-brand-primary')).toBe('')
  window.dispatchEvent(new CustomEvent('agnes:application-skin', { detail: null }))
  expect(localStorage.getItem('agnes-skin-preference')).toBe('none')
  localStorage.clear()
})

it('does not evaluate cached application CSS or tokens in the independent admin bootstrap', async () => {
  history.replaceState({}, '', '/?admin&skin=broken')
  localStorage.setItem(
    SKIN_STORAGE_KEY,
    JSON.stringify({
      version: SKIN_CACHE_VERSION,
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
