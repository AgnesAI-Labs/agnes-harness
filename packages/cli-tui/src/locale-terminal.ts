import type { Locale } from './locale.js'

/**
 * Strings of the terminal-level surfaces: pasted blocks, the exit hint, mouse and clipboard tips and
 * history search. They live beside locale-control.ts (locale-extended.ts merges them into `tt`) so
 * that file stays under the source-size limit.
 */
export const TERMINAL_KEYS = ['paste.chip', 'resume.hint'] as const

export type TerminalKey = (typeof TERMINAL_KEYS)[number]

export const TERMINAL_DICT: Record<Locale, Record<TerminalKey, string>> = {
  en: {
    'paste.chip': '[Pasted #{n} · {lines} lines]',
    'resume.hint': 'Resume this session: agh --resume {id}',
  },
  'zh-CN': {
    'paste.chip': '[粘贴 #{n} · {lines} 行]',
    'resume.hint': '恢复此会话：agh --resume {id}',
  },
}
