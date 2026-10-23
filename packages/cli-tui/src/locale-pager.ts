import type { Locale } from './locale.js'

/**
 * Strings of the Ctrl-T conversation pager. locale-keys.ts merges them into its dictionary, so
 * locale-extended.ts (already at the source-size limit) does not change.
 */
export type PagerKey = 'pager.hint' | 'pager.empty' | 'pager.status'

export const PAGER_DICT: Record<Locale, Record<PagerKey, string>> = {
  en: {
    'pager.hint': '↑↓ PgUp/PgDn Home/End scroll · Ctrl-T/Esc close',
    'pager.empty': '(nothing in this conversation yet)',
    'pager.status': 'lines {from}-{to}/{total}',
  },
  'zh-CN': {
    'pager.hint': '↑↓ PgUp/PgDn Home/End 滚动 · Ctrl-T/Esc 关闭',
    'pager.empty': '（这个对话里还没有内容）',
    'pager.status': '第 {from}-{to}/{total} 行',
  },
}
