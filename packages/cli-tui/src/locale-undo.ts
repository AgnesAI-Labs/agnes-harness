import type { Locale } from './locale.js'

/** Strings of /undo and `agh sessions undo`: kept beside the other locale files so locale-extended.ts stays small. */
export type UndoKey =
  | 'commands.undo'
  | 'commands.undoSummary'
  | 'undo.unsupported'
  | 'undo.nothing'
  | 'undo.header'
  | 'undo.restore'
  | 'undo.delete'
  | 'undo.unchanged'
  | 'undo.kept'
  | 'undo.later'
  | 'undo.shell'
  | 'undo.confirm'
  | 'undo.previewOnly'
  | 'undo.cancelled'
  | 'undo.noPending'
  | 'undo.done'
  | 'undo.partial'
  | 'undo.failedFile'
  | 'undo.conflict'
  | 'undo.refusedFiles'
  | 'undo.refusedBusy'
  | 'undo.refusedReadOnly'
  | 'undo.refusedLater'
  | 'undo.refusedDone'
  | 'undo.refusedNothing'
  | 'undo.blocked.busy'
  | 'undo.blocked.read-only'
  | 'undo.blocked.later-turns'
  | 'undo.blocked.already-undone'
  | 'undo.blocked.files'
  | 'undo.reason.legacy-receipt'
  | 'undo.reason.no-checkpoint'
  | 'undo.reason.checkpoint-collected'
  | 'undo.reason.changed-since'
  | 'undo.reason.missing'
  | 'undo.reason.unreadable'

export const UNDO_DICT: Record<Locale, Record<UndoKey, string>> = {
  en: {
    'commands.undo':
      'Preview, then undo, the file changes of the last turn that wrote files ("/undo N" picks a turn, "/undo confirm" applies the preview)',
    'commands.undoSummary': "Undo a turn's file changes",
    'undo.unsupported': 'this daemon does not support undo',
    'undo.nothing': 'no turn with file changes to undo',
    'undo.header': 'Turn {turn} changed {count} file(s):',
    'undo.restore': 'restore  {path}',
    'undo.delete': 'delete   {path} (created by the turn)',
    'undo.unchanged': 'as before {path}',
    'undo.kept': '         cannot be undone: {reason}',
    'undo.later': 'Undo later turns first: {turns}',
    'undo.shell': 'The turn also ran shell commands; what they changed is not restored.',
    'undo.confirm': 'Run /undo confirm to apply this, or /undo cancel.',
    'undo.previewOnly': 'Preview only: nothing was changed.',
    'undo.cancelled': 'undo cancelled',
    'undo.noPending': 'no pending undo; run /undo first',
    'undo.done': 'Undid the file changes of turn {turn}: {count} file(s) restored.',
    'undo.partial': 'Undo of turn {turn} stopped: {count} file(s) restored, the rest were not.',
    'undo.failedFile': '  not restored: {path} ({reason})',
    'undo.conflict': '  changed since the turn: {path} ({reason})',
    'undo.refusedFiles': 'Undo refused: some files cannot be restored, so nothing was changed.',
    'undo.refusedBusy': 'Undo refused: a turn is running.',
    'undo.refusedReadOnly': 'Undo refused: this session is read-only.',
    'undo.refusedLater': 'Undo refused: undo the later turns first.',
    'undo.refusedDone': 'Undo refused: this turn was already undone.',
    'undo.refusedNothing': 'Undo refused: that turn has no file changes.',
    'undo.blocked.busy': 'A turn is running; try again when it ends.',
    'undo.blocked.read-only': 'This session is read-only.',
    'undo.blocked.later-turns': 'Later turns changed files too; undo them first.',
    'undo.blocked.already-undone': 'This turn was already undone.',
    'undo.blocked.files': 'Some files cannot be restored; nothing would be changed.',
    'undo.reason.legacy-receipt': 'recorded before undo existed',
    'undo.reason.no-checkpoint': 'no snapshot for this turn',
    'undo.reason.checkpoint-collected': 'snapshot already cleaned up',
    'undo.reason.changed-since': 'changed after the turn',
    'undo.reason.missing': 'file is gone',
    'undo.reason.unreadable': 'cannot be read',
  },
  'zh-CN': {
    'commands.undo': '先预览再撤销最近一次写过文件的轮次（"/undo N" 指定轮次，"/undo confirm" 执行预览）',
    'commands.undoSummary': '撤销某一轮的文件改动',
    'undo.unsupported': '这个 daemon 不支持撤销',
    'undo.nothing': '没有可撤销文件改动的轮次',
    'undo.header': '第 {turn} 轮改动了 {count} 个文件：',
    'undo.restore': '恢复   {path}',
    'undo.delete': '删除   {path}（本轮新建）',
    'undo.unchanged': '已是原样 {path}',
    'undo.kept': '       无法撤销：{reason}',
    'undo.later': '请先撤销更晚的轮次：{turns}',
    'undo.shell': '本轮还运行过 shell 命令，它们造成的改动不会被恢复。',
    'undo.confirm': '执行 /undo confirm 应用，或 /undo cancel 取消。',
    'undo.previewOnly': '仅预览，没有改动任何文件。',
    'undo.cancelled': '已取消撤销',
    'undo.noPending': '没有待执行的撤销，请先运行 /undo',
    'undo.done': '已撤销第 {turn} 轮的文件改动：恢复了 {count} 个文件。',
    'undo.partial': '第 {turn} 轮的撤销中途停止：已恢复 {count} 个文件，其余未恢复。',
    'undo.failedFile': '  未恢复：{path}（{reason}）',
    'undo.conflict': '  该轮之后被改动：{path}（{reason}）',
    'undo.refusedFiles': '撤销被拒绝：有文件无法恢复，所以没有改动任何文件。',
    'undo.refusedBusy': '撤销被拒绝：有轮次正在运行。',
    'undo.refusedReadOnly': '撤销被拒绝：这个会话是只读的。',
    'undo.refusedLater': '撤销被拒绝：请先撤销更晚的轮次。',
    'undo.refusedDone': '撤销被拒绝：这一轮已经撤销过。',
    'undo.refusedNothing': '撤销被拒绝：这一轮没有文件改动。',
    'undo.blocked.busy': '有轮次正在运行，请在它结束后再试。',
    'undo.blocked.read-only': '这个会话是只读的。',
    'undo.blocked.later-turns': '更晚的轮次也改了文件，请先撤销它们。',
    'undo.blocked.already-undone': '这一轮已经撤销过。',
    'undo.blocked.files': '有文件无法恢复，不会改动任何文件。',
    'undo.reason.legacy-receipt': '记录于撤销功能出现之前',
    'undo.reason.no-checkpoint': '这一轮没有快照',
    'undo.reason.checkpoint-collected': '快照已被清理',
    'undo.reason.changed-since': '该轮之后被改动',
    'undo.reason.missing': '文件已不存在',
    'undo.reason.unreadable': '无法读取',
  },
}
