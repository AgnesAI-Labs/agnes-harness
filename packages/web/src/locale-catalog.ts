import type { LocaleCatalog } from '@agnes/web-client'

/** 宿主内置文案的命名空间。第一期只覆盖语言开关自身。 */
export const WEB_LOCALE_NAMESPACE = '@agnes/web'

export const webLocaleCatalog: LocaleCatalog = {
  en: {
    'settings.appearance.language': 'Language',
    'settings.appearance.language.en': 'English',
    'settings.appearance.language.en.hint': 'Show the workbench in English',
    'settings.appearance.language.zh-CN': '简体中文',
    'settings.appearance.language.zh-CN.hint': 'Show the workbench in Simplified Chinese',
  },
  'zh-CN': {
    'settings.appearance.language': '语言',
    'settings.appearance.language.en': 'English',
    'settings.appearance.language.en.hint': '使用英文界面',
    'settings.appearance.language.zh-CN': '简体中文',
    'settings.appearance.language.zh-CN.hint': '使用简体中文界面',
  },
}
