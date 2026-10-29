import { trackInputModality } from '@agnes/web-foundation/input-modality'
import {
  applyDocumentLocale,
  isUiLocale,
  LOCALE_STORAGE_KEY,
  readLocalePreference,
} from '@agnes/web-foundation/locale-preference'
import {
  applySkinTokens,
  readSkinCache,
  SKIN_STORAGE_KEY,
  type SkinCache,
  type SkinSheetState,
  selectedSkin,
  skinOverride,
  syncSkinSheet,
} from '@agnes/web-foundation/skin'
import {
  applyFontScale,
  applyTheme,
  type ResolvedTheme,
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
/** One-time override (`?skin=none|<id>`) for this load only; never write it to the cache. */
const recovery = new URLSearchParams(window.location.search).has('admin')
const override = recovery ? 'none' : skinOverride(window.location.search)
let applicationSkin: SkinCache | null = null
let writtenSkinTokens: Set<string> = new Set()
let skinSheet: SkinSheetState = { sheet: undefined, css: undefined }

/**
 * Apply skin stylesheets through **constructed stylesheets + `adoptedStyleSheets`**.
 *
 * `<style>` is blocked by `style-src 'self'` without `unsafe-inline` (verified by a negative CSP test).
 * Constructed sheets are outside `style-src` and cascade **after** document stylesheets, overriding
 * `style.css` and avoiding the issue of this file being parsed before it.
 * If unsupported, omit only the sheet; tokens and theme still apply so an optional feature cannot block loading.
 */
const paintSkin = (mode: ResolvedTheme): void => {
  let user: string | null = null
  try {
    user = storage.getItem('agnes-skin-preference')
  } catch {
    /* Storage can be unavailable. */
  }
  const cached = readSkinCache(storage)
  const preferred =
    override !== null
      ? cached?.id === override
        ? cached
        : applicationSkin
      : user === 'none'
        ? null
        : (cached ?? applicationSkin)
  const skin = selectedSkin(preferred, override)
  writtenSkinTokens = applySkinTokens(document.documentElement, skin, mode, writtenSkinTokens)
  if (typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return
  try {
    // `syncSkinSheet` also **removes** its own sheet when the skin is disabled or has no stylesheet text:
    // leaving it would keep the previous skin coloring the page after tokens reflect the new selection.
    skinSheet = syncSkinSheet(document, skinSheet, skin?.css ?? '', () => new CSSStyleSheet())
  } catch {
    // Invalid CSS or engine refusal: keep the last applied state without clearing it or blocking the page.
  }
}

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
  paintSkin(mode)
  // The first frame runs after the blocking stylesheets; read the resolved skin surface too.
  requestAnimationFrame(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue('--agnes-bg-app-content').trim()
    if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
  })
}

paint()

// The focus ring is for keyboard navigation: remember how the user last acted, on all three pages.
trackInputModality(document)

// Subscribe unconditionally so switching from light to system takes effect without resubscribing.
watchSystemTheme(window, paint)

// Sync preference/skin changes from other same-origin documents (admin/resources iframes in settings).
// storage events fire only in other documents, so this cannot loop with its own writes.
window.addEventListener('storage', (event) => {
  if (event.key === LOCALE_STORAGE_KEY) {
    currentLocale = readLocalePreference(storage)
    paintLocale()
    return
  }
  if (event.key !== THEME_STORAGE_KEY && event.key !== SKIN_STORAGE_KEY) return
  paint()
})

// Same-document preference changes do not emit a storage event. Repaint skin tokens too.
window.addEventListener('agnes:theme-changed', paint)
window.addEventListener('agnes:locale-changed', (event) => {
  const next = (event as CustomEvent<unknown>).detail
  if (!isUiLocale(next)) return
  currentLocale = next
  paintLocale()
})

window.addEventListener('agnes:application-skin', (event) => {
  if (recovery) return
  applicationSkin = (event as CustomEvent<SkinCache | null>).detail
  paint()
})
