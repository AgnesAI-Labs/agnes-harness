import type { Locale } from './locale.js'

/**
 * Strings of the prompt's vim mode: the `/vim` switch, the two mode markers and the `vim` scope of the key
 * table. locale-keys.ts merges them into its dictionary, so locale-extended.ts (at the file-size limit) does not change.
 */
export type VimKey =
  | 'commands.vim'
  | 'commands.vimSummary'
  | 'vim.on'
  | 'vim.off'
  | 'vim.unsaved'
  | 'vim.usage'
  | 'vim.normal'
  | 'vim.insert'
  | 'keys.scope.vim'
  | 'keys.act.vim-normal'
  | 'keys.act.vim-left'
  | 'keys.act.vim-down'
  | 'keys.act.vim-up'
  | 'keys.act.vim-right'
  | 'keys.act.vim-word'
  | 'keys.act.vim-word-back'
  | 'keys.act.vim-word-end'
  | 'keys.act.vim-line-start'
  | 'keys.act.vim-line-first'
  | 'keys.act.vim-line-end'
  | 'keys.act.vim-top'
  | 'keys.act.vim-bottom'
  | 'keys.act.vim-insert'
  | 'keys.act.vim-append'
  | 'keys.act.vim-insert-start'
  | 'keys.act.vim-append-end'
  | 'keys.act.vim-open-below'
  | 'keys.act.vim-open-above'
  | 'keys.act.vim-delete-char'
  | 'keys.act.vim-delete-line'
  | 'keys.act.vim-delete-word'
  | 'keys.act.vim-delete-to-end'
  | 'keys.act.vim-change-word'
  | 'keys.act.vim-change-to-end'
  | 'keys.act.vim-paste'
  | 'keys.act.vim-paste-before'
  | 'keys.act.vim-undo'
  | 'keys.act.vim-redo'

export const VIM_DICT: Record<Locale, Record<VimKey, string>> = {
  en: {
    'commands.vim':
      'Switch the prompt between plain editing and vim keys (Esc for normal mode, i a I A o O to type again); with no argument, flip it. The choice is saved',
    'commands.vimSummary': 'Vim keys in the prompt',
    'vim.on': 'Vim mode: on (Esc for normal mode)',
    'vim.off': 'Vim mode: off',
    'vim.unsaved': ' (not saved: the preferences file could not be written)',
    'vim.usage': 'usage: /vim [on|off]',
    'vim.normal': 'NORMAL',
    'vim.insert': 'INSERT',
    'keys.scope.vim': 'Prompt vim keys (normal mode, /vim)',
    'keys.act.vim-normal':
      'Leave insert mode (Esc again does what Esc does without vim: stops a turn, clears the draft)',
    'keys.act.vim-left': 'Move left on the line (a number repeats it)',
    'keys.act.vim-down': 'Move down a line (a number repeats it)',
    'keys.act.vim-up': 'Move up a line (a number repeats it)',
    'keys.act.vim-right': 'Move right on the line (a number repeats it)',
    'keys.act.vim-word': 'Move to the start of the next word (a number repeats it)',
    'keys.act.vim-word-back': 'Move to the start of the word before (a number repeats it)',
    'keys.act.vim-word-end': 'Move to the end of the word (a number repeats it)',
    'keys.act.vim-line-start': 'Move to the start of the line',
    'keys.act.vim-line-first': 'Move to the first character of the line that is not a blank',
    'keys.act.vim-line-end': 'Move to the end of the line',
    'keys.act.vim-top': 'Move to the first line (a number before it names the line)',
    'keys.act.vim-bottom': 'Move to the last line (a number before it names the line)',
    'keys.act.vim-insert': 'Insert before the cursor',
    'keys.act.vim-append': 'Insert after the cursor',
    'keys.act.vim-insert-start': 'Insert at the first non-blank character of the line',
    'keys.act.vim-append-end': 'Insert at the end of the line',
    'keys.act.vim-open-below': 'Open a new line below and insert',
    'keys.act.vim-open-above': 'Open a new line above and insert',
    'keys.act.vim-delete-char': 'Delete the character under the cursor (into the kill ring)',
    'keys.act.vim-delete-line': 'Delete the line (into the kill ring)',
    'keys.act.vim-delete-word': 'Delete to the start of the next word (into the kill ring)',
    'keys.act.vim-delete-to-end': 'Delete to the end of the line (into the kill ring)',
    'keys.act.vim-change-word': 'Replace the word under the cursor',
    'keys.act.vim-change-to-end': 'Replace to the end of the line',
    'keys.act.vim-paste': 'Paste the newest kill-ring entry after the cursor',
    'keys.act.vim-paste-before': 'Paste the newest kill-ring entry before the cursor',
    'keys.act.vim-undo': 'Undo the last edit',
    'keys.act.vim-redo': 'Redo the edit that was undone',
  },
  'zh-CN': {
    'commands.vim':
      '在普通编辑和 vim 键位之间切换输入框（Esc 进普通模式，i a I A o O 回到输入）；不带参数则取反。选择会保存',
    'commands.vimSummary': '用 vim 键位编辑输入框',
    'vim.on': 'Vim 模式：开（Esc 进普通模式）',
    'vim.off': 'Vim 模式：关',
    'vim.unsaved': '（未保存：偏好文件无法写入）',
    'vim.usage': '用法：/vim [on|off]',
    'vim.normal': '普通',
    'vim.insert': '插入',
    'keys.scope.vim': '输入框 vim 键位（普通模式，/vim）',
    'keys.act.vim-normal': '离开插入模式（再按一次 Esc 与没开 vim 时一样：中断回合、清空草稿）',
    'keys.act.vim-left': '在行内左移（可加数字重复）',
    'keys.act.vim-down': '下移一行（可加数字重复）',
    'keys.act.vim-up': '上移一行（可加数字重复）',
    'keys.act.vim-right': '在行内右移（可加数字重复）',
    'keys.act.vim-word': '移到下一个词的开头（可加数字重复）',
    'keys.act.vim-word-back': '移到前一个词的开头（可加数字重复）',
    'keys.act.vim-word-end': '移到词尾（可加数字重复）',
    'keys.act.vim-line-start': '移到行首',
    'keys.act.vim-line-first': '移到行内第一个非空白字符',
    'keys.act.vim-line-end': '移到行尾',
    'keys.act.vim-top': '移到第一行（前面加数字则移到该行）',
    'keys.act.vim-bottom': '移到最后一行（前面加数字则移到该行）',
    'keys.act.vim-insert': '在光标前插入',
    'keys.act.vim-append': '在光标后插入',
    'keys.act.vim-insert-start': '在行内第一个非空白字符前插入',
    'keys.act.vim-append-end': '在行尾插入',
    'keys.act.vim-open-below': '在下方新开一行并插入',
    'keys.act.vim-open-above': '在上方新开一行并插入',
    'keys.act.vim-delete-char': '删除光标下的字符（进入 kill ring）',
    'keys.act.vim-delete-line': '删除整行（进入 kill ring）',
    'keys.act.vim-delete-word': '删到下一个词的开头（进入 kill ring）',
    'keys.act.vim-delete-to-end': '删到行尾（进入 kill ring）',
    'keys.act.vim-change-word': '改写光标处的词',
    'keys.act.vim-change-to-end': '改写到行尾',
    'keys.act.vim-paste': '在光标后粘贴 kill ring 里最新的一条',
    'keys.act.vim-paste-before': '在光标前粘贴 kill ring 里最新的一条',
    'keys.act.vim-undo': '撤销上一步编辑',
    'keys.act.vim-redo': '重做被撤销的编辑',
  },
}
