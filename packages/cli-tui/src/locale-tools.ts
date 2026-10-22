import type { Locale } from './locale.js'

/**
 * Strings of the tool-card previews, diffs, groups, thinking and approval bodies. They live beside
 * locale-extended.ts (which merges them into `tt`) so that file stays under the source-size limit.
 */
export const TOOLS_KEYS = [
  'diff.unchanged',
  'diff.wholeFile',
  'card.moreLines',
  'group.read.one',
  'group.read.other',
  'group.search.one',
  'group.search.other',
  'group.list.one',
  'group.list.other',
  'thinking.done',
  'thinking.open',
  'thinking.folded',
  'commands.thinking',
  'commands.thinkingSummary',
  'approval.risk.destructive',
  'approval.risk.budget',
  'approval.allowAlways',
  'approval.details',
  'timeline.session',
  'timeline.omitted',
] as const

export type ToolsKey = (typeof TOOLS_KEYS)[number]

export const TOOLS_DICT: Record<Locale, Record<ToolsKey, string>> = {
  en: {
    'diff.unchanged': '⋯ {n} unchanged lines',
    'diff.wholeFile': 'whole file, replaces it if it exists',
    'card.moreLines': '… {n} more lines',
    'group.read.one': 'Read 1 file',
    'group.read.other': 'Read {n} files',
    'group.search.one': 'Searched once',
    'group.search.other': 'Searched {n} times',
    'group.list.one': 'Listed 1 directory',
    'group.list.other': 'Listed {n} directories',
    'thinking.done': 'Thought ({n} characters)',
    'thinking.open': 'Thinking stays open for this run',
    'thinking.folded': 'Thinking folds once the answer starts',
    'commands.thinking':
      "Switch the model's thinking between staying open and folding once the answer starts, for this run only",
    'commands.thinkingSummary': 'Toggle thinking display',
    'approval.risk.destructive': 'destructive',
    'approval.risk.budget': 'uses budget',
    'approval.allowAlways': 'Always allow in this session',
    'approval.details': 'Raw input',
    'timeline.session': 'session {id}',
    'timeline.omitted': '⋯ earlier output is not shown here',
  },
  'zh-CN': {
    'diff.unchanged': '⋯ {n} 行未变',
    'diff.wholeFile': '整文件写入，已存在则覆盖',
    'card.moreLines': '… 还有 {n} 行',
    'group.read.one': '已读取 1 个文件',
    'group.read.other': '已读取 {n} 个文件',
    'group.search.one': '搜索 1 次',
    'group.search.other': '搜索 {n} 次',
    'group.list.one': '列出 1 个目录',
    'group.list.other': '列出 {n} 个目录',
    'thinking.done': '已思考（{n} 字）',
    'thinking.open': '思考内容已设为始终展开（仅本次运行）',
    'thinking.folded': '思考内容在回答开始后收起',
    'commands.thinking': '本次运行内切换模型思考的显示：始终展开，或回答开始后收起',
    'commands.thinkingSummary': '开关思考展开',
    'approval.risk.destructive': '破坏性操作',
    'approval.risk.budget': '消耗预算',
    'approval.allowAlways': '本会话内总是允许',
    'approval.details': '原始输入',
    'timeline.session': '会话 {id}',
    'timeline.omitted': '⋯ 更早的输出未在此显示',
  },
}
