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
    'ui.regionError': 'This region failed',
    'ui.retry': 'Retry',
    'ui.close': 'Close',
    'ui.cancel': 'Cancel',
    'ui.confirm': 'Confirm',
    'ui.table': 'Data table',
    'ui.tableEmpty': 'No records to display.',
    'ui.dismiss': 'Dismiss',
    'ui.optional': '(optional)',
    'ui.unsaved': 'You have unsaved changes',
    'ui.discard': 'Discard',
    'ui.copy': 'Copy',
    'ui.copied': 'Copied',
    'ui.save': 'Save',
    'ui.saved': 'Saved',
    'ui.saving': 'Saving changes…',
    'ui.on': 'On',
    'ui.off': 'Off',
    'ui.technicalDetails': 'Technical details',
    'ui.advanced': 'Advanced',
    'ui.learnMore': 'Learn more',
    'ui.back': 'Back',
    'ui.saveFailed': 'Couldn’t save',
    'ui.readFailed': 'Couldn’t load.',
    'ui.loading': 'Loading…',
    'ui.default': 'Default',
    'ui.custom': 'Custom',
    'ui.seconds': '{count} s',
    'ui.minutes': '{count} min',
    'ui.add': 'Add',
    'ui.remove': 'Remove {label}',
    'ui.addPlaceholder': 'Type and press Enter',
    'ui.undone': 'Undone',
    'accounts.empty': 'No saved model accounts yet.',
    'accounts.loading': 'Loading configuration…',
    'settings.selectPicker.fallback': 'Choose {label}',
    'settings.selectPicker.ariaJoin': '{label}: {value}',
  },
  'zh-CN': {
    'ui.regionError': '该区域出错',
    'ui.retry': '重试',
    'ui.close': '关闭',
    'ui.cancel': '取消',
    'ui.confirm': '确认',
    'ui.table': '数据表',
    'ui.tableEmpty': '没有可显示的记录。',
    'ui.dismiss': '关闭提示',
    'ui.optional': '（可选）',
    'ui.unsaved': '有未保存的更改',
    'ui.discard': '放弃',
    'ui.copy': '复制',
    'ui.copied': '已复制',
    'ui.save': '保存',
    'ui.saved': '已保存',
    'ui.saving': '正在保存更改…',
    'ui.on': '已开启',
    'ui.off': '已关闭',
    'ui.technicalDetails': '技术详情',
    'ui.advanced': '高级',
    'ui.learnMore': '了解更多',
    'ui.back': '返回',
    'ui.saveFailed': '保存失败',
    'ui.readFailed': '读取失败。',
    'ui.loading': '正在读取…',
    'ui.default': '默认',
    'ui.custom': '自定义',
    'ui.seconds': '{count} 秒',
    'ui.minutes': '{count} 分钟',
    'ui.add': '添加',
    'ui.remove': '移除 {label}',
    'ui.addPlaceholder': '输入后按回车',
    'ui.undone': '已撤销',
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
