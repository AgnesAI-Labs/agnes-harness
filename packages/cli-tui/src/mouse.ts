import { spawn } from 'node:child_process'
import { fitLine } from './components/line.js'
import type { RendererMouse } from './renderer.js'
import { displayWidth } from './terminal.js'

/** The fullscreen app's mouse: wheel scrolling, and copying a selection with a brief "copied" tip. */
export class TuiMouse implements RendererMouse {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly wheel: (rows: number) => void,
    private readonly write: (text: string) => void,
    private readonly label: () => string,
    private readonly changed: () => unknown,
  ) {}

  copy(text: string): void {
    this.write(text)
    this.dispose()
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.changed()
    }, 2000)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Writes the tip over the right end of `rows[row]` while showing, so no row moves. */
  overlay(rows: string[], row: number, width: number): void {
    if (!this.timer) return
    const tip = this.label()
    const room = width - displayWidth(tip) - 1
    if (row >= 0 && row < rows.length && room > 0) rows[row] = `${fitLine(rows[row] ?? '', room)} ${tip}`
  }
}

/**
 * Copies selected screen text. OSC 52 reaches the clipboard of the terminal the user is looking at,
 * over SSH too, where the terminal allows it; Terminal.app ignores it and iTerm2 asks for a setting,
 * so a local session also hands the text to the platform's own command. Failures stay silent: a copy
 * that did not land must not take the input handler down with it.
 */
export function copyToClipboard(
  text: string,
  write: (s: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  if (env.SSH_CONNECTION || env.SSH_TTY) return
  const command = platform === 'darwin' ? 'pbcopy' : platform === 'win32' ? 'clip' : undefined
  if (!command) return
  try {
    const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    child.on('error', () => {})
    child.stdin.on('error', () => {})
    // clip reads the console code page unless the text arrives as UTF-16 with a byte-order mark.
    child.stdin.end(platform === 'win32' ? Buffer.from(`﻿${text}`, 'utf16le') : text)
  } catch {}
}
