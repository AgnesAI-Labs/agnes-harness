import type { LocaleCatalog, LocaleVars } from '@agnes/web-client'
import { comparisonLocaleCatalog } from './locale-comparison.js'
import { comparisonPanelsLocaleCatalog } from './locale-comparison-panels.js'
import { decisionGraphLocaleCatalog } from './locale-decision-graph.js'
import { entryLocaleCatalog } from './locale-entry.js'
import { workspaceLocaleCatalog } from './locale-workspace.js'

/** jev-web 插件文案的注册命名空间（= 包 id）。 */
export const JEV_LOCALE_NAMESPACE = '@agnes/jev-web'

/** 各模块使用的翻译函数：key → 当前语言文案，`{name}` 占位符由 vars 填充。 */
export type Translate = (key: string, vars?: LocaleVars) => string

const JEV_DICTS = [
  entryLocaleCatalog,
  decisionGraphLocaleCatalog,
  workspaceLocaleCatalog,
  comparisonLocaleCatalog,
  comparisonPanelsLocaleCatalog,
] as const

const mergeLocale = (locale: 'en' | 'zh-CN'): Record<string, string> =>
  Object.fromEntries(JEV_DICTS.flatMap((dict) => Object.entries(dict[locale] ?? {})))

export const jevLocaleCatalog: LocaleCatalog = {
  en: mergeLocale('en'),
  'zh-CN': mergeLocale('zh-CN'),
}

/** 测试与离线工具用：按指定语言直接查合并目录，无需宿主服务。 */
export function createJevTranslate(locale: 'en' | 'zh-CN'): Translate {
  const dict = locale === 'en' ? jevLocaleCatalog.en : jevLocaleCatalog['zh-CN']
  return (key, vars) => {
    const template = dict?.[key] ?? key
    if (!vars) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match,
    )
  }
}
