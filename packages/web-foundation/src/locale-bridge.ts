import type { LocaleVars } from '@agnes/web-client'
import { webLocaleCatalog } from './locale-catalog.js'

/**
 * Translation bridge for imperative web code: the host injects `LocaleService#t` via `setLocaleTranslator` at startup.
 * Call `tr()` during rendering/assembly without caching its result, so locale changes apply on the next render.
 */
let translator: (key: string, vars?: LocaleVars) => string = (key, vars) => {
  const locale = typeof document !== 'undefined' && document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'
  const value = webLocaleCatalog[locale]?.[key] ?? key
  return value.replace(/\{(\w+)\}/g, (match, name: string) => String(vars?.[name] ?? match))
}

export function setLocaleTranslator(next: (key: string, vars?: LocaleVars) => string): void {
  translator = next
}

export function tr(key: string, vars?: LocaleVars): string {
  return translator(key, vars)
}
