import type { LocaleCatalog } from '@agnes/web-client'
import { appLocaleCatalog } from './locales/app.js'
import { composerLocaleCatalog } from './locales/composer.js'
import { goalLocaleCatalog } from './locales/goal.js'
import { homeLocaleCatalog } from './locales/home.js'
import { indexShellLocaleCatalog } from './locales/index-shell.js'
import { sessionLocaleCatalog } from './locales/session.js'
import { settingsLocaleCatalog } from './locales/settings.js'
import { timelineLocaleCatalog } from './locales/timeline.js'
import { toolCardsLocaleCatalog } from './locales/tool-cards.js'

/** Namespace for host built-in text. Initially covers only the locale switch itself. */
export const WEB_LOCALE_NAMESPACE = '@agnes/web'

/** Aggregation point for web domain catalogs: add each new domain here. */
const WEB_DICTS = [
  appLocaleCatalog,
  goalLocaleCatalog,
  homeLocaleCatalog,
  composerLocaleCatalog,
  indexShellLocaleCatalog,
  sessionLocaleCatalog,
  settingsLocaleCatalog,
  timelineLocaleCatalog,
  toolCardsLocaleCatalog,
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
