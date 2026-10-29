import type { Locale } from './locale.js'

/**
 * Strings of the Ctrl-T conversation pager. locale-keys.ts merges them into its dictionary, so
 * locale-extended.ts (already at the source-size limit) does not change.
 */
export type PagerKey = 'pager.empty' | 'pager.status' | 'pager.typing' | 'pager.found'

export const PAGER_DICT: Record<Locale, Record<PagerKey, string>> = {
  en: {
    'pager.empty': '(nothing in this conversation yet)',
    'pager.status': 'lines {from}-{to}/{total}',
    'pager.typing': '/{query}▏',
    'pager.found': '/{query}  {at}/{total}',
  },
  'zh-CN': {
    'pager.empty': '（这个对话里还没有内容）',
    'pager.status': '第 {from}-{to}/{total} 行',
    'pager.typing': '/{query}▏',
    'pager.found': '/{query}  {at}/{total}',
  },
}
