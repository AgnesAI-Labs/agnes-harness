import type { Locale } from './locale.js'

/** Strings of /terminal-setup: kept beside the other locale files so locale-extended.ts stays small. */
export type TerminalSetupKey =
  | 'commands.terminalSetup'
  | 'commands.terminalSetupSummary'
  | 'terminalSetup.usage'
  | 'terminalSetup.none'
  | 'terminalSetup.detected'
  | 'terminalSetup.unknown'
  | 'terminalSetup.how'
  | 'terminalSetup.multiplexer'
  | 'terminalSetup.iterm2'
  | 'terminalSetup.appleTerminal'
  | 'terminalSetup.wezterm'
  | 'terminalSetup.windowsTerminal'
  | 'terminalSetup.addTo'
  | 'terminalSetup.applyHint'
  | 'terminalSetup.noApply'
  | 'terminalSetup.refused.unsafe'
  | 'terminalSetup.refused.conflict'
  | 'terminalSetup.refused.already'
  | 'terminalSetup.refused.noDirectory'
  | 'terminalSetup.card'
  | 'terminalSetup.cardNew'
  | 'terminalSetup.noPending'
  | 'terminalSetup.cancelled'
  | 'terminalSetup.stale'
  | 'terminalSetup.failed'
  | 'terminalSetup.written'
  | 'terminalSetup.created'

export const TERMINAL_SETUP_DICT: Record<Locale, Record<TerminalSetupKey, string>> = {
  en: {
    'commands.terminalSetup':
      'Show how to make Shift+Enter a newline in this terminal; in VS Code and Cursor, apply it to keybindings.json after a confirmation',
    'commands.terminalSetupSummary': 'Set up Shift+Enter',
    'terminalSetup.usage': 'usage: /terminal-setup [apply | confirm | cancel]',
    'terminalSetup.none':
      '{name} reports Shift+Enter through the kitty keyboard protocol, which agh turns on: no setup needed',
    'terminalSetup.detected': 'Detected {name}.',
    'terminalSetup.unknown':
      'This terminal is not one agh recognises (or it is running inside another program).',
    'terminalSetup.how':
      'Shift+Enter inserts a newline once the terminal sends ESC and Return (the bytes 1b 0d, what Alt+Enter sends) for it. Alt+Enter, or a trailing \\ before Enter, works in any terminal without setup.',
    'terminalSetup.multiplexer':
      'Inside tmux or screen the keyboard protocol is not requested, so set the key in the terminal around it.',
    'terminalSetup.iterm2':
      'In iTerm2: Settings > Profiles > Keys > Key Mappings > +, press Shift+Return, choose the action "Send Hex Code" and enter 0x1b 0x0d.',
    'terminalSetup.appleTerminal':
      'In Terminal.app: Settings > Profiles > Keyboard > +, choose the key Return with the modifier Shift, the action "Send Text" and enter \\033 followed by \\r (type Escape, then Return, in the field).',
    'terminalSetup.wezterm':
      'WezTerm speaks the kitty protocol only with config.enable_kitty_keyboard = true (off by default); this key works either way.',
    'terminalSetup.windowsTerminal':
      'In Windows Terminal: Settings > Open JSON file, and add this to the "actions" list:',
    'terminalSetup.addTo': 'Add this to {path}:',
    'terminalSetup.applyHint':
      'To have agh add it: /terminal-setup apply (it shows what will change, asks you to confirm, and copies the file to a backup first).',
    'terminalSetup.noApply':
      'agh only writes the setup for VS Code and Cursor. {name} is configured by hand: run /terminal-setup to see how.',
    'terminalSetup.refused.unsafe':
      'Nothing was written: {path} is not a keybindings array agh can safely add to. Add the entry by hand.',
    'terminalSetup.refused.conflict':
      'Nothing was written: {path} already binds shift+enter to a different terminal sequence. Edit that entry by hand.',
    'terminalSetup.refused.already': 'Nothing to do: {path} already has the Shift+Enter entry.',
    'terminalSetup.refused.noDirectory':
      'Nothing was written: the settings directory of {path} does not exist. Open the editor once, or add the entry by hand.',
    'terminalSetup.card':
      'Will append one entry to {path}:\n  {entry}\nThe current file is copied to {backup} first, and nothing else in it changes.\nNothing is written until you run /terminal-setup confirm; /terminal-setup cancel drops it.',
    'terminalSetup.cardNew':
      'Will create {path} with one entry:\n  {entry}\nNothing is written until you run /terminal-setup confirm; /terminal-setup cancel drops it.',
    'terminalSetup.noPending': 'There is no setup waiting for confirmation',
    'terminalSetup.cancelled': 'Dropped the pending setup',
    'terminalSetup.stale':
      'The file changed since the card was shown, so nothing was written. Run /terminal-setup apply again',
    'terminalSetup.failed': 'Could not write the setup: {reason}',
    'terminalSetup.written':
      'Added the Shift+Enter entry to {path}. The old file is saved as {backup}. Reopen the terminal panel if the key does not work yet.',
    'terminalSetup.created':
      'Created {path} with the Shift+Enter entry. Reopen the terminal panel if the key does not work yet.',
  },
  'zh-CN': {
    'commands.terminalSetup':
      '显示如何让 Shift+Enter 在当前终端里换行；在 VS Code 和 Cursor 里，确认后可写入 keybindings.json',
    'commands.terminalSetupSummary': '设置换行快捷键',
    'terminalSetup.usage': '用法：/terminal-setup [apply | confirm | cancel]',
    'terminalSetup.none': '{name} 通过 kitty 键盘协议上报 Shift+Enter，agh 已开启该协议：无需设置',
    'terminalSetup.detected': '检测到 {name}。',
    'terminalSetup.unknown': 'agh 不认识这个终端（或它运行在别的程序里）。',
    'terminalSetup.how':
      '终端为 Shift+Enter 发出 ESC 加回车（字节 1b 0d，也就是 Alt+Enter 发的内容）后，它就会插入换行。Alt+Enter，或在行尾写 \\ 再按回车，在任何终端里都无需设置就能用。',
    'terminalSetup.multiplexer': '在 tmux 或 screen 里不会请求键盘协议，所以请在它外面的终端里设置这个键。',
    'terminalSetup.iterm2':
      '在 iTerm2：设置 > Profiles > Keys > Key Mappings > +，按下 Shift+Return，动作选 “Send Hex Code”，填 0x1b 0x0d。',
    'terminalSetup.appleTerminal':
      '在 Terminal.app：设置 > 描述文件 > 键盘 > +，按键选 Return、修饰键选 Shift，动作选 “发送文本”，填 \\033 加 \\r（在输入框里依次按 Esc 和回车）。',
    'terminalSetup.wezterm':
      'WezTerm 只有在 config.enable_kitty_keyboard = true（默认关闭）时才使用 kitty 协议；下面这个按键绑定无论如何都有效。',
    'terminalSetup.windowsTerminal':
      '在 Windows Terminal：设置 > 打开 JSON 文件，把下面这条加进 "actions" 列表：',
    'terminalSetup.addTo': '把这段加到 {path}：',
    'terminalSetup.applyHint':
      '想让 agh 帮你加：/terminal-setup apply（会先显示改动、要求你确认，并先把文件复制一份备份）。',
    'terminalSetup.noApply':
      'agh 只替 VS Code 和 Cursor 写设置。{name} 需要手动配置：运行 /terminal-setup 查看方法。',
    'terminalSetup.refused.unsafe': '没有写入：{path} 不是 agh 能安全追加的键位数组。请手动添加这一条。',
    'terminalSetup.refused.conflict':
      '没有写入：{path} 已把 shift+enter 绑定到另一个终端序列。请手动修改那一条。',
    'terminalSetup.refused.already': '无需操作：{path} 里已经有 Shift+Enter 这一条。',
    'terminalSetup.refused.noDirectory':
      '没有写入：{path} 所在的设置目录不存在。请先打开一次编辑器，或手动添加。',
    'terminalSetup.card':
      '将向 {path} 追加一条：\n  {entry}\n会先把当前文件复制到 {backup}，文件里的其他内容不变。\n运行 /terminal-setup confirm 才会写入；/terminal-setup cancel 放弃。',
    'terminalSetup.cardNew':
      '将创建 {path}，内含一条：\n  {entry}\n运行 /terminal-setup confirm 才会写入；/terminal-setup cancel 放弃。',
    'terminalSetup.noPending': '没有等待确认的设置',
    'terminalSetup.cancelled': '已放弃待确认的设置',
    'terminalSetup.stale': '自卡片显示后文件已被改动，没有写入。请重新运行 /terminal-setup apply',
    'terminalSetup.failed': '写入设置失败：{reason}',
    'terminalSetup.written':
      '已把 Shift+Enter 这一条加到 {path}。旧文件保存为 {backup}。如果按键还没生效，请重新打开终端面板。',
    'terminalSetup.created': '已创建 {path}，内含 Shift+Enter 这一条。如果按键还没生效，请重新打开终端面板。',
  },
}
