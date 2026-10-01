import type { LocaleVars } from '@agnes/web-client'

/** web-ui 组件的取词合同：宿主注入 `LocaleService#t` 的稳定包装（props `t`）。 */
export type Translate = (key: string, vars?: LocaleVars) => string

export type LocaleDictionary = Record<string, string>

export type LocaleCatalog = { en: LocaleDictionary; 'zh-CN': LocaleDictionary }

export const WEB_UI_LOCALE_NAMESPACE = '@agnes/web-ui'

/** 组件未拿到宿主注入时的兜底：显示 key 本身，让漏接线在界面上可见。 */
export const fallbackT: Translate = (key) => key

import { conversationLocaleCatalog } from './conversation.js'

const DICTS = [conversationLocaleCatalog] as const

export const webUiLocaleCatalog: LocaleCatalog = {
  en: Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict.en))),
  'zh-CN': Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict['zh-CN']))),
}
