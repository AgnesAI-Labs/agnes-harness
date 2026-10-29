export type LocaleVars = Readonly<Record<string, string | number>>

/** web-ui translation contract: the host injects a stable `LocaleService#t` wrapper through the `t` prop. */
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

import { baseToolCatalog } from './base-tools.js'
import { conversationLocaleCatalog } from './conversation.js'
import { firstRunCatalog } from './first-run.js'
import { modelSettingsLocaleCatalog } from './model-settings.js'

const primitiveCatalog: LocaleCatalog = {
  en: {
    'ui.valueUnavailable': 'Saved value unavailable. Choose another value.',
    'ui.settingsSaved': 'Settings saved.',
    'ui.defaultsSaved': 'Defaults saved. New sessions use these settings.',
    'ui.restartRequired':
      'Restart the backend to apply these settings. Finish tasks, run daemon stop with the same home/profile, then run serve again.',
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
    'ui.copyFailed': 'Could not copy. Try again.',
    'ui.copiedNotice': 'Content copied.',
    'ui.copy': 'Copy',
    'ui.copied': 'Copied',
    'ui.save': 'Save',
    'ui.saved': 'Saved',
    'ui.saving': 'Saving changes…',
    'ui.on': 'On',
    'ui.off': 'Off',
    'ui.technicalDetails': 'Technical details',
    'ui.advanced': 'Advanced',
    'ui.advancedModels': 'Advanced: side models and task models',
    'ui.learnMore': 'Learn more',
    'ui.back': 'Back',
    'ui.breadcrumb': 'Breadcrumb',
    'ui.backTo': 'Back to {name}',
    'ui.backToPrefix': 'Back to ',
    'ui.stillLoading': 'Still loading…',
    'ui.loadFailed': 'Could not load.',
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
    'accounts.empty': 'Connect a model to start working',
    'accounts.loading': 'Loading configuration…',
    'settings.selectPicker.fallback': 'Choose {label}',
    'settings.selectPicker.ariaJoin': '{label}: {value}',
  },
  'zh-CN': {
    'ui.valueUnavailable': '已保存的值不可用，请重新选择。',
    'ui.settingsSaved': '设置已保存。',
    'ui.defaultsSaved': '默认设置已保存。新会话会使用这些设置。',
    'ui.restartRequired':
      '重启后台后生效。请先结束任务，在同一 home/profile 运行 daemon stop，再重新运行 serve。',
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
    'ui.copyFailed': '未能复制，请重试。',
    'ui.copiedNotice': '内容已复制。',
    'ui.copy': '复制',
    'ui.copied': '已复制',
    'ui.save': '保存',
    'ui.saved': '已保存',
    'ui.saving': '正在保存更改…',
    'ui.on': '已开启',
    'ui.off': '已关闭',
    'ui.technicalDetails': '技术详情',
    'ui.advanced': '高级',
    'ui.advancedModels': '高级：旁路模型与任务模型',
    'ui.learnMore': '了解更多',
    'ui.back': '返回',
    'ui.breadcrumb': '位置',
    'ui.backTo': '返回到 {name}',
    'ui.backToPrefix': '返回到 ',
    'ui.stillLoading': '仍在读取…',
    'ui.loadFailed': '读取失败。',
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
    'accounts.empty': '连接一个模型，就能开始工作',
    'accounts.loading': '正在读取配置…',
    'settings.selectPicker.fallback': '选择{label}',
    'settings.selectPicker.ariaJoin': '{label}：{value}',
  },
}
const DICTS = [
  firstRunCatalog,
  baseToolCatalog,
  conversationLocaleCatalog,
  modelSettingsLocaleCatalog,
  primitiveCatalog,
] as const

export const webUiLocaleCatalog: LocaleCatalog = {
  en: Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict.en))),
  'zh-CN': Object.fromEntries(DICTS.flatMap((dict) => Object.entries(dict['zh-CN']))),
}
