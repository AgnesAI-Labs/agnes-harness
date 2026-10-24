/** web-units does not depend on web-client: define structurally compatible `LocaleService` catalog types locally. */
export type LocaleDictionary = Record<string, string>

export type LocaleCatalog = { en: LocaleDictionary; 'zh-CN': LocaleDictionary }

export type Translate = (key: string, vars?: Record<string, string | number>) => string

import { composerLocaleCatalog } from './composer.js'
import { conversationLocaleCatalog } from './conversation.js'
import { settingsShellLocaleCatalog } from './settings-shell.js'
import { sidebarLocaleCatalog } from './sidebar.js'
import { toolLocaleCatalog } from './tool.js'
import { topbarLocaleCatalog } from './topbar.js'

/** Built-in component catalog registered by the host in `LocaleService` under `@agnes/web-units`. */
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
