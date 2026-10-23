import type { Locale } from './locale.js'

/**
 * Strings of the quick keys: cycling models, stashing the draft and redrawing. Merged into the key
 * table's dictionary (locale-keys.ts), so the larger locale files stay under the source-size limit.
 */
export type QuickAction = 'model-next' | 'model-prev' | 'draft-stash'
export type QuickKey =
  | `keys.act.${QuickAction}`
  | 'model.noOther'
  | 'stash.saved'
  | 'stash.savedFull'
  | 'stash.restored'
  | 'stash.empty'

export const QUICK_DICT: Record<Locale, Record<QuickKey, string>> = {
  en: {
    'keys.act.model-next': 'Switch to the next model in the /model list',
    'keys.act.model-prev': 'Switch to the previous model in the /model list',
    'keys.act.draft-stash':
      'Stash the draft and clear the prompt; on an empty prompt, bring the newest stashed draft back',
    'model.noOther': 'No other model to switch to',
    'stash.saved': 'Draft stashed ({n} in the stash); Ctrl-S on an empty prompt brings it back',
    'stash.savedFull': 'Draft stashed; the oldest of {n} was dropped',
    'stash.restored': 'Draft restored ({n} left in the stash)',
    'stash.empty': 'Nothing stashed',
  },
  'zh-CN': {
    'keys.act.model-next': '切到 /model 列表里的下一个模型',
    'keys.act.model-prev': '切到 /model 列表里的上一个模型',
    'keys.act.draft-stash': '暂存草稿并清空输入框；输入框为空时取回最近暂存的一条',
    'model.noOther': '没有其他可切换的模型',
    'stash.saved': '草稿已暂存（暂存区 {n} 条）；输入框为空时按 Ctrl-S 取回',
    'stash.savedFull': '草稿已暂存；最旧的一条（共 {n} 条）已丢弃',
    'stash.restored': '草稿已取回（暂存区还剩 {n} 条）',
    'stash.empty': '暂存区是空的',
  },
}
