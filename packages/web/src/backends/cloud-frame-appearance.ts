import {
  applyDocumentLocale,
  isUiLocale,
  LOCALE_STORAGE_KEY,
  readLocalePreference,
  writeLocalePreference,
} from '@agnes/web-foundation/locale-preference'
import {
  applyFontScale,
  applyTheme,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  isThemePreference,
  readFontScale,
  readThemePreference,
  resolveTheme,
  safeThemeStorage,
  THEME_STORAGE_KEY,
  writeFontScale,
  writeThemePreference,
} from '@agnes/web-foundation/theme'

/** Only presentation preferences cross the boundary; never copy either origin's storage. */
export function cloudFrameAppearance() {
  const storage = safeThemeStorage()
  return {
    locale: readLocalePreference(storage),
    theme: readThemePreference(storage),
    fontScale: readFontScale(storage),
  }
}

export function applyCloudFrameAppearance(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const p = value as Record<string, unknown>
  if (!isUiLocale(p.locale) || !isFontScale(p.fontScale) || !isThemePreference(p.theme)) return
  const storage = safeThemeStorage()
  writeLocalePreference(storage, p.locale)
  writeThemePreference(storage, p.theme)
  writeFontScale(storage, p.fontScale)
  applyDocumentLocale(document.documentElement, p.locale)
  applyTheme(
    document.documentElement,
    resolveTheme(p.theme, matchMedia('(prefers-color-scheme: dark)').matches),
  )
  applyFontScale(document.documentElement, p.fontScale)
  for (const key of [LOCALE_STORAGE_KEY, THEME_STORAGE_KEY, FONT_SCALE_STORAGE_KEY])
    window.dispatchEvent(new StorageEvent('storage', { key }))
}

export function syncWorkbenchAppearance(): void {
  document.body.dataset.aghBackendWorkbench = 'true'
  const storage = safeThemeStorage()
  const sync = () => {
    applyDocumentLocale(document.documentElement, readLocalePreference(storage))
    applyTheme(
      document.documentElement,
      resolveTheme(readThemePreference(storage), matchMedia('(prefers-color-scheme: dark)').matches),
    )
    applyFontScale(document.documentElement, readFontScale(storage))
  }
  sync()
  window.addEventListener('storage', sync)
}
