import { ANSI_RE, defang } from './ansi.js'
import { type Component, CURSOR_MARKER } from './component.js'
import { displayWidth, type Terminal } from './terminal.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function historyLines(line: string, columns: number): string[] {
  const lines: string[] = []
  let current = ''
  for (const { segment } of GRAPHEMES.segment(defang(line).replace(ANSI_RE, ''))) {
    if (current && displayWidth(current + segment) > Math.max(1, columns)) {
      lines.push(current)
      current = ''
    }
    current += segment
  }
  lines.push(current)
  return lines
}

/**
 * Holds a root component and repaints only the rows that changed since the last frame.
 *
 * Frames are drawn on the alternate screen. The shell and its scrollback stay untouched while
 * the TUI runs, including during resize. A frame taller than the terminal is truncated
 * to its last rows: absolute cursor addressing past the last row is clamped by the terminal, so an
 * untruncated frame would stack every overflowing line on the bottom row instead of dropping them.
 *
 * That clamp is a permanent invariant, not a stand-in for windowing. A view that windows correctly
 * hands over a frame no taller than the terminal and the clamp does nothing; a view that gets its
 * arithmetic wrong degrades to a scrolled-off head instead of a pile on the bottom row. A windowing
 * view owns scrolling through whatever it drops; native terminal scrollback is not the UI model.
 */
export class Renderer {
  lastFrame: string[] = []
  private scheduled = false
  private active = false
  private generation = 0
  private offInput?: () => void
  private offResize?: () => void
  private lastCursorKey = ''
  // `runTui()` claims the alternate screen before it opens a session, so a slow daemon or
  // branding lookup cannot leave the previous CLI transcript visible. Unit callers normally let
  // the renderer claim it itself.
  private screenEntered: boolean

  constructor(
    private readonly term: Terminal,
    private readonly root: Component,
    screenAlreadyEntered = false,
  ) {
    this.screenEntered = screenAlreadyEntered
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.generation++
    this.lastFrame = []
    this.lastCursorKey = ''
    this.term.enterRaw()
    // Save the shell screen/cursor before painting. Never clear its scrollback (ED3). `runTui`
    // may already have claimed it while opening the session; entering 1049 a second time is not
    // a harmless no-op on every terminal, so only clear that existing alternate buffer here.
    if (this.screenEntered) this.term.write('\x1b[H\x1b[2J')
    else {
      this.term.write('\x1b[?1049h\x1b[H\x1b[2J')
      this.screenEntered = true
    }
    this.offResize = this.term.onResize(() => {
      this.lastFrame = []
      this.lastCursorKey = ''
      this.term.write('\x1b[H\x1b[2J')
      this.renderNow()
    })
    this.offInput = this.term.onInput((d) => {
      if (this.root.handleInput?.(d)) this.requestRender()
    })
    try {
      this.renderNow()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  // Many events can land in one turn of the event loop; coalescing them means one repaint per turn
  // rather than one per event.
  requestRender(): void {
    if (!this.active || this.scheduled) return
    this.scheduled = true
    const generation = this.generation
    queueMicrotask(() => {
      if (!this.active || generation !== this.generation) return
      this.scheduled = false
      this.renderNow()
    })
  }

  renderNow(): void {
    if (!this.active) return
    const { columns, rows } = this.term.size()
    const raw = this.root.render(columns)
    const visible = raw.length > rows ? raw.slice(raw.length - rows) : raw

    const frame: string[] = []
    let cursorRow = -1
    let cursorCol = 0
    for (const line of visible) {
      const at = line.indexOf(CURSOR_MARKER)
      if (at >= 0 && cursorRow < 0) {
        cursorRow = frame.length
        cursorCol = displayWidth(line.slice(0, at))
      }
      frame.push(defang(line.replaceAll(CURSOR_MARKER, '')))
    }

    const changed: string[] = []
    const height = Math.max(frame.length, this.lastFrame.length)
    for (let row = 0; row < height; row++) {
      if (frame[row] === this.lastFrame[row]) continue
      changed.push(`\x1b[${row + 1};1H\x1b[2K${frame[row] ?? ''}`)
    }

    // The cursor is parked below the frame and left hidden when no component asked for it, so it does
    // not sit blinking in the middle of rendered output.
    const place =
      cursorRow >= 0 ? `\x1b[${cursorRow + 1};${cursorCol + 1}H\x1b[?25h` : `\x1b[${frame.length + 1};1H`
    const cursorKey = `${cursorRow}:${cursorCol}:${frame.length}`
    this.lastFrame = frame
    if (changed.length === 0 && cursorKey === this.lastCursorKey) return
    this.lastCursorKey = cursorKey
    this.term.write(`\x1b[?25l${changed.join('')}${place}`)
  }

  /** Restore the shell, optionally leaving one plain transcript, never a copy of UI chrome. */
  stop(transcript: readonly string[] = []): void {
    if (!this.active && !this.screenEntered) return
    const wasActive = this.active
    this.active = false
    this.generation++
    this.scheduled = false
    this.offInput?.()
    this.offResize?.()
    try {
      this.term.write('\x1b[?1049l\x1b[?25h')
      this.screenEntered = false
      const columns = this.term.size().columns
      for (const line of transcript)
        for (const wrapped of historyLines(line, columns)) this.term.write(`${wrapped}\r\n`)
    } finally {
      if (wasActive) this.term.leaveRaw()
    }
  }
}
