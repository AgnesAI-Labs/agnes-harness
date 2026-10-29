import type { Locale } from './locale.js'

/** Strings of `/config`, merged into the key dictionary by locale-keys.ts so locale-extended.ts does not grow. */
export type ConfigKey =
  | 'commands.config'
  | 'commands.configSummary'
  | 'config.name'
  | 'config.value'
  | 'config.change'
  | 'config.usage'
  | 'config.open'
  | 'config.folded'
  | 'config.allShown'
  | 'config.hidden'

export const CONFIG_DICT: Record<Locale, Record<ConfigKey, string>> = {
  en: {
    'commands.config':
      'Show every TUI preference with its current value and the command that changes it; /config NAME [VALUE] runs that command',
    'commands.configSummary': 'Show or change TUI settings',
    'config.name': 'Preference',
    'config.value': 'Value',
    'config.change': 'Change with',
    'config.usage': 'usage: /config [{names}] [value]',
    'config.open': 'open',
    'config.folded': 'folds',
    'config.allShown': 'all shown',
    'config.hidden': 'hidden: {fields}',
  },
  'zh-CN': {
    'commands.config': '列出全部 TUI 偏好、当前值和修改它的命令；/config 名称 [值] 等同于输入对应的命令',
    'commands.configSummary': '查看并修改 TUI 偏好',
    'config.name': '偏好',
    'config.value': '当前值',
    'config.change': '修改命令',
    'config.usage': '用法：/config [{names}] [值]',
    'config.open': '展开',
    'config.folded': '收起',
    'config.allShown': '全部显示',
    'config.hidden': '已隐藏：{fields}',
  },
}
