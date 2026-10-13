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
      'Choose the auxiliary models new sessions start with. Existing sessions keep their own. When no review model is set, reviews are handed to you; the main model is never used in its place.',
    'modelSettings.slots.fast': 'Fast · fast',
    'modelSettings.slots.fastHelp':
      'Used by auto review when selected; plugins may also use it for summaries.',
    'modelSettings.slots.verifier': 'Verifier · verifier',
    'modelSettings.slots.verifierHelp': 'Used by auto review when selected and by verification plugins.',
    'modelSettings.slots.model': 'Route / model',
    'modelSettings.slots.unset': 'Not set',
    'modelSettings.slots.unavailable': 'Unavailable',
    'modelSettings.slots.loading': 'Loading auxiliary models…',
    'modelSettings.slots.save': 'Save auxiliary models',
    'modelSettings.slots.reload': 'Reload',
    'modelSettings.slots.saved': 'Defaults saved for new sessions',
    'modelSettings.slots.failed':
      'Could not load or save auxiliary models. Your draft is retained; reload to resolve configuration changes.',
    'modelSettings.slots.advanced': 'Auxiliary models (advanced)',
    'modelSettings.slots.sessionHelp':
      'Change an auxiliary model for this session only. The defaults for new sessions and the main model stay unchanged.',
    'modelSettings.slots.sessionSaved': 'Session slot saved',
    'modelSettings.slots.sessionFailed': 'Could not save the session slot',
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
    'modelSettings.slots.help':
      '为新会话选择默认的辅助模型，已有会话保留各自的设置。没有设置审查模型时，审查会交给你处理，不会改用主模型。',
    'modelSettings.slots.fast': '快速 · fast',
    'modelSettings.slots.fastHelp': '选为审查档位时用于自动审查；插件也可将它用于摘要。',
    'modelSettings.slots.verifier': '验证器 · verifier',
    'modelSettings.slots.verifierHelp': '选为审查档位时用于自动审查，也供验证插件使用。',
    'modelSettings.slots.model': '路由 / 模型',
    'modelSettings.slots.unset': '未设置',
    'modelSettings.slots.unavailable': '不可用',
    'modelSettings.slots.loading': '正在加载辅助模型…',
    'modelSettings.slots.save': '保存辅助模型',
    'modelSettings.slots.reload': '重新加载',
    'modelSettings.slots.saved': '默认值已保存，适用于新会话',
    'modelSettings.slots.failed': '辅助模型读取或保存失败，草稿已保留；配置冲突时请重新加载。',
    'modelSettings.slots.advanced': '辅助模型（高级）',
    'modelSettings.slots.sessionHelp': '只更改当前会话的辅助模型。新会话的默认值和主模型保持不变。',
    'modelSettings.slots.sessionSaved': '会话档位已保存',
    'modelSettings.slots.sessionFailed': '会话档位保存失败',
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
