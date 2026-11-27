import { trackInputModality } from '@agnes/web-foundation/input-modality'
import {
  applyDocumentLocale,
  isUiLocale,
  LOCALE_STORAGE_KEY,
  readLocalePreference,
} from '@agnes/web-foundation/locale-preference'
import {
  applyFontScale,
  applyTheme,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  systemPrefersDark,
  THEME_STORAGE_KEY,
  watchSystemTheme,
} from '@agnes/web-foundation/theme'

/**
 * First-frame entry to prevent theme flicker.
 *
 * Bundle as an **IIFE** and place a blocking `<script src="/theme.js">` in all three pages' `<head>`:
 * module scripts defer, which would render a light frame before switching to dark.
 * CSP uses `script-src 'self'` without `unsafe-inline`, blocking the usual inline head script;
 * a standalone IIFE file is the viable solution.
 *
 * All actions tolerate failure: unavailable storage or `matchMedia` only degrades and must not block page loading.
 */

const storage = safeThemeStorage(window)
let currentLocale = readLocalePreference(storage)
const recovery = new URLSearchParams(window.location.search).has('admin')

const paintLocale = (): void => {
  applyDocumentLocale(document.documentElement, currentLocale)
}

/** Reread preferences each time so system theme changes follow the preference in effect at that moment. */
const paint = (): void => {
  const mode = resolveTheme(recovery ? 'system' : readThemePreference(storage), systemPrefersDark(window))
  applyTheme(document.documentElement, mode)
  // Set font size before the first frame too, avoiding a layout at 100% followed by a jump.
  applyFontScale(document.documentElement, readFontScale(storage))
  paintLocale()
}

const paintThemeColor = (): void => {
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--agnes-bg-app-content').trim()
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  })
}

const paintAppearance = () => {
  paint()
  paintThemeColor()
}
paintAppearance()

// The focus ring is for keyboard navigation: remember how the user last acted, on all three pages.
trackInputModality(document)

// Subscribe unconditionally so switching from light to system takes effect without resubscribing.
watchSystemTheme(window, paintAppearance)

// Storage events sync host preferences between documents. They never carry skin authority.
window.addEventListener('storage', (event) => {
  if (event.key === LOCALE_STORAGE_KEY) {
    currentLocale = readLocalePreference(storage)
    paintLocale()
    return
  }
  if (event.key === THEME_STORAGE_KEY) paintAppearance()
})

window.addEventListener('agnes:theme-changed', paintAppearance)
window.addEventListener('agnes:skin-painted', paintThemeColor)
window.addEventListener('agnes:locale-changed', (event) => {
  const next = (event as CustomEvent<unknown>).detail
  if (!isUiLocale(next)) return
  currentLocale = next
  paintLocale()
})
