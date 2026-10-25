import type { Locale } from './locale.js'

/**
 * Strings shared by the pickers, panels and menus: their key-hint labels and the empty state.
 * locale-keys.ts merges them into its dictionary, so locale-extended.ts (at its size limit) stays put.
 */
export type DialogKey =
  | 'dialog.noMatches'
  | 'dialog.select'
  | 'dialog.confirm'
  | 'dialog.close'
  | 'dialog.back'
  | 'dialog.toggle'
  | 'dialog.scroll'
  | 'dialog.tabAll'
  | 'dialog.tabWorkspace'

export const DIALOG_DICT: Record<Locale, Record<DialogKey, string>> = {
  en: {
    'dialog.noMatches': 'No matches',
    'dialog.select': 'select',
    'dialog.confirm': 'confirm',
    'dialog.close': 'close',
    'dialog.back': 'back',
    'dialog.toggle': 'show/hide',
    'dialog.scroll': 'scroll',
    'dialog.tabAll': 'all',
    'dialog.tabWorkspace': 'this workspace',
  },
  'zh-CN': {
    'dialog.noMatches': '没有匹配项',
    'dialog.select': '选择',
    'dialog.confirm': '确认',
    'dialog.close': '关闭',
    'dialog.back': '返回',
    'dialog.toggle': '显示/隐藏',
    'dialog.scroll': '滚动',
    'dialog.tabAll': '全部',
    'dialog.tabWorkspace': '本工作区',
  },
}
