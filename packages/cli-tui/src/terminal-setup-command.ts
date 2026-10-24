import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TuiApp } from './app.js'
import type { SlashResult } from './commands.js'
import { type ExtendedKey, tt } from './locale-extended.js'
import { oneLine } from './session-commands.js'
import {
  applyPlan,
  type Editor,
  keybindingsPath,
  type Plan,
  planShiftEnter,
  SHIFT_ENTER_JSON,
} from './vscode-keybindings.js'

export type TerminalName =
  | 'vscode'
  | 'cursor'
  | 'iterm2'
  | 'wezterm'
  | 'ghostty'
  | 'kitty'
  | 'alacritty'
  | 'windows-terminal'
  | 'apple-terminal'
  | 'other'

/** What the setup reads from the machine; tests pass their own. */
export type SetupDeps = { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string; now: () => Date }
const REAL: SetupDeps = {
  env: process.env,
  platform: process.platform, // guards-allow-platform: the keybindings file lives under the editor's per-OS settings directory.
  home: homedir(),
  now: () => new Date(),
}

const NAMES: Record<TerminalName, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  iterm2: 'iTerm2',
  wezterm: 'WezTerm',
  ghostty: 'Ghostty',
  kitty: 'kitty',
  alacritty: 'Alacritty',
  'windows-terminal': 'Windows Terminal',
  'apple-terminal': 'Terminal.app',
  other: '',
}

/**
 * Which terminal is at the far end, from the variables each one exports (the same ones `notify.ts` reads
 * for OSC 9). `TERM_PROGRAM` names the closest terminal; inside tmux it is tmux's own, so the others stand
 * in for it. Cursor is a VS Code build and says so only through its own variables.
 */
export function detectTerminal(env: NodeJS.ProcessEnv): TerminalName {
  const program = env.TERM_PROGRAM ?? ''
  if (program === 'vscode')
    return env.CURSOR_TRACE_ID || /cursor/i.test(env.VSCODE_GIT_ASKPASS_MAIN ?? '') ? 'cursor' : 'vscode'
  if (env.WT_SESSION && !env.ConEmuPID) return 'windows-terminal'
  if (program === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2' || env.ITERM_SESSION_ID) return 'iterm2'
  if (program === 'WezTerm' || env.WEZTERM_PANE) return 'wezterm'
  if (program === 'ghostty' || env.TERM === 'xterm-ghostty' || env.GHOSTTY_RESOURCES_DIR) return 'ghostty'
  if (program === 'kitty' || env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) return 'kitty'
  if (env.TERM === 'alacritty' || env.ALACRITTY_LOG || env.ALACRITTY_SOCKET) return 'alacritty'
  if (program === 'Apple_Terminal') return 'apple-terminal'
  return 'other'
}

// The bytes every one of these sends for Shift+Enter: ESC then Return, which the TUI reads as Alt+Enter.
const SNIPPETS: Partial<Record<TerminalName, { file?: (d: SetupDeps) => string; code: string }>> = {
  wezterm: {
    file: (d) => join(d.home, '.wezterm.lua'),
    code: "keys = {\n  { key = 'Enter', mods = 'SHIFT', action = wezterm.action.SendString '\\x1b\\r' },\n},",
  },
  ghostty: {
    file: (d) => join(d.home, '.config', 'ghostty', 'config'),
    code: 'keybind = shift+enter=text:\\x1b\\r',
  },
  kitty: {
    file: (d) => join(d.home, '.config', 'kitty', 'kitty.conf'),
    code: 'map shift+enter send_text all \\x1b\\r',
  },
  alacritty: {
    file: (d) => join(d.env.APPDATA ?? join(d.home, '.config'), 'alacritty', 'alacritty.toml'),
    code: '[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001b\\r"',
  },
  'windows-terminal': {
    code: '{ "command": { "action": "sendInput", "input": "\\u001b\\r" }, "keys": "shift+enter" }',
  },
}

const PROSE: Partial<Record<TerminalName, ExtendedKey>> = {
  iterm2: 'terminalSetup.iterm2',
  'apple-terminal': 'terminalSetup.appleTerminal',
  wezterm: 'terminalSetup.wezterm',
  'windows-terminal': 'terminalSetup.windowsTerminal',
}

const editorOf = (name: TerminalName, env: NodeJS.ProcessEnv): Editor =>
  name === 'cursor' ? 'Cursor' : /insider/i.test(env.TERM_PROGRAM_VERSION ?? '') ? 'Code - Insiders' : 'Code'

// One confirmation per app: the card names the file as it was read, and confirm checks it has not changed.
const pending = new WeakMap<TuiApp, Plan>()

/**
 * `/terminal-setup`: how to make Shift+Enter a newline in the terminal this TUI runs in. A terminal that
 * reports the key through the kitty keyboard protocol (which the TUI turns on where it is safe) needs
 * nothing; the others get the exact configuration and where it goes. Nothing is written, except for VS Code
 * and Cursor on `/terminal-setup apply`, which shows a card first, writes only after `confirm`, copies the
 * old keybindings.json to a backup file first and only ever appends one entry to it.
 */
export async function terminalSetupSlash(
  app: TuiApp,
  line: string,
  deps: SetupDeps = REAL,
): Promise<SlashResult> {
  const { locale } = app
  const word = line.trim().slice('/terminal-setup'.length).trim()
  const said = (key: ExtendedKey, vars?: Record<string, string | number>): SlashResult => ({
    text: tt(key, locale, vars),
  })
  const name = detectTerminal(deps.env)
  const editable = name === 'vscode' || name === 'cursor'
  if (word === 'cancel') {
    pending.delete(app)
    return said('terminalSetup.cancelled')
  }
  if (word === 'confirm') {
    const plan = pending.get(app)
    pending.delete(app)
    if (!plan) return said('terminalSetup.noPending')
    const now = planShiftEnter(plan.path, deps.now())
    if ('refused' in now || now.before !== plan.before) return said('terminalSetup.stale')
    try {
      applyPlan(now)
    } catch (error) {
      return said('terminalSetup.failed', {
        reason: oneLine(error instanceof Error ? error.message : String(error)),
      })
    }
    return said(now.backup ? 'terminalSetup.written' : 'terminalSetup.created', {
      path: oneLine(now.path),
      backup: oneLine(now.backup ?? ''),
    })
  }
  if (word === 'apply') {
    if (!editable) return said('terminalSetup.noApply', { name: NAMES[name] || '-' })
    const path = keybindingsPath(editorOf(name, deps.env), deps.platform, deps.env, deps.home)
    const plan = planShiftEnter(path, deps.now())
    if ('refused' in plan) return said(`terminalSetup.refused.${plan.refused}`, { path: oneLine(path) })
    pending.set(app, plan)
    return {
      text: tt(plan.backup ? 'terminalSetup.card' : 'terminalSetup.cardNew', locale, {
        path: oneLine(plan.path),
        backup: oneLine(plan.backup ?? ''),
        entry: SHIFT_ENTER_JSON,
      }),
      presentation: 'transcript',
    }
  }
  if (word !== '') return said('terminalSetup.usage')

  const lines: string[] = []
  const multiplexed = deps.env.TMUX !== undefined || /^(screen|tmux)/.test(deps.env.TERM ?? '')
  const kitty = app.o.term.caps.kittyKeyboard
  // WezTerm only speaks the protocol when its own option is on, which it is not by default.
  if (kitty && name !== 'wezterm') {
    return said('terminalSetup.none', { name: NAMES[name] || oneLine(deps.env.TERM_PROGRAM ?? '-') })
  }
  lines.push(
    NAMES[name]
      ? tt('terminalSetup.detected', locale, { name: NAMES[name] })
      : tt('terminalSetup.unknown', locale),
    tt('terminalSetup.how', locale),
  )
  if (multiplexed) lines.push(tt('terminalSetup.multiplexer', locale))
  const prose = PROSE[name]
  if (prose) lines.push(tt(prose, locale))
  if (editable) {
    const path = keybindingsPath(editorOf(name, deps.env), deps.platform, deps.env, deps.home)
    lines.push(tt('terminalSetup.addTo', locale, { path: oneLine(path) }), `  ${SHIFT_ENTER_JSON}`)
    lines.push(tt('terminalSetup.applyHint', locale))
  }
  const snippet = SNIPPETS[name]
  if (snippet) {
    if (snippet.file) lines.push(tt('terminalSetup.addTo', locale, { path: oneLine(snippet.file(deps)) }))
    lines.push(...snippet.code.split('\n').map((code) => `  ${code}`))
  }
  return { text: lines.join('\n'), presentation: 'transcript' }
}
