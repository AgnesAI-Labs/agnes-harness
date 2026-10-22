import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import { fitLine } from './components/line.js'
import { tt } from './locale-extended.js'
import type { RendererMouse } from './renderer.js'
import { displayWidth } from './terminal.js'
import type { ThemedAnsi } from './theme.js'

/** What a copy came to: the platform command took it, only the terminal was asked to, or it failed. */
export type CopyKind = 'copied' | 'sent' | 'failed'

/** The tip over the right end of a row after a copy, worded and coloured for how the copy went. */
export function copyTip(ansi: ThemedAnsi, locale: string): (kind: CopyKind) => string {
  const key = { copied: 'app.copied', sent: 'copy.sent', failed: 'copy.failed' } as const
  return (kind) => ansi.fg(kind === 'failed' ? 'danger' : 'success', tt(key[kind], locale))
}

/** The fullscreen app's mouse: wheel scrolling, and copying a selection with a brief tip on how it went. */
export class TuiMouse implements RendererMouse {
  private timer: ReturnType<typeof setTimeout> | undefined
  private kind: CopyKind = 'copied'

  constructor(
    readonly wheel: (rows: number) => void,
    // Returns 'sent' or 'failed' when it knows; anything else reads as copied. `fail` reports a
    // failure that only shows up after it returned.
    private readonly write: (text: string, fail: () => void) => unknown,
    private readonly label: (kind: CopyKind) => string,
    private readonly changed: () => unknown,
    /** A click (press and release on one cell) on a screen row of the conversation. */
    readonly click?: (row: number) => unknown,
  ) {}

  copy(text: string): void {
    const result = this.write(text, () => this.show('failed'))
    this.show(result === 'sent' || result === 'failed' ? result : 'copied')
  }

  private show(kind: CopyKind): void {
    this.kind = kind
    this.dispose()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.changed()
    }, 2000)
    this.changed()
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Writes the tip over the right end of `rows[row]` while showing, so no row moves. */
  overlay(rows: string[], row: number, width: number): void {
    if (!this.timer) return
    const tip = this.label(this.kind)
    const room = width - displayWidth(tip) - 1
    if (row >= 0 && row < rows.length && room > 0) rows[row] = `${fitLine(rows[row] ?? '', room)} ${tip}`
  }
}

/**
 * Copies selected screen text. OSC 52 reaches the clipboard of the terminal the user is looking at,
 * over SSH too, where the terminal allows it; Terminal.app ignores it and iTerm2 asks for a setting,
 * so a local session also hands the text to the platform's own command. Nothing confirms OSC 52, so a
 * copy that went only that way reports 'sent'. When the command cannot start or exits badly the copy
 * is 'failed', through `onFail` if that is only known later: it must not take the input handler down.
 */
export function copyToClipboard(
  text: string,
  write: (s: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform, // guards-allow-platform: owned terminal clipboard backend selects the native copy command.
  onFail?: () => void,
): CopyKind {
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'sent'
  // Absolute paths: a bare name would resolve through the workspace directory first on Windows, so a
  // repository could plant its own `clip` to run on every copy.
  const command =
    platform === 'darwin'
      ? '/usr/bin/pbcopy'
      : platform === 'win32'
        ? win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'clip.exe')
        : undefined
  if (!command) return 'sent'
  try {
    const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', () => onFail?.())
    child.on('close', (code) => {
      if (code) onFail?.()
    })
    child.stdin.on('error', () => onFail?.())
    // clip reads the console code page unless the text arrives as UTF-16 with a byte-order mark.
    child.stdin.end(platform === 'win32' ? Buffer.from(`\ufeff${text}`, 'utf16le') : text)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** The copier a real terminal uses: `copyToClipboard` with this process's environment and platform. */
export const systemCopy =
  (write: (s: string) => void) =>
  (text: string, fail: () => void): CopyKind =>
    copyToClipboard(text, write, undefined, undefined, fail)
