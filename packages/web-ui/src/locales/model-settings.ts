import type { LocaleCatalog } from './index.js'

/**
 * 会话级模型配置（composer 模型面板里的「思考强度」与「上下文预算」两段）的文案。
 * 思考档位标签与服务端档位值分开：标签走目录，值（off/low/high…）仍作为选项值原样传递。
 */
export const MODEL_SETTINGS_LOCALE_NAMESPACE = '@agnes/web-ui/model-settings'

export const modelSettingsLocaleCatalog: LocaleCatalog = {
  en: {
    'modelSettings.slots.saveSession': 'Save {slot} for this session',
    'modelSettings.slots.title': 'Auxiliary models',
    'modelSettings.slots.help':
      'Models for background work. Applies to new sessions; each choice is saved as you make it.',
    'modelSettings.slots.fast': 'Fast model',
    'modelSettings.slots.fastHelp': 'Used for auto review and summaries.',
    'modelSettings.slots.verifier': 'Verifier model',
    'modelSettings.slots.verifierHelp':
      'Used by auto review and verification plugins. Unset, reviews are left to you.',
    'modelSettings.slots.model': 'Model',
    'modelSettings.slots.unset': 'Not set',
    'modelSettings.slots.conflict': 'Changed elsewhere. Reload to see the saved models.',
    'modelSettings.slots.auto': 'Automatic · {model}',
    'modelSettings.slots.unavailable': 'Unavailable',
    'modelSettings.slots.loading': 'Loading auxiliary models…',
    'modelSettings.slots.reload': 'Reload',
    'modelSettings.slots.saved': 'Model settings saved. New sessions use these settings.',
    'modelSettings.slots.failed':
      'Could not read or save auxiliary models. Your choice is kept; reload and try again.',
    'modelSettings.slots.advanced': 'Auxiliary models (advanced)',
    'modelSettings.slots.sessionHelp':
      'Use different auxiliary models for this session only. Your defaults and the main model stay unchanged.',
    'modelSettings.slots.sessionSaved': 'Model settings saved. Applies to this session only.',
    'modelSettings.slots.sessionFailed': 'Could not save for this session',
    'modelSettings.slots.choose': 'Choose a model',
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
    'modelSettings.slots.saveSession': '为当前会话保存 {slot}',
    'modelSettings.slots.title': '辅助模型',
    'modelSettings.slots.help': '后台任务用的模型；对新会话生效，选完即保存。',
    'modelSettings.slots.fast': '快速模型',
    'modelSettings.slots.fastHelp': '自动审阅和摘要用。',
    'modelSettings.slots.verifier': '验证模型',
    'modelSettings.slots.verifierHelp': '自动审阅和验证类插件用；不设就由你确认。',
    'modelSettings.slots.model': '模型',
    'modelSettings.slots.unset': '未设置',
    'modelSettings.slots.conflict': '已在别处修改，重新加载。',
    'modelSettings.slots.auto': '自动 · {model}',
    'modelSettings.slots.unavailable': '不可用',
    'modelSettings.slots.loading': '正在加载辅助模型…',
    'modelSettings.slots.reload': '重新加载',
    'modelSettings.slots.saved': '模型设置已保存。新会话会使用这些设置。',
    'modelSettings.slots.failed': '辅助模型读取或保存失败，你的选择已保留；请重新加载后再试。',
    'modelSettings.slots.advanced': '辅助模型（高级）',
    'modelSettings.slots.sessionHelp': '只为当前会话更换辅助模型，默认设置和主模型保持不变。',
    'modelSettings.slots.sessionSaved': '模型设置已保存。仅用于当前会话。',
    'modelSettings.slots.sessionFailed': '未能为当前会话保存',
    'modelSettings.slots.choose': '选择模型',
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
