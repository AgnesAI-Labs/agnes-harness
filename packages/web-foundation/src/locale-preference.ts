/**
 * UI locale preference: a valid saved value wins, then the browser preference; unsupported locales fall back to English.
 *
 * Keep the values aligned with `@agnes/web-client` resolveUiLocale: `en` | `zh-CN`.
 * Avoid importing web-client so the first-frame `theme-boot` script can be bundled as a blocking IIFE.
 */

export const UI_LOCALES = ['en', 'zh-CN'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

/**
 * Each language in its own name, which is how a language picker lists them. A new interface
 * language is added here and in the catalogs; the picker reads this list and needs no change.
 */
export const UI_LOCALE_NAMES: Readonly<Record<UiLocale, string>> = { en: 'English', 'zh-CN': '简体中文' }

export const LOCALE_STORAGE_KEY = 'agnes-locale'

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value)
}

export function readLocalePreference(
  storage: Pick<Storage, 'getItem'>,
  browserLanguage: string = typeof navigator === 'undefined' ? 'en' : navigator.language,
): UiLocale {
  const fallback: UiLocale = /^zh(?:-CN|-Hans(?:-CN)?)?$/i.test(browserLanguage) ? 'zh-CN' : 'en'
  try {
    const raw = storage.getItem(LOCALE_STORAGE_KEY)
    return isUiLocale(raw) ? raw : fallback
  } catch {
    return fallback
  }
}

/** Write failures do not propagate: apply the change immediately; only persistence is lost. */
export function writeLocalePreference(storage: Pick<Storage, 'setItem'>, value: UiLocale): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // Degrade silently when storage is full or disabled.
  }
}

export type LocaleRoot = { lang: string }

export function applyDocumentLocale(root: LocaleRoot, locale: UiLocale): void {
  root.lang = locale
}

/** Fill static text markers with the current locale. */
export function applyLocaleText(root: ParentNode, translate: (key: string) => string): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.getAttribute('data-i18n')
    if (!key) continue
    const value = translate(key)
    if (value !== key) node.textContent = value
  }
  for (const [marker, attribute] of [
    ['data-i18n-aria', 'aria-label'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
  ] as const) {
    for (const node of root.querySelectorAll<HTMLElement>(`[${marker}]`)) {
      const key = node.getAttribute(marker)
      if (!key) continue
      const value = translate(key)
      if (value !== key) node.setAttribute(attribute, value)
    }
  }
}

export function syncLocaleRadios(root: ParentNode, locale: UiLocale): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="agnes-locale"]')) {
    const checked = input.value === locale
    if (input.checked !== checked) input.checked = checked
  }
  const select = root.querySelector<HTMLSelectElement>('#locale-select')
  if (select && select.value !== locale) select.value = locale
}
