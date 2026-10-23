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
  },
}
