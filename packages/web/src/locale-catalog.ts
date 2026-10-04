import type { LocaleCatalog } from '@agnes/web-client'
import { appLocaleCatalog } from './locales/app.js'
import { composerLocaleCatalog } from './locales/composer.js'
import { indexShellLocaleCatalog } from './locales/index-shell.js'
import { sessionLocaleCatalog } from './locales/session.js'
import { settingsLocaleCatalog } from './locales/settings.js'
import { timelineLocaleCatalog } from './locales/timeline.js'

/** 宿主内置文案的命名空间。第一期只覆盖语言开关自身。 */
export const WEB_LOCALE_NAMESPACE = '@agnes/web'

/** web 包各域目录的聚合点：新域只在这里追加一项。 */
const WEB_DICTS = [
  appLocaleCatalog,
  composerLocaleCatalog,
  indexShellLocaleCatalog,
  sessionLocaleCatalog,
  settingsLocaleCatalog,
  timelineLocaleCatalog,
] as const

const mergeLocale = (locale: 'en' | 'zh-CN'): Record<string, string> =>
  Object.fromEntries(WEB_DICTS.flatMap((dict) => Object.entries(dict[locale] ?? {})))

export const webLocaleCatalog: LocaleCatalog = {
  en: {
    'settings.appearance.language': 'Language',
    'settings.appearance.language.en': 'English',
    'settings.appearance.language.en.hint': 'Show the workbench in English',
    'settings.appearance.language.zh-CN': '简体中文',
    'settings.appearance.language.zh-CN.hint': 'Show the workbench in Simplified Chinese',
    ...mergeLocale('en'),
  },
  'zh-CN': {
    'settings.appearance.language': '语言',
    'settings.appearance.language.en': 'English',
    'settings.appearance.language.en.hint': '使用英文界面',
    'settings.appearance.language.zh-CN': '简体中文',
    'settings.appearance.language.zh-CN.hint': '使用简体中文界面',
    ...mergeLocale('zh-CN'),
  },
}
