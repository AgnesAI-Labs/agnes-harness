import type { LocaleCatalog } from './index.js'

/**
 * 会话级模型配置弹窗的文案（composer 的「思考 · 上下文」入口）。
 * 思考档位标签与服务端档位值分开：标签走目录，值（off/low/high…）仍作为选项值原样传递。
 */
export const MODEL_SETTINGS_LOCALE_NAMESPACE = '@agnes/web-ui/model-settings'

export const modelSettingsLocaleCatalog: LocaleCatalog = {
  en: {
    'modelSettings.thinking.off': 'Off',
    'modelSettings.thinking.minimal': 'Minimal',
    'modelSettings.thinking.low': 'Low',
    'modelSettings.thinking.medium': 'Medium',
    'modelSettings.thinking.high': 'High',
    'modelSettings.thinking.xhigh': 'Very high',
    'modelSettings.thinking.max': 'Max',
    'modelSettings.thinking.auto': 'Automatic (provider default)',
    'modelSettings.trigger': 'Thinking · context',
    'modelSettings.triggerAria': "Configure this session's reasoning level and context budget",
    'modelSettings.title': 'Model settings for this session',
    'modelSettings.ok': 'Apply to this session',
    'modelSettings.cancel': 'Cancel',
    'modelSettings.intro':
      'Applies only to later requests in this session; it is kept when the session is reopened.',
    'modelSettings.thinkingLabel': 'Reasoning level',
    'modelSettings.savedThinkingUnavailable': 'The saved level is currently unavailable: {value}',
    'modelSettings.windowLabel': 'Context budget for this session (tokens)',
    'modelSettings.windowPlaceholder': 'Automatic · {tokens}',
    'modelSettings.windowHint':
      'Model capacity {tokens} tokens. Enter 100K (100,000 tokens) or the full number; leave empty to restore the automatic value. A smaller budget compacts the context earlier.',
    'modelSettings.windowRange':
      'Enter a positive integer between {min} and {max} tokens. K/M units are accepted.',
    'modelSettings.thinkingUnsupported':
      'The model does not support the saved reasoning level. Choose another.',
    'modelSettings.saveFailed': 'The configuration was not saved. Check the connection or try again.',
    'modelSettings.saveError': 'Saving the configuration failed',
  },
  'zh-CN': {
    'modelSettings.thinking.off': '关闭',
    'modelSettings.thinking.minimal': '最低',
    'modelSettings.thinking.low': '低',
    'modelSettings.thinking.medium': '中',
    'modelSettings.thinking.high': '高',
    'modelSettings.thinking.xhigh': '更高',
    'modelSettings.thinking.max': '最高',
    'modelSettings.thinking.auto': '自动（Provider 默认）',
    'modelSettings.trigger': '思考 · 上下文',
    'modelSettings.triggerAria': '配置本会话的思考强度和上下文预算',
    'modelSettings.title': '本会话模型配置',
    'modelSettings.ok': '应用到本会话',
    'modelSettings.cancel': '取消',
    'modelSettings.intro': '仅影响本会话的后续请求，重新打开会话后仍会保留。',
    'modelSettings.thinkingLabel': '思考强度',
    'modelSettings.savedThinkingUnavailable': '已保存的档位当前不可用：{value}',
    'modelSettings.windowLabel': '本会话上下文预算（Token）',
    'modelSettings.windowPlaceholder': '自动 · {tokens}',
    'modelSettings.windowHint':
      '模型容量 {tokens} Token。可输入 100K（100,000 Token）或完整数量；留空恢复自动。较小预算会提前整理上下文。',
    'modelSettings.windowRange': '请输入 {min} 至 {max} 之间的正整数 Token，可使用 K/M 单位。',
    'modelSettings.thinkingUnsupported': '该模型当前不支持已保存的思考强度，请重新选择。',
    'modelSettings.saveFailed': '配置未保存，请检查连接或重试。',
    'modelSettings.saveError': '配置保存失败',
  },
}
