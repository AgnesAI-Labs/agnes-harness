import type { Locale } from './locale.js'

/**
 * Strings shared by the pickers, panels and menus: their key-hint labels and the empty state.
 * locale-keys.ts merges them into its dictionary, so locale-extended.ts (at its size limit) stays put.
 */
export type DialogKey =
  | 'dialog.noMatches'
  | 'dialog.more'
  | 'dialog.select'
  | 'dialog.confirm'
  | 'dialog.close'
  | 'dialog.back'
  | 'dialog.toggle'
  | 'dialog.scroll'
  | 'dialog.tabAll'
  | 'dialog.tabWorkspace'
  | 'dialog.untitled'
  | 'dialog.ago.now'
  | 'dialog.ago.minutes'
  | 'dialog.ago.hours'
  | 'dialog.ago.days'

export const DIALOG_DICT: Record<Locale, Record<DialogKey, string>> = {
  en: {
    'dialog.noMatches': 'No matches',
    'dialog.more': '{n} more',
    'dialog.select': 'select',
    'dialog.confirm': 'confirm',
    'dialog.close': 'close',
    'dialog.back': 'back',
    'dialog.toggle': 'show/hide',
    'dialog.scroll': 'scroll',
    'dialog.tabAll': 'all',
    'dialog.tabWorkspace': 'this workspace',
    'dialog.untitled': 'Untitled',
    'dialog.ago.now': 'just now',
    'dialog.ago.minutes': '{n}m ago',
    'dialog.ago.hours': '{n}h ago',
    'dialog.ago.days': '{n}d ago',
  },
  'zh-CN': {
    'dialog.noMatches': '没有匹配项',
    'dialog.more': '还有 {n} 项',
    'dialog.select': '选择',
    'dialog.confirm': '确认',
    'dialog.close': '关闭',
    'dialog.back': '返回',
    'dialog.toggle': '显示/隐藏',
    'dialog.scroll': '滚动',
    'dialog.tabAll': '全部',
    'dialog.tabWorkspace': '本工作区',
    'dialog.untitled': '未命名',
    'dialog.ago.now': '刚刚',
    'dialog.ago.minutes': '{n} 分钟前',
    'dialog.ago.hours': '{n} 小时前',
    'dialog.ago.days': '{n} 天前',
  },
}
