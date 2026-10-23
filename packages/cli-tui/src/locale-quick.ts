import type { Locale } from './locale.js'

/**
 * Strings of the quick keys: cycling models, stashing the draft and redrawing. Merged into the key
 * table's dictionary (locale-keys.ts), so the larger locale files stay under the source-size limit.
 */
export type QuickAction = 'model-next' | 'model-prev'
export type QuickKey = `keys.act.${QuickAction}` | 'model.noOther'

export const QUICK_DICT: Record<Locale, Record<QuickKey, string>> = {
  en: {
    'keys.act.model-next': 'Switch to the next model in the /model list',
    'keys.act.model-prev': 'Switch to the previous model in the /model list',
    'model.noOther': 'No other model to switch to',
  },
  'zh-CN': {
    'keys.act.model-next': '切到 /model 列表里的下一个模型',
    'keys.act.model-prev': '切到 /model 列表里的上一个模型',
    'model.noOther': '没有其他可切换的模型',
  },
}
