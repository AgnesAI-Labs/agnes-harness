import type { Locale } from './locale.js'

/**
 * Strings of the terminal-level surfaces: pasted blocks, the exit hint, mouse and clipboard tips and
 * history search. They live beside locale-control.ts (locale-extended.ts merges them into `tt`) so
 * that file stays under the source-size limit.
 */
export const TERMINAL_KEYS = [
  'paste.chip',
  'resume.hint',
  'commands.mouse',
  'commands.mouseSummary',
  'mouse.on',
  'mouse.off',
  'copy.sent',
  'copy.failed',
] as const

export type TerminalKey = (typeof TERMINAL_KEYS)[number]

export const TERMINAL_DICT: Record<Locale, Record<TerminalKey, string>> = {
  en: {
    'paste.chip': '[Pasted #{n} · {lines} lines]',
    'resume.hint': 'Resume this session: agh --resume {id}',
    'commands.mouse':
      'Switch mouse reporting on or off for this run. Off, the terminal selects and copies text itself',
    'commands.mouseSummary': 'Toggle mouse reporting',
    'mouse.on':
      'Mouse reporting on: drag to select and copy inside the app; the wheel scrolls the conversation',
    'mouse.off':
      'Mouse reporting off: select text with the terminal; the wheel now sends arrow keys (history)',
    'copy.sent': '✓ Sent to clipboard',
    'copy.failed': '✗ Copy failed',
  },
  'zh-CN': {
    'paste.chip': '[粘贴 #{n} · {lines} 行]',
    'resume.hint': '恢复此会话：agh --resume {id}',
    'commands.mouse': '本次运行内开关鼠标上报；关闭后由终端自己选择和复制文字',
    'commands.mouseSummary': '开关鼠标上报',
    'mouse.on': '鼠标上报已开启：在应用内拖选即可复制，滚轮滚动对话',
    'mouse.off': '鼠标上报已关闭：由终端自己选择文字；滚轮现在会发送方向键（翻看历史）',
    'copy.sent': '✓ 已发送到剪贴板',
    'copy.failed': '✗ 复制失败',
  },
}
