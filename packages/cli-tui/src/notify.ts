import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { escapeControl } from './component.js'
import { tt } from './locale-extended.js'

/** `on`: a desktop notification where the terminal has one, a bell elsewhere; `bell`: always a bell. */
export type NotifyMode = 'on' | 'bell' | 'off'
export type NotifyEvent = 'done' | 'approval' | 'error' | 'agent'

const MODES: readonly string[] = ['on', 'bell', 'off']
const BEL = '\x07'
const TITLE_MAX = 40

export const parseNotifyMode = (value: unknown): NotifyMode | undefined =>
  typeof value === 'string' && MODES.includes(value.trim().toLowerCase())
    ? (value.trim().toLowerCase() as NotifyMode)
    : undefined

/**
 * Terminals whose own documentation says OSC 9 posts a desktop notification: iTerm2
 * (TERM_PROGRAM=iTerm.app, LC_TERMINAL=iTerm2), Ghostty (TERM_PROGRAM=ghostty, TERM=xterm-ghostty),
 * WezTerm (TERM_PROGRAM=WezTerm), kitty (TERM=xterm-kitty; it reads the legacy iTerm2 form beside its
 * own OSC 99) and Warp (TERM_PROGRAM=WarpTerminal). Windows Terminal and ConEmu read OSC 9 as a
 * progress/ConEmu command, so they never get it, whatever else the environment says. Inside tmux
 * TERM_PROGRAM is tmux's own, so the variables the outer terminal exported stand in for it.
 */
export function supportsOsc9(env: NodeJS.ProcessEnv): boolean {
  if (env.WT_SESSION || env.ConEmuPID || env.ConEmuANSI) return false
  return (
    ['iTerm.app', 'ghostty', 'WezTerm', 'WarpTerminal'].includes(env.TERM_PROGRAM ?? '') ||
    env.LC_TERMINAL === 'iTerm2' ||
    env.TERM === 'xterm-kitty' ||
    env.TERM === 'xterm-ghostty' ||
    Boolean(env.ITERM_SESSION_ID || env.KITTY_WINDOW_ID || env.WEZTERM_PANE || env.GHOSTTY_RESOURCES_DIR)
  )
}

/** One line, no control characters, cut to a fixed width: the title is the only session text sent. */
const clean = (text: string): string => {
  const line = escapeControl(text).replace(/\s+/g, ' ').trim()
  return [...line].length > TITLE_MAX ? `${[...line].slice(0, TITLE_MAX - 1).join('')}…` : line
}

/**
 * What to write for `event`: '' when notifications are off, a bell, or an OSC 9 notification
 * (wrapped for tmux's passthrough when inside tmux). The text is `agh`, the event name and the
 * session title only: never the prompt, a command or a tool's arguments.
 */
export function notification(
  mode: NotifyMode,
  env: NodeJS.ProcessEnv,
  event: NotifyEvent,
  title: string,
  locale: string,
): string {
  if (mode === 'off') return ''
  if (mode === 'bell' || !supportsOsc9(env)) return BEL
  const text = clean(`agh · ${tt(`notify.${event}`, locale)} · ${clean(title)}`)
  const osc = `\x1b]9;${text}\x07`
  return env.TMUX ? `\x1bPtmux;${osc.replaceAll('\x1b', '\x1b\x1b')}\x1b\\` : osc
}

/** The saved mode, with `AGH_NOTIFY` laid over it; stored like the theme choice, in its own small file. */
export class NotifyPreference {
  /** The remembered mode, before `AGH_NOTIFY`. */
  saved: NotifyMode

  constructor(
    private readonly path: string | undefined,
    private readonly env: NodeJS.ProcessEnv,
    private readonly locale: () => string,
  ) {
    let mode: unknown
    try {
      mode = JSON.parse(readFileSync(path ?? '', 'utf8')).notify
    } catch {
      /* No saved choice. */
    }
    this.saved = parseNotifyMode(mode) ?? 'on'
  }

  /** The mode in force. */
  get mode(): NotifyMode {
    return parseNotifyMode(this.env.AGH_NOTIFY) ?? this.saved
  }

  get overridden(): boolean {
    return parseNotifyMode(this.env.AGH_NOTIFY) !== undefined
  }

  alert(event: NotifyEvent, title: string): string {
    return notification(this.mode, this.env, event, title, this.locale())
  }

  /** Remembers `mode`; false when it could not be written (it still holds for this run). */
  set(mode: NotifyMode): boolean {
    this.saved = mode
    if (!this.path) return false
    const temporary = `${this.path}.${randomUUID()}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({ notify: mode })}\n`, { mode: 0o600 })
      renameSync(temporary, this.path)
      return true
    } catch {
      return false
    } finally {
      try {
        rmSync(temporary, { force: true })
      } catch {
        /* Best-effort temporary cleanup. */
      }
    }
  }
}
