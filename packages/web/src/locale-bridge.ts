import type { LocaleVars } from '@agnes/web-client'

/**
 * web 包内部命令式代码的取词桥：宿主启动时 `setLocaleTranslator` 注入 `LocaleService#t`。
 * 调用方必须在渲染/组装瞬间调用 `tr()`，不缓存结果——切换语言后下一次渲染即生效。
 */
let translator: (key: string, vars?: LocaleVars) => string = (key) => key

export function setLocaleTranslator(next: (key: string, vars?: LocaleVars) => string): void {
  translator = next
}

export function tr(key: string, vars?: LocaleVars): string {
  return translator(key, vars)
}
