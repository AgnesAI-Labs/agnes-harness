/**
 * 界面语言偏好。未保存、非法值与读取失败一律回落英文。
 *
 * 取值与 `@agnes/web-client` 的 `resolveUiLocale` 保持一致：`en` | `zh-CN`。
 * 本模块不引用 web-client，以便首帧脚本 `theme-boot` 可以单独打进阻塞式 IIFE。
 */

export const UI_LOCALES = ['en', 'zh-CN'] as const
export type UiLocale = (typeof UI_LOCALES)[number]

export const LOCALE_STORAGE_KEY = 'agnes-locale'

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && (UI_LOCALES as readonly string[]).includes(value)
}

export function readLocalePreference(storage: Pick<Storage, 'getItem'>): UiLocale {
  try {
    const raw = storage.getItem(LOCALE_STORAGE_KEY)
    return isUiLocale(raw) ? raw : 'en'
  } catch {
    return 'en'
  }
}

/** 写失败不冒泡：本次切换仍应即时生效，只损失持久化。 */
export function writeLocalePreference(storage: Pick<Storage, 'setItem'>, value: UiLocale): void {
  try {
    storage.setItem(LOCALE_STORAGE_KEY, value)
  } catch {
    // 配额用尽或存储被禁用时静默降级。
  }
}

export type LocaleRoot = { lang: string }

export function applyDocumentLocale(root: LocaleRoot, locale: UiLocale): void {
  root.lang = locale
}

/** 把静态文案标记回填成当前语言。 */
export function applyLocaleText(root: ParentNode, translate: (key: string) => string): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = node.getAttribute('data-i18n')
    if (!key) continue
    node.textContent = translate(key)
  }
  for (const [marker, attribute] of [
    ['data-i18n-aria', 'aria-label'],
    ['data-i18n-placeholder', 'placeholder'],
    ['data-i18n-title', 'title'],
  ] as const) {
    for (const node of root.querySelectorAll<HTMLElement>(`[${marker}]`)) {
      const key = node.getAttribute(marker)
      if (!key) continue
      node.setAttribute(attribute, translate(key))
    }
  }
}

export function syncLocaleRadios(root: ParentNode, locale: UiLocale): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('input[name="agnes-locale"]')) {
    const checked = input.value === locale
    if (input.checked !== checked) input.checked = checked
  }
}
