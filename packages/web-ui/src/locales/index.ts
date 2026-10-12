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
import { firstRunCatalog } from './first-run.js'
import { modelSettingsLocaleCatalog } from './model-settings.js'

const primitiveCatalog: LocaleCatalog = {
  en: {
    'ui.close': 'Close',
    'ui.cancel': 'Cancel',
    'ui.confirm': 'Confirm',
    'ui.table': 'Data table',
    'ui.tableEmpty': 'No records to display.',
    'ui.dismiss': 'Dismiss',
    'ui.optional': '(optional)',
    'ui.unsaved': 'You have unsaved changes',
    'ui.discard': 'Discard',
    'ui.save': 'Save',
    'ui.saved': 'Saved',
    'ui.saving': 'Saving changes…',
    'accounts.empty': 'No saved model accounts yet.',
    'accounts.loading': 'Loading configuration…',
    'settings.selectPicker.fallback': 'Choose {label}',
    'settings.selectPicker.ariaJoin': '{label}: {value}',
  },
  'zh-CN': {
    'ui.close': '关闭',
    'ui.cancel': '取消',
    'ui.confirm': '确认',
    'ui.table': '数据表',
    'ui.tableEmpty': '没有可显示的记录。',
    'ui.dismiss': '关闭提示',
    'ui.optional': '（可选）',
    'ui.unsaved': '有未保存的更改',
    'ui.discard': '放弃',
    'ui.save': '保存',
    'ui.saved': '已保存',
    'ui.saving': '正在保存更改…',
    'accounts.empty': '还没有已保存的模型账户。',
    'accounts.loading': '正在读取配置…',
    'settings.selectPicker.fallback': '选择{label}',
    'settings.selectPicker.ariaJoin': '{label}：{value}',
  },
}
const DICTS = [
  firstRunCatalog,
  conversationLocaleCatalog,
  modelSettingsLocaleCatalog,
  primitiveCatalog,
] as const

export const webUiLocaleCatalog: LocaleCatalog = {
  en: Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict.en))),
  'zh-CN': Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict['zh-CN']))),
}
