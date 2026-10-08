import type { LocaleVars } from '@agnes/web-client'
import { webLocaleCatalog } from './locale-catalog.js'

/**
 * web 包内部命令式代码的取词桥：宿主启动时 `setLocaleTranslator` 注入 `LocaleService#t`。
 * 调用方必须在渲染/组装瞬间调用 `tr()`，不缓存结果——切换语言后下一次渲染即生效。
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
