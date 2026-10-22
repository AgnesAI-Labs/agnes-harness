import { ANSI_RE, defang } from './ansi.js'
import { type Component, CURSOR_MARKER } from './component.js'
import { PasteAssembler } from './paste.js'
import type { ScreenRenderer } from './renderer.js'
import { displayWidth, type Terminal } from './terminal.js'

/** How settled text reaches native scrollback: DECSTBM margins, or scrolling the whole screen. */
export type ScrollMode = 'region' | 'full'

/**
 * The conversation's side of the split (the Timeline): the plain text of what became final since the
 * last call, never the same line twice; with `all`, also what is still in flight, for the exit.
 */
export type FooterSource = { takeSettled(width: number, all?: boolean): string[] }

/** Zellij keeps its own scrollback and mishandles margins; everything else takes the standard path. */
export function scrollModeFor(env: NodeJS.ProcessEnv): ScrollMode {
  const forced = env.AGH_SPLIT_FOOTER_SCROLL
  if (forced === 'region' || forced === 'full') return forced
  return env.ZELLIJ !== undefined ? 'full' : 'region'
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
const SGR_SPLIT = /(\x1b\[[0-9;]*m)/
// A line that is only a link stays whole so the terminal can still recognise it across its own wrap.
const LINK_ONLY = /^\s*(?:https?|file):\/\/\S+\s*$/
// Past this many rows a footer leaves no room for the conversation above it.
const MIN_HISTORY_ROWS = 1

type Row = { text: string; rows: number }

/** `line` cut to rows of at most `columns` cells, a style that was open carried onto the next row. */
function physicalRows(line: string, columns: number): Row[] {
  const width = displayWidth(line)
  if (width <= columns) return [{ text: line, rows: 1 }]
  if (LINK_ONLY.test(line.replace(ANSI_RE, ''))) return [{ text: line, rows: Math.ceil(width / columns) }]
  const out: Row[] = []
  let text = ''
  let used = 0
  let style = ''
  for (const part of line.split(SGR_SPLIT)) {
    if (part.startsWith('\x1b[')) {
      text += part
      style = part === '\x1b[0m' || part === '\x1b[m' ? '' : style + part
      continue
    }
    for (const { segment } of GRAPHEMES.segment(part)) {
      const w = displayWidth(segment)
      if (used > 0 && used + w > columns) {
        out.push({ text: style ? `${text}\x1b[0m` : text, rows: 1 })
        text = style
        used = 0
      }
      text += segment
      used += w
    }
  }
  out.push({ text, rows: 1 })
  return out
}

/**
 * Draws the footer (live tail, prompt, status) on the bottom rows of the normal screen and writes
 * settled conversation into the terminal's own scrollback above it, so the terminal's search,
 * selection and copy keep working on it. Nothing already written is rewritten, and the scrollback
 * is never cleared: a resize redraws the footer only.
 *
 * Geometry: the footer is pinned to the last rows of the screen. Above it are the rows holding the
 * conversation, then `slack` blank rows (the shell had not used them, or the footer got shorter).
 * Settled text first fills the slack, then scrolls the rows above the footer up into scrollback.
 */
export class FooterRenderer implements ScreenRenderer {
  lastFrame: string[] = []
  private active = false
  private ready = false
  private scheduled = false
  private generation = 0
  private offInput?: () => void
  private offResize?: () => void
  private readonly onExit = (): void => this.stop()
  private lastCursorKey = ''
  private suspended = false
  private paste = new PasteAssembler()
  private columns = 0
  private rows = 0
  // Rows the footer occupies on the screen, at the bottom.
  private height = 0
  // Blank rows between the conversation and the footer.
  private slack = 0

  constructor(
    private readonly term: Terminal,
    private readonly root: Component,
    private readonly source: FooterSource,
    private readonly mode: ScrollMode = scrollModeFor(process.env),
  ) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.ready = false
    this.generation++
    const generation = this.generation
    this.lastFrame = []
    this.lastCursorKey = ''
    this.height = 0
    this.paste = new PasteAssembler()
    process.once('exit', this.onExit)
    this.term.enterRaw()
    // No alternate screen and no mouse reporting: the shell page stays, and the terminal keeps the wheel
    // and text selection. Bracketed paste and focus reporting are the same as the fullscreen app.
    this.term.write('\x1b[?2004h\x1b[?1004h')
    this.offResize = this.term.onResize(() => this.renderNow())
    this.offInput = this.term.onInput((d) => {
      for (const part of this.paste.push(d)) if (this.root.handleInput?.(part)) this.requestRender()
    })
    // The footer starts under whatever the shell left; without an answer the screen counts as full.
    void (this.term.queryCursor?.() ?? Promise.resolve(undefined)).then((at) => {
      if (!this.active || generation !== this.generation) return
      const { columns, rows } = this.term.size()
      this.columns = columns
      this.rows = rows
      const end = at ? Math.min(rows, at.col > 1 ? at.row : at.row - 1) : rows
      this.slack = Math.max(0, rows - end)
      this.ready = true
      try {
        this.renderNow()
      } catch (error) {
        this.stop()
        throw error
      }
    })
  }

  /** Gives the terminal back for a child process; the footer comes back under whatever it left. */
  suspend(): () => void {
    if (!this.active) return () => {}
    this.teardown(false)
    this.suspended = true
    return () => {
      if (!this.suspended) return
      this.suspended = false
      this.start()
    }
  }

  /** Mouse reporting is never on here, so there is nothing to switch. */
  toggleMouse(): boolean {
    return false
  }

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
    if (!this.active || !this.ready) return
    const { columns, rows } = this.term.size()
    let out = ''
    if (columns !== this.columns || rows !== this.rows) out += this.reflow(columns, rows)

    const history = this.source.takeSettled(columns).flatMap((line) => physicalRows(defang(line), columns))
    const raw = this.root.render(columns)
    const room = Math.max(1, rows - MIN_HISTORY_ROWS)
    const visible = raw.length > room ? raw.slice(raw.length - room) : raw
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

    let repaint = this.lastFrame.length === 0
    const before = this.height
    if (frame.length > before) {
      const grow = frame.length - before
      const used = Math.min(this.slack, grow)
      this.slack -= used
      // Scrolling the whole screen up makes room; what leaves at the top goes into scrollback.
      if (grow > used) out += `\x1b[${rows};1H${'\n'.repeat(grow - used)}`
      repaint = true
    } else if (frame.length < before) {
      const freed = before - frame.length
      for (let row = rows - before + 1; row <= rows - frame.length; row++) out += `\x1b[${row};1H\x1b[2K`
      this.slack += freed
      repaint = true
    }
    this.height = frame.length
    const top = rows - frame.length + 1
    if (history.length > 0) {
      out += this.insert(history, top, rows)
      if (this.mode === 'full') repaint = true
    }

    for (let i = 0; i < frame.length; i++) {
      if (!repaint && frame[i] === this.lastFrame[i]) continue
      const text = frame[i] as string
      out += `\x1b[${top + i};1H${text}${displayWidth(text) < columns ? '\x1b[K' : ''}`
    }
    const place =
      cursorRow >= 0
        ? `\x1b[${top + cursorRow};${cursorCol + 1}H\x1b[?25h`
        : `\x1b[${top + frame.length - 1};1H`
    const cursorKey = `${cursorRow}:${cursorCol}:${top}`
    this.lastFrame = frame
    if (out === '' && cursorKey === this.lastCursorKey) return
    this.lastCursorKey = cursorKey
    this.term.write(`\x1b[?2026h\x1b[?25l${out}${place}\x1b[?2026l`)
  }

  /**
   * The escape sequences that put `lines` into the conversation above a footer whose first row is
   * `top`. The slack takes lines first, in place; the rest scrolls what is above the footer up.
   */
  private insert(lines: Row[], top: number, rows: number): string {
    let out = ''
    let at = 0
    let row = top - this.slack
    while (at < lines.length && row + (lines[at] as Row).rows <= top) {
      const { text, rows: n } = lines[at] as Row
      out += `\x1b[${row};1H${text}${displayWidth(text) < this.columns ? '\x1b[K' : ''}`
      row += n
      at++
    }
    this.slack = top - row
    const rest = lines.slice(at)
    if (rest.length === 0) return out
    // From here the conversation touches the footer, so no slack is left.
    this.slack = 0
    if (this.mode === 'region') {
      const bottom = Math.max(1, top - 1)
      out += `\x1b[1;${bottom}r\x1b[${bottom};1H`
      for (const { text } of rest) out += `\r\n${text}`
      return `${out}\x1b[r`
    }
    // Without margins: scroll the screen up by what fits above the footer, write it there, repeat.
    const room = Math.max(1, top - 1)
    while (rest.length > 0) {
      let count = 0
      let used = 0
      while (count < rest.length && (count === 0 || used + (rest[count] as Row).rows <= room))
        used += (rest[count++] as Row).rows
      out += `\x1b[${rows};1H${'\n'.repeat(used)}`
      let target = Math.max(1, top - used)
      for (const { text, rows: n } of rest.splice(0, count)) {
        out += `\x1b[${target};1H${text}${displayWidth(text) < this.columns ? '\x1b[K' : ''}`
        target += n
      }
    }
    return out
  }

  /**
   * The terminal changed size. It reflows what it holds on its own, and the footer, pinned to the
   * bottom, is assumed to stay there at whatever height the new width gives it. Only that is erased;
   * the conversation above, scrollback included, is left alone.
   */
  private reflow(columns: number, rows: number): string {
    const wrapped = this.lastFrame.reduce(
      (n, line) => n + Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, columns))),
      0,
    )
    const height = Math.min(rows, Math.max(this.height, wrapped))
    this.columns = columns
    this.rows = rows
    this.slack = Math.min(this.slack, Math.max(0, rows - height))
    this.height = height
    this.lastFrame = []
    this.lastCursorKey = ''
    return `\x1b[${rows - height + 1};1H\x1b[J`
  }

  /** Stops drawing and returns the terminal; with `flush` the rest of the conversation is written first. */
  private teardown(flush: boolean): void {
    process.off('exit', this.onExit)
    const wasActive = this.active
    const ready = this.ready
    this.active = false
    this.ready = false
    this.generation++
    this.scheduled = false
    this.offInput?.()
    this.offResize?.()
    try {
      let out = ''
      if (ready) {
        const { columns, rows } = this.term.size()
        if (columns !== this.columns || rows !== this.rows) out += this.reflow(columns, rows)
        out += `\x1b[${rows - this.height + 1};1H\x1b[J`
        this.slack += this.height
        this.height = 0
        const rest = flush
          ? this.source.takeSettled(columns, true).flatMap((line) => physicalRows(defang(line), columns))
          : []
        if (rest.length > 0) out += this.insert(rest, rows + 1, rows)
        // The shell prompt goes on the row under the last line of the conversation.
        const next = rows - this.slack + 1
        out += next > rows ? `\x1b[${rows};1H\r\n` : `\x1b[${next};1H`
      }
      this.term.write(`${out}\x1b[?1004l\x1b[?2004l\x1b[?25h`)
    } finally {
      if (wasActive) this.term.leaveRaw()
    }
  }

  /** Restores the shell: the footer is cleared and the rest of the conversation lands above the prompt. */
  stop(): void {
    this.suspended = false
    if (!this.active) {
      process.off('exit', this.onExit)
      return
    }
    this.teardown(true)
  }
}
