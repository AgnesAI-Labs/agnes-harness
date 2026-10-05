import type { LocaleCatalog } from './index.js'

/**
 * 会话级模型配置（composer 模型面板里的「思考强度」与「上下文预算」两段）的文案。
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
    'modelSettings.thinkingLabel': 'Reasoning level',
    'modelSettings.savedThinkingUnavailable': 'The saved level is currently unavailable: {value}',
    'modelSettings.detailAria': "Settings for this session's model",
    'modelSettings.capacityLabel': 'Model capacity',
    'modelSettings.windowLabel': 'Context window',
    'modelSettings.presetAuto': 'Automatic',
    'modelSettings.customAria': 'Custom context budget in tokens',
    'modelSettings.windowPlaceholder': 'Automatic · {tokens}',
    'modelSettings.windowHint':
      'Model capacity {tokens} tokens. Enter 100K (100,000 tokens) or the full number; leave empty to restore the automatic value. A smaller budget compacts the context earlier.',
    'modelSettings.windowRange':
      'Enter a positive integer between {min} and {max} tokens. K/M units are accepted.',
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
    'modelSettings.thinkingLabel': '思考强度',
    'modelSettings.savedThinkingUnavailable': '已保存的档位当前不可用：{value}',
    'modelSettings.detailAria': '所选模型的会话设置',
    'modelSettings.capacityLabel': '模型容量',
    'modelSettings.windowLabel': '上下文窗口',
    'modelSettings.presetAuto': '自动',
    'modelSettings.customAria': '自定义上下文预算（Token）',
    'modelSettings.windowPlaceholder': '自动 · {tokens}',
    'modelSettings.windowHint':
      '模型容量 {tokens} Token。可输入 100K（100,000 Token）或完整数量；留空恢复自动。较小预算会提前整理上下文。',
    'modelSettings.windowRange': '请输入 {min} 至 {max} 之间的正整数 Token，可使用 K/M 单位。',
  },
}
