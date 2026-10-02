/** web-units 不依赖 web-client：本地定义与 `LocaleService` 目录同构的类型（结构兼容即可）。 */
export type LocaleDictionary = Record<string, string>

export type LocaleCatalog = { en: LocaleDictionary; 'zh-CN': LocaleDictionary }

export type Translate = (key: string, vars?: Record<string, string | number>) => string

import { composerLocaleCatalog } from './composer.js'
import { conversationLocaleCatalog } from './conversation.js'
import { settingsShellLocaleCatalog } from './settings-shell.js'
import { sidebarLocaleCatalog } from './sidebar.js'
import { toolLocaleCatalog } from './tool.js'
import { topbarLocaleCatalog } from './topbar.js'

/** 组件内置文案目录，由宿主以命名空间 `@agnes/web-units` 注册进 `LocaleService`。 */
export const WEB_UNITS_LOCALE_NAMESPACE = '@agnes/web-units'

const DICTS = [
  composerLocaleCatalog,
  conversationLocaleCatalog,
  settingsShellLocaleCatalog,
  sidebarLocaleCatalog,
  toolLocaleCatalog,
  topbarLocaleCatalog,
] as const

export const webUnitsLocaleCatalog: LocaleCatalog = {
  en: Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict.en))),
  'zh-CN': Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict['zh-CN']))),
}
