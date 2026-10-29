import type { Locale } from './locale.js'

/** Strings of /memory: kept beside the other locale files so locale-extended.ts stays small. */
export type MemoryKey =
  | 'commands.memory'
  | 'commands.memorySummary'
  | 'memory.usage'
  | 'memory.header'
  | 'memory.hint'
  | 'memory.empty'
  | 'memory.fileHead'
  | 'memory.unknown'
  | 'memory.addCard'
  | 'memory.tooLong'
  | 'memory.noPending'
  | 'memory.cancelled'
  | 'memory.added'
  | 'memory.saved'
  | 'memory.unchanged'
  | 'memory.conflict'
  | 'memory.refused'
  | 'memory.unsupported'

export const MEMORY_DICT: Record<Locale, Record<MemoryKey, string>> = {
  en: {
    'commands.memory':
      "List, show, add to and edit this workspace's memory files (no delete here: empty a file with edit)",
    'commands.memorySummary': 'View and edit memory',
    'memory.usage': 'usage: /memory [list] | show <name> | add <text> | edit <name> | confirm | cancel',
    'memory.header': 'Memory ({mode}) · {used} of {limit} KB · {root}',
    'memory.hint':
      'Open one with /memory show <name>; change one with /memory edit <name> or /memory add <text>',
    'memory.empty': '(empty)',
    'memory.fileHead': '{name} · {bytes} B',
    'memory.unknown': 'No memory file named {name}; /memory lists them',
    'memory.addCard':
      'Add to {file}:\n- {text}\nNothing is written until you run /memory confirm; /memory cancel drops it.',
    'memory.tooLong': 'That note is longer than {max} characters',
    'memory.noPending': 'There is no memory note waiting for confirmation',
    'memory.cancelled': 'Dropped the pending memory note',
    'memory.added': 'Added the note to {file}',
    'memory.saved': 'Saved {name}',
    'memory.unchanged': 'No changes to {name}',
    'memory.conflict': 'The memory file changed while you were editing it; nothing was written. Try again',
    'memory.refused': 'Memory refused the change: {reason}',
    'memory.unsupported': 'This daemon does not offer memory management to this client',
  },
  'zh-CN': {
    'commands.memory': '列出、查看、追加和编辑此工作区的记忆文件（这里不提供删除：用 edit 清空文件）',
    'commands.memorySummary': '查看和编辑记忆',
    'memory.usage': '用法：/memory [list] | show <文件名> | add <文字> | edit <文件名> | confirm | cancel',
    'memory.header': '记忆（{mode}）· 已用 {used} / {limit} KB · {root}',
    'memory.hint': '用 /memory show <文件名> 查看；用 /memory edit <文件名> 或 /memory add <文字> 修改',
    'memory.empty': '（空）',
    'memory.fileHead': '{name} · {bytes} 字节',
    'memory.unknown': '没有名为 {name} 的记忆文件；/memory 会列出现有的',
    'memory.addCard': '追加到 {file}：\n- {text}\n运行 /memory confirm 才会写入；/memory cancel 放弃。',
    'memory.tooLong': '这条笔记超过 {max} 个字符',
    'memory.noPending': '没有等待确认的记忆笔记',
    'memory.cancelled': '已放弃待确认的记忆笔记',
    'memory.added': '已追加到 {file}',
    'memory.saved': '已保存 {name}',
    'memory.unchanged': '{name} 没有改动',
    'memory.conflict': '编辑期间这个记忆文件已被改动，没有写入。请重试',
    'memory.refused': '记忆服务拒绝了这次修改：{reason}',
    'memory.unsupported': '这个 daemon 没有向此客户端开放记忆管理',
  },
}
