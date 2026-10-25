import type { Locale } from './locale.js'

/**
 * Labels of the key hints in the timeline and its overlays (tool cards, the Ctrl-T pager), spelled by `keyHints`,
 * and the tool status words locale-extended.ts has no room for.
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
  | 'tool.status.cancelled'
  | 'tool.status.awaitingApproval'
  | 'tool.status.waiting'
  | 'tool.status.budgetStopped'

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
    'tool.status.cancelled': 'cancelled',
    'tool.status.awaitingApproval': 'awaiting approval',
    'tool.status.waiting': 'waiting',
    'tool.status.budgetStopped': 'budget stopped',
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
    'tool.status.cancelled': '已取消',
    'tool.status.awaitingApproval': '待审批',
    'tool.status.waiting': '等待中',
    'tool.status.budgetStopped': '预算已停',
  },
}
