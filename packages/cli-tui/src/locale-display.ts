import type { Locale } from './locale.js'

/**
 * Strings of the display switches: `/raw` and `/borders`. locale-keys.ts merges them into its dictionary, so
 * locale-extended.ts (at the file-size limit) does not change.
 */
export type DisplayKey =
  | 'commands.raw'
  | 'commands.rawSummary'
  | 'raw.on'
  | 'raw.off'
  | 'commands.borders'
  | 'commands.bordersSummary'
  | 'borders.unicode'
  | 'borders.ascii'
  | 'borders.unsaved'
  | 'borders.usage'

export const DISPLAY_DICT: Record<Locale, Record<DisplayKey, string>> = {
  en: {
    'commands.raw':
      'Switch the copy-friendly view on or off (this run only): mouse reporting goes off so the terminal selects text itself, the conversation loses its bars and rails, and code blocks lose their shading',
    'commands.rawSummary': 'Copy-friendly view',
    'raw.on':
      'Raw view: on (mouse reporting off, so select and copy with the terminal; /raw again to go back)',
    'raw.off': 'Raw view: off',
    'commands.borders':
      'Draw frames and icons with Unicode (unicode) or with plain ASCII (ascii, the default on a Linux console); the choice is saved',
    'commands.bordersSummary': 'Unicode or ASCII frames',
    'borders.unicode': 'Borders: Unicode frames and icons',
    'borders.ascii': 'Borders: ASCII only (+ - | * > and so on)',
    'borders.unsaved': ' (not saved: the preferences file could not be written)',
    'borders.usage': 'usage: /borders unicode|ascii',
  },
  'zh-CN': {
    'commands.raw':
      '开关复制友好视图（只在本次运行有效）：关闭鼠标捕获让终端自己选择文本，对话去掉竖条和框线，代码块去掉底色',
    'commands.rawSummary': '复制友好视图',
    'raw.on': '原样视图：开（已关闭鼠标捕获，用终端自带的选择和复制；再输入 /raw 恢复）',
    'raw.off': '原样视图：关',
    'commands.borders':
      '用 Unicode（unicode）或纯 ASCII（ascii，Linux 控制台上的默认值）画边框和图标；选择会保存',
    'commands.bordersSummary': '切换 ASCII 边框',
    'borders.unicode': '边框：Unicode 框线和图标',
    'borders.ascii': '边框：只用 ASCII（+ - | * > 等）',
    'borders.unsaved': '（未保存：偏好文件无法写入）',
    'borders.usage': '用法：/borders unicode|ascii',
  },
}
