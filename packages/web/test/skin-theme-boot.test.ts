/** @vitest-environment happy-dom */
import { expect, it } from 'vitest'
import { SKIN_CACHE_VERSION, SKIN_STORAGE_KEY } from '../src/skin.js'
import { THEME_STORAGE_KEY } from '../src/theme.js'

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
  localStorage.clear()
})
