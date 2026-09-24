import { Terminal as Xterm } from '@xterm/headless'
import type { FakeTerminal } from '../../src/tui/terminal.js'

export type Screen = {
  lines: string[]
  scrollback: string[]
  cursor: { row: number; col: number }
  cursorHidden: boolean
}

// Cursor visibility is tracked by the emulator but not published on its public surface, so the test
// harness reads it off the core service. Only the harness does this; nothing in src/ depends on it.
type XtermInternals = { _core?: { coreService?: { isCursorHidden?: boolean } } }

/**
 * Replays what a FakeTerminal was asked to write through a real terminal emulator and reports
 * the screen that results. Assertions against this see what a user would see; assertions against the
 * raw writes only see that the renderer agrees with itself about which sequences to emit.
 *
 * `seed` puts content on the screen before the replay and `from` skips the writes that produced it,
 * which is how a repaint onto a screen the renderer did not draw can be observed.
 */
export async function emulate(
  term: FakeTerminal,
  cols: number,
  rows: number,
  opts: { from?: number; seed?: string } = {},
): Promise<Screen> {
  const x = new Xterm({ cols, rows, allowProposedApi: true })
  if (opts.seed) await new Promise<void>((r) => x.write(opts.seed as string, r))
  for (const w of term.writes.slice(opts.from ?? 0)) await new Promise<void>((r) => x.write(w, r))
  const lines: string[] = []
  for (let i = 0; i < rows; i++)
    lines.push(x.buffer.active.getLine(x.buffer.active.baseY + i)?.translateToString(true) ?? '')
  const scrollback = Array.from(
    { length: x.buffer.active.baseY },
    (_, i) => x.buffer.active.getLine(i)?.translateToString(true) ?? '',
  )
  const screen: Screen = {
    lines,
    scrollback,
    cursor: { row: x.buffer.active.cursorY, col: x.buffer.active.cursorX },
    cursorHidden: (x as unknown as XtermInternals)._core?.coreService?.isCursorHidden === true,
  }
  x.dispose()
  return screen
}

export async function screenOf(term: FakeTerminal, cols: number, rows: number): Promise<string[]> {
  return (await emulate(term, cols, rows)).lines
}
