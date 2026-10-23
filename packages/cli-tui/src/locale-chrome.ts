import type { Locale } from './locale.js'

/**
 * Strings of the pinned plan panel, tool card focus, the status line settings and the window title.
 * locale-keys.ts merges them into its dictionary, so locale-extended.ts (at the file-size limit) does not change.
 */
export type ChromeKey =
  | 'commands.todos'
  | 'commands.todosSummary'
  | 'todos.auto'
  | 'todos.show'
  | 'todos.hide'
  | 'todos.usage'
  | 'plan.summary'
  | 'plan.summaryDone'
  | 'keys.act.cards-focus'
  | 'keys.act.cards-exit'
  | 'keys.act.cards-prev'
  | 'keys.act.cards-next'
  | 'keys.act.cards-toggle'
  | 'keys.act.cards-expand-all'
  | 'keys.act.cards-collapse-all'
  | 'keys.scope.cards'
  | 'cards.none'
  | 'cards.hint'
  | 'commands.expand'
  | 'commands.expandSummary'
  | 'expand.all'
  | 'expand.none'
  | 'expand.usage'

export const CHROME_DICT: Record<Locale, Record<ChromeKey, string>> = {
  en: {
    'commands.todos':
      'Show, hide or automatically show the current plan above the prompt (this run only); without an argument, go to the next of the three',
    'commands.todosSummary': 'Pin the plan above prompt',
    'todos.auto': 'Plan panel: automatic (shown while a plan is unfinished)',
    'todos.show': 'Plan panel: always shown',
    'todos.hide': 'Plan panel: hidden',
    'todos.usage': 'usage: /todos [auto|show|hide]',
    'plan.summary': 'Plan {done}/{total}',
    'plan.summaryDone': 'Plan {done}/{total} ✓',
    'keys.act.cards-focus': 'Move focus between the tool cards (Ctrl-X again or Esc leaves)',
    'keys.act.cards-exit':
      'Leave card focus; the conversation goes back where it was (Ctrl-C also stops the turn)',
    'keys.act.cards-prev': 'Focus the previous tool card',
    'keys.act.cards-next': 'Focus the next tool card',
    'keys.act.cards-toggle': 'Open or fold the focused card',
    'keys.act.cards-expand-all': 'Open every tool card',
    'keys.act.cards-collapse-all': 'Fold every tool card',
    'keys.scope.cards': 'Tool card focus (Ctrl-X)',
    'cards.none': 'No tool cards to focus',
    'cards.hint': '↑↓ move · Enter/Space open or fold · a open all · z fold all · Esc/Ctrl-X leave',
    'commands.expand': 'Open (all) or fold (none) every tool card',
    'commands.expandSummary': 'Open or fold all cards',
    'expand.all': 'All tool cards opened',
    'expand.none': 'All tool cards folded',
    'expand.usage': 'usage: /expand all|none',
  },
  'zh-CN': {
    'commands.todos':
      '在输入框上方显示、隐藏或自动显示当前计划（只在本次运行有效）；不带参数时切到三者中的下一个',
    'commands.todosSummary': '把计划固定在输入框上方',
    'todos.auto': '计划面板：自动（计划未完成时显示）',
    'todos.show': '计划面板：始终显示',
    'todos.hide': '计划面板：已隐藏',
    'todos.usage': '用法：/todos [auto|show|hide]',
    'plan.summary': '计划 {done}/{total}',
    'plan.summaryDone': '计划 {done}/{total} ✓',
    'keys.act.cards-focus': '在工具卡之间移动焦点（再按 Ctrl-X 或 Esc 退出）',
    'keys.act.cards-exit': '退出卡片焦点，对话回到原来的位置（Ctrl-C 还会中断当前轮）',
    'keys.act.cards-prev': '聚焦上一张工具卡',
    'keys.act.cards-next': '聚焦下一张工具卡',
    'keys.act.cards-toggle': '展开或折叠聚焦的卡片',
    'keys.act.cards-expand-all': '展开所有工具卡',
    'keys.act.cards-collapse-all': '折叠所有工具卡',
    'keys.scope.cards': '工具卡焦点（Ctrl-X）',
    'cards.none': '没有可聚焦的工具卡',
    'cards.hint': '↑↓ 移动 · 回车/空格 展开或折叠 · a 全部展开 · z 全部折叠 · Esc/Ctrl-X 退出',
    'commands.expand': '展开（all）或折叠（none）所有工具卡',
    'commands.expandSummary': '展开或折叠所有卡片',
    'expand.all': '已展开所有工具卡',
    'expand.none': '已折叠所有工具卡',
    'expand.usage': '用法：/expand all|none',
  },
}
