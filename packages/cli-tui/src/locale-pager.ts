import type { Locale } from './locale.js'

/**
 * Strings of the Ctrl-T conversation pager. locale-keys.ts merges them into its dictionary, so
 * locale-extended.ts (already at the source-size limit) does not change.
 */
export type PagerKey =
  | 'pager.hint'
  | 'pager.hintFound'
  | 'pager.empty'
  | 'pager.status'
  | 'pager.typing'
  | 'pager.found'

export const PAGER_DICT: Record<Locale, Record<PagerKey, string>> = {
  en: {
    'pager.hint': '↑↓ PgUp/PgDn scroll · / search · Ctrl-T/Esc close',
    'pager.hintFound': 'n/N next/previous · c copy · / new search · Esc close',
    'pager.empty': '(nothing in this conversation yet)',
    'pager.status': 'lines {from}-{to}/{total}',
    'pager.typing': '/{query}▏ Enter search · Esc cancel',
    'pager.found': '/{query}  {at}/{total}',
  },
  'zh-CN': {
    'pager.hint': '↑↓ PgUp/PgDn 滚动 · / 搜索 · Ctrl-T/Esc 关闭',
    'pager.hintFound': 'n/N 下一个/上一个 · c 复制 · / 重新搜索 · Esc 关闭',
    'pager.empty': '（这个对话里还没有内容）',
    'pager.status': '第 {from}-{to}/{total} 行',
    'pager.typing': '/{query}▏ 回车搜索 · Esc 取消',
    'pager.found': '/{query}  {at}/{total}',
  },
}
