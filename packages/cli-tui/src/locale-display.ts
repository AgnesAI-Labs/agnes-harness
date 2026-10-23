import type { Locale } from './locale.js'

/**
 * Strings of the display switches: `/raw`. locale-keys.ts merges them into its dictionary, so
 * locale-extended.ts (at the file-size limit) does not change.
 */
export type DisplayKey = 'commands.raw' | 'commands.rawSummary' | 'raw.on' | 'raw.off'

export const DISPLAY_DICT: Record<Locale, Record<DisplayKey, string>> = {
  en: {
    'commands.raw':
      'Switch the copy-friendly view on or off (this run only): mouse reporting goes off so the terminal selects text itself, the conversation loses its bars and rails, and code blocks lose their shading',
    'commands.rawSummary': 'Copy-friendly view',
    'raw.on':
      'Raw view: on (mouse reporting off, so select and copy with the terminal; /raw again to go back)',
    'raw.off': 'Raw view: off',
  },
  'zh-CN': {
    'commands.raw':
      '开关复制友好视图（只在本次运行有效）：关闭鼠标捕获让终端自己选择文本，对话去掉竖条和框线，代码块去掉底色',
    'commands.rawSummary': '复制友好视图',
    'raw.on': '原样视图：开（已关闭鼠标捕获，用终端自带的选择和复制；再输入 /raw 恢复）',
    'raw.off': '原样视图：关',
  },
}
