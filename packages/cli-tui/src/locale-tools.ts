import type { Locale } from './locale.js'

/**
 * Strings of the tool-card previews, diffs, groups, thinking and approval bodies. They live beside
 * locale-extended.ts (which merges them into `tt`) so that file stays under the source-size limit.
 */
export const TOOLS_KEYS = [
  'diff.unchanged',
  'diff.newFile',
  'card.moreLines',
  'group.read.one',
  'group.read.other',
  'group.search.one',
  'group.search.other',
  'group.list.one',
  'group.list.other',
] as const

export type ToolsKey = (typeof TOOLS_KEYS)[number]

export const TOOLS_DICT: Record<Locale, Record<ToolsKey, string>> = {
  en: {
    'diff.unchanged': '⋯ {n} unchanged lines',
    'diff.newFile': 'new file',
    'card.moreLines': '… {n} more lines',
    'group.read.one': 'Read 1 file',
    'group.read.other': 'Read {n} files',
    'group.search.one': 'Searched once',
    'group.search.other': 'Searched {n} times',
    'group.list.one': 'Listed 1 directory',
    'group.list.other': 'Listed {n} directories',
  },
  'zh-CN': {
    'diff.unchanged': '⋯ {n} 行未变',
    'diff.newFile': '新文件',
    'card.moreLines': '… 还有 {n} 行',
    'group.read.one': '已读取 1 个文件',
    'group.read.other': '已读取 {n} 个文件',
    'group.search.one': '搜索 1 次',
    'group.search.other': '搜索 {n} 次',
    'group.list.one': '列出 1 个目录',
    'group.list.other': '列出 {n} 个目录',
  },
}
