import type { Locale } from './locale.js'

/**
 * Strings of the tool-card previews, diffs, groups, thinking and approval bodies. They live beside
 * locale-extended.ts (which merges them into `tt`) so that file stays under the source-size limit.
 */
export const TOOLS_KEYS = ['diff.unchanged', 'diff.newFile', 'card.moreLines'] as const

export type ToolsKey = (typeof TOOLS_KEYS)[number]

export const TOOLS_DICT: Record<Locale, Record<ToolsKey, string>> = {
  en: {
    'diff.unchanged': '⋯ {n} unchanged lines',
    'diff.newFile': 'new file',
    'card.moreLines': '… {n} more lines',
  },
  'zh-CN': {
    'diff.unchanged': '⋯ {n} 行未变',
    'diff.newFile': '新文件',
    'card.moreLines': '… 还有 {n} 行',
  },
}
