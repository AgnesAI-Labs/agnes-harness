import type { Locale } from './locale.js'

/**
 * Labels of the key hints in the timeline and its overlays (tool cards, the Ctrl-T pager), spelled by `keyHints`.
 * locale-keys.ts merges them into its dictionary, so locale-extended.ts (at the file-size limit) does not change.
 */
export type ChromeHintKey =
  | 'chromeHint.expand'
  | 'chromeHint.collapse'
  | 'chromeHint.scroll'
  | 'chromeHint.search'
  | 'chromeHint.next'
  | 'chromeHint.prev'
  | 'chromeHint.copy'
  | 'chromeHint.newSearch'
  | 'chromeHint.cancel'
  | 'chromeHint.close'

export const CHROME_HINT_DICT: Record<Locale, Record<ChromeHintKey, string>> = {
  en: {
    'chromeHint.expand': 'expand',
    'chromeHint.collapse': 'collapse',
    'chromeHint.scroll': 'scroll',
    'chromeHint.search': 'search',
    'chromeHint.next': 'next',
    'chromeHint.prev': 'previous',
    'chromeHint.copy': 'copy',
    'chromeHint.newSearch': 'new search',
    'chromeHint.cancel': 'cancel',
    'chromeHint.close': 'close',
  },
  'zh-CN': {
    'chromeHint.expand': '展开',
    'chromeHint.collapse': '收起',
    'chromeHint.scroll': '滚动',
    'chromeHint.search': '搜索',
    'chromeHint.next': '下一个',
    'chromeHint.prev': '上一个',
    'chromeHint.copy': '复制',
    'chromeHint.newSearch': '重新搜索',
    'chromeHint.cancel': '取消',
    'chromeHint.close': '关闭',
  },
}
