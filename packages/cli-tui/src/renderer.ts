import { ANSI_RE, defang } from './ansi.js'
import { type Component, CURSOR_MARKER } from './component.js'
import { type MouseEvent, parseMouse } from './keys.js'
import { PasteAssembler } from './paste.js'
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

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
const SGR_SPLIT = /(\x1b\[[0-9;]*m)/

/** Display columns [from, to) of a frame row, styles dropped. A wide glyph belongs to its first column. */
function columnText(line: string, from: number, to: number): string {
  let col = 0
  let text = ''
  for (const { segment } of GRAPHEMES.segment(line.replace(ANSI_RE, ''))) {
    if (col >= from && col < to) text += segment
    col += displayWidth(segment)
  }
  return text
}

/** Reverse video over columns [from, to), re-asserted after every style the row itself sets. */
function reverseColumns(line: string, from: number, to: number): string {
  let col = 0
  let out = ''
  let inside = false
  for (const part of line.split(SGR_SPLIT)) {
    if (part.startsWith('\x1b[')) {
      out += inside ? `${part}\x1b[7m` : part
      continue
    }
    for (const { segment } of GRAPHEMES.segment(part)) {
      const want = col >= from && col < to
      if (want !== inside) out += want ? '\x1b[7m' : '\x1b[27m'
      inside = want
      out += segment
      col += displayWidth(segment)
    }
  }
  return inside ? `${out}\x1b[27m` : out
}

/** What the app asks of whichever renderer drives the screen: fullscreen (`Renderer`) or the split footer. */
export interface ScreenRenderer {
  readonly lastFrame: readonly string[]
  start(): void
  stop(): void
  suspend(): () => void
  requestRender(): void
  renderNow(): void
  /** Ctrl-L: forgets what is on screen and paints everything again, changing no state. */
  redraw(): void
  toggleMouse(): boolean
  /** Whether mouse reporting is on right now. */
  readonly mouseReporting: boolean
  /** Turns mouse reporting on or off the way `/mouse` flips it; nothing happens when it already is as asked. */
  setMouse(on: boolean): void
}

/** Mouse handling the fullscreen app opts into: wheel rows to scroll by, and selected text to copy. */
export type RendererMouse = {
  wheel(rows: number): void
  copy(text: string): void
  /** A press and release on the same cell; the screen is drawn again after it either way. */
  click?: ((row: number, col: number) => void) | undefined
}
type Cell = { row: number; col: number }

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
  // process.exit (the signal ladder, a crash) runs no finally; this still hands the terminal back.
  private readonly onExit = (): void => this.stop()
  private lastCursorKey = ''
  // `runTui()` claims the alternate screen before it opens a session, so a slow daemon or
  // branding lookup cannot leave the previous CLI transcript visible. Unit callers normally let
  // the renderer claim it itself.
  private screenEntered: boolean
  // Screen cells, not content: what is copied is what the screen shows when the button comes up.
  private selection: { anchor: Cell; head: Cell } | undefined
  private dragging = false
  private mouseOn = false
  private suspended = false
  private paste = new PasteAssembler()

  constructor(
    private readonly term: Terminal,
    private readonly root: Component,
    screenAlreadyEntered = false,
    // Without mouse reporting the alternate screen turns the wheel into arrow keys, which the editor
    // reads as prompt history. With it the terminal stops selecting text itself, so the renderer
    // selects and copies instead.
    private readonly mouse?: RendererMouse,
    // Whether reporting is on from the start; `/mouse` still toggles it either way.
    private readonly mouseAtStart = true,
    // Wraps URLs and paths in terminal hyperlinks (links.ts); undefined where the terminal has none.
    private readonly links?: (row: string, columns: number) => string,
  ) {
    this.screenEntered = screenAlreadyEntered
  }

  start(): void {
    if (this.active) return
    this.active = true
    this.generation++
    this.lastFrame = []
    this.lastCursorKey = ''
    this.paste = new PasteAssembler(this.term.pasteBursts === true)
    process.once('exit', this.onExit)
    this.term.enterRaw()
    // Save the shell screen/cursor before painting. Never clear its scrollback (ED3). `runTui`
    // may already have claimed it while opening the session; entering 1049 a second time is not
    // a harmless no-op on every terminal, so only clear that existing alternate buffer here.
    if (this.screenEntered) this.term.write('\x1b[H\x1b[2J')
    else {
      this.term.write('\x1b[?1049h\x1b[H\x1b[2J')
      this.screenEntered = true
    }
    // Bracketed paste (2004): a paste arrives wrapped, so it cannot be mistaken for typing. Focus
    // reporting (1004) sends ESC [ I and ESC [ O as the window gains and loses the user's attention.
    this.term.write('\x1b[?2004h\x1b[?1004h')
    // 1002 reports presses, releases and motion while a button is held; 1006 gives SGR coordinates.
    this.mouseOn = this.mouse !== undefined && this.mouseAtStart
    if (this.mouseOn) this.term.write('\x1b[?1002h\x1b[?1006h')
    this.offResize = this.term.onResize(() => {
      this.lastFrame = []
      this.lastCursorKey = ''
      this.term.write('\x1b[H\x1b[2J')
      this.renderNow()
    })
    this.offInput = this.term.onInput((d) => {
      for (const part of this.paste.push(d)) this.input(part)
    })
    try {
      this.renderNow()
    } catch (error) {
      this.stop()
      throw error
    }
  }

  /**
   * Gives the terminal back as it was before the TUI (main screen, cooked mode, no mouse or paste mode)
   * so a child process can use it, and returns the call that takes it over again with the same mouse state.
   */
  suspend(): () => void {
    if (!this.active) return () => {}
    const mouseWas = this.mouseOn
    this.stop()
    this.suspended = true
    return () => {
      // A stop() while suspended (the app quit) means the terminal is not ours to take back.
      if (!this.suspended) return
      this.suspended = false
      this.start()
      if (this.mouse && mouseWas !== this.mouseOn) this.toggleMouse()
    }
  }

  /**
   * Turns mouse reporting off or on for the rest of this run and returns whether it is on. Off, the
   * terminal selects text itself, but the alternate screen turns the wheel into arrow keys.
   */
  toggleMouse(): boolean {
    if (!this.mouse || !this.active) return this.mouseOn
    this.mouseOn = !this.mouseOn
    this.selection = undefined
    this.dragging = false
    this.term.write(this.mouseOn ? '\x1b[?1002h\x1b[?1006h' : '\x1b[?1006l\x1b[?1002l')
    this.requestRender()
    return this.mouseOn
  }

  get mouseReporting(): boolean {
    return this.mouseOn
  }

  setMouse(on: boolean): void {
    if (on !== this.mouseOn) this.toggleMouse()
  }

  private input(d: string): void {
    const events = this.mouseOn ? parseMouse(d) : undefined
    if (events) {
      this.handleMouse(events)
      return
    }
    if (this.selection) {
      this.selection = undefined
      this.dragging = false
      this.requestRender()
    }
    if (this.root.handleInput?.(d)) this.requestRender()
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

  redraw(): void {
    if (!this.active) return
    this.lastFrame = []
    this.lastCursorKey = ''
    this.term.write('\x1b[H\x1b[2J')
    this.renderNow()
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

    const range = this.selectionRange()
    if (range)
      for (let row = range.start.row; row <= range.end.row && row < frame.length; row++)
        frame[row] = reverseColumns(
          frame[row] as string,
          row === range.start.row ? range.start.col : 0,
          row === range.end.row ? range.end.col : Number.POSITIVE_INFINITY,
        )

    const changed: string[] = []
    const height = Math.max(frame.length, this.lastFrame.length)
    for (let row = 0; row < height; row++) {
      if (frame[row] === this.lastFrame[row]) continue
      // Overwrite, then erase what is left of the old row. Erasing first would blank the whole row
      // (identity text beside an animated wordmark included) before it is written again.
      // A row that fills the terminal leaves the cursor pending-wrap on its last cell, where an erase
      // would blank that cell, and it overwrites the whole line anyway.
      // Links go on after the frame is recorded: selection, copy and the row diff all see plain text.
      const text = this.links ? this.links(frame[row] ?? '', columns) : (frame[row] ?? '')
      changed.push(`\x1b[${row + 1};1H${text}${displayWidth(text) < columns ? '\x1b[K' : ''}`)
    }

    // The cursor is parked below the frame and left hidden when no component asked for it, so it does
    // not sit blinking in the middle of rendered output.
    const place =
      cursorRow >= 0 ? `\x1b[${cursorRow + 1};${cursorCol + 1}H\x1b[?25h` : `\x1b[${frame.length + 1};1H`
    const cursorKey = `${cursorRow}:${cursorCol}:${frame.length}`
    this.lastFrame = frame
    if (changed.length === 0 && cursorKey === this.lastCursorKey) return
    this.lastCursorKey = cursorKey
    // Synchronized update (mode 2026): the terminal presents the frame at once; ones without it ignore it.
    this.term.write(`\x1b[?2026h\x1b[?25l${changed.join('')}${place}\x1b[?2026l`)
  }

  /** Selection in reading order, end column exclusive; a click that never moved selects nothing. */
  private selectionRange(): { start: Cell; end: Cell } | undefined {
    const s = this.selection
    if (!s || (s.anchor.row === s.head.row && s.anchor.col === s.head.col)) return undefined
    const forward = s.anchor.row < s.head.row || (s.anchor.row === s.head.row && s.anchor.col < s.head.col)
    return forward ? { start: s.anchor, end: s.head } : { start: s.head, end: s.anchor }
  }

  private handleMouse(events: MouseEvent[]): void {
    const mouse = this.mouse as RendererMouse
    for (const event of events) {
      if (event.kind === 'wheel') {
        if (!this.dragging) this.selection = undefined
        mouse.wheel(event.rows)
        continue
      }
      const at = { row: event.row, col: event.col }
      if (event.kind === 'press') {
        this.selection = { anchor: at, head: at }
        this.dragging = true
        continue
      }
      if (!this.dragging || !this.selection) continue
      this.selection.head = at
      if (event.kind !== 'release') continue
      this.dragging = false
      const range = this.selectionRange()
      const text = range
        ? Array.from({ length: range.end.row - range.start.row + 1 }, (_, i) => {
            const row = range.start.row + i
            return columnText(
              this.lastFrame[row] ?? '',
              row === range.start.row ? range.start.col : 0,
              row === range.end.row ? range.end.col : Number.POSITIVE_INFINITY,
            ).trimEnd()
          }).join('\n')
        : ''
      if (text.trim()) mouse.copy(text)
      else {
        this.selection = undefined
        if (!range) mouse.click?.(at.row, at.col)
      }
    }
    this.requestRender()
  }

  /**
   * Stops drawing and listening but leaves the alternate screen as it is, for the renderer that takes
   * it over in the same turn. Raw mode is handed back so the next `start()` enters it exactly once.
   */
  release(): void {
    if (!this.active) return
    process.off('exit', this.onExit)
    this.active = false
    this.generation++
    this.scheduled = false
    this.offInput?.()
    this.offResize?.()
    this.term.leaveRaw()
  }

  /** Restore the shell, optionally leaving one plain transcript, never a copy of UI chrome. */
  stop(transcript: readonly string[] = []): void {
    this.suspended = false
    process.off('exit', this.onExit)
    if (!this.active && !this.screenEntered) return
    const wasActive = this.active
    this.active = false
    this.generation++
    this.scheduled = false
    this.offInput?.()
    this.offResize?.()
    try {
      this.selection = undefined
      this.dragging = false
      this.term.write(
        `\x1b[?1004l\x1b[?2004l${this.mouse ? '\x1b[?1006l\x1b[?1002l' : ''}\x1b[?1049l\x1b[?25h`,
      )
      this.screenEntered = false
      const columns = this.term.size().columns
      for (const line of transcript)
        for (const wrapped of historyLines(line, columns)) this.term.write(`${wrapped}\r\n`)
    } finally {
      if (wasActive) this.term.leaveRaw()
    }
  }
}
