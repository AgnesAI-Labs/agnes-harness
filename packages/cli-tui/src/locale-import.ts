import type { Locale } from './locale.js'

/** Strings of /import: kept beside the other locale files so locale-extended.ts stays small. */
export type ImportKey =
  | 'commands.import'
  | 'commands.importSummary'
  | 'import.remote'
  | 'import.usage'
  | 'import.none'
  | 'import.skipped'
  | 'import.done'
  | 'import.failed'
  | 'picker.importTitle'

export const IMPORT_DICT: Record<Locale, Record<ImportKey, string>> = {
  en: {
    'commands.import':
      "Import a Claude Code or codex session file into agh; without a file, pick one of this workspace's recent sessions",
    'commands.importSummary': 'Import an external session',
    'import.remote':
      'Import needs the shared local daemon connection; it is not available with --connect, --standalone or --ephemeral',
    'import.usage': 'usage: /import [<file> [--from claude-code|codex|pi|auto]]',
    'import.none': 'No Claude Code or codex sessions found for this workspace',
    'import.skipped': '{count} unreadable file(s) skipped.',
    'import.done': 'Imported as {key}; continue it with /resume {key}',
    'import.failed': 'Import failed: {reason}',
    'picker.importTitle': 'Import Session',
  },
  'zh-CN': {
    'commands.import':
      '把 Claude Code 或 codex 的会话文件导入 agh；不带文件时列出当前工作区最近的外部会话供选择',
    'commands.importSummary': '导入外部会话',
    'import.remote': '导入需要共享的本机 daemon 连接；使用 --connect、--standalone 或 --ephemeral 时不可用',
    'import.usage': '用法：/import [<文件> [--from claude-code|codex|pi|auto]]',
    'import.none': '没有找到属于当前工作区的 Claude Code 或 codex 会话',
    'import.skipped': '已跳过 {count} 个读不了的文件。',
    'import.done': '已导入为 {key}；用 /resume {key} 继续',
    'import.failed': '导入失败：{reason}',
    'picker.importTitle': '导入会话',
  },
}
