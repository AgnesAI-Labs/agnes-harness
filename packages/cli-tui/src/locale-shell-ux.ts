import type { Locale } from './locale.js'

/** Strings of Ctrl-Z suspend and custom colour themes, kept out of the larger locale files. */
export type ShellUxKey = 'keys.act.suspend'

export const SHELL_UX_DICT: Record<Locale, Record<ShellUxKey, string>> = {
  en: {
    'keys.act.suspend':
      'Suspend to the shell when the draft is empty (otherwise this key undoes); fg brings it back',
  },
  'zh-CN': {
    'keys.act.suspend': '输入框为空时挂起到 shell（有内容时此键仍是撤销）；fg 恢复',
  },
}
