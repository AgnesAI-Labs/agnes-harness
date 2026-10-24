import type { Locale } from './locale.js'

/** The /keys note on clicking in the prompt: kept beside the other locale files so locale-extended.ts stays small. */
export type PromptClickKey = 'keys.promptClick'

export const PROMPT_CLICK_DICT: Record<Locale, Record<PromptClickKey, string>> = {
  en: {
    'keys.promptClick':
      'Mouse (fullscreen): click in the prompt to move the cursor; drag still selects and copies',
  },
  'zh-CN': {
    'keys.promptClick': '鼠标（全屏模式）：单击输入框可移动光标；拖动仍然是选中并复制',
  },
}
