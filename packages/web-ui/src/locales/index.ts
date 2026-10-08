export type LocaleVars = Readonly<Record<string, string | number>>

/** web-ui 组件的取词合同：宿主注入 `LocaleService#t` 的稳定包装（props `t`）。 */
export type Translate = (key: string, vars?: LocaleVars) => string

export type LocaleDictionary = Record<string, string>

export type LocaleCatalog = { en: LocaleDictionary; 'zh-CN': LocaleDictionary }

export const WEB_UI_LOCALE_NAMESPACE = '@agnes/web-ui'

/** Standalone primitives resolve their shared catalog using the current document locale. */
export const fallbackT: Translate = (key, vars) => {
  const locale = typeof document !== 'undefined' && document.documentElement.lang === 'zh-CN' ? 'zh-CN' : 'en'
  const value = webUiLocaleCatalog[locale][key] ?? webUiLocaleCatalog.en[key] ?? key
  return value.replace(/\{([^}]+)\}/g, (match, name: string) => String(vars?.[name] ?? match))
}

import { conversationLocaleCatalog } from './conversation.js'
import { modelSettingsLocaleCatalog } from './model-settings.js'

const primitiveCatalog: LocaleCatalog = {
  en: {
    'settings.selectPicker.fallback': 'Choose {label}',
    'settings.selectPicker.ariaJoin': '{label}: {value}',
  },
  'zh-CN': {
    'settings.selectPicker.fallback': '选择{label}',
    'settings.selectPicker.ariaJoin': '{label}：{value}',
  },
}
const DICTS = [conversationLocaleCatalog, modelSettingsLocaleCatalog, primitiveCatalog] as const

export const webUiLocaleCatalog: LocaleCatalog = {
  en: Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict.en))),
  'zh-CN': Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict['zh-CN']))),
}
