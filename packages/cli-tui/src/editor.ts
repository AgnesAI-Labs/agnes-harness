import { type Component, CURSOR_MARKER } from './component.js'
import { fitLine } from './components/line.js'
import { parseKey } from './keys.js'
import { displayWidth } from './terminal.js'

// Control bytes that must never enter the buffer. A paste can carry them; a newline is kept because
// a multi-line paste is a legitimate multi-line prompt.
// biome-ignore lint/suspicious/noControlCharactersInRegex: filtering them is the point
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Offsets in the text at which a character begins. Moving and deleting by these rather than by code
// unit keeps a combining mark with the letter it sits on and treats a surrogate pair as one keypress.
function boundaries(text: string): number[] {
  const out = [0]
  for (const s of GRAPHEMES.segment(text)) out.push(s.index + s.segment.length)
  return out
}

const PROMPT = '❯ '
const CONTINUATION = '  '

/**
 * Splits one logical line into the visual lines it occupies, breaking on columns rather than on
 * characters. The cursor marker takes no column of its own but is treated as needing one when
 * deciding where to break: a cursor sitting just past the last column of a full line belongs at the
 * start of the next line, not in a column the terminal does not have.
 */
function wrapLine(line: string, width: number): string[] {
  const limit = Math.max(1, width)
  const out: string[] = []
  let cur = ''
  let used = 0
  const pieces = line
    .split(CURSOR_MARKER)
    .flatMap((part, i) => [
      ...(i ? [CURSOR_MARKER] : []),
      ...Array.from(GRAPHEMES.segment(part), ({ segment }) => segment),
    ])
  for (const raw of pieces) {
    const piece = displayWidth(raw) > limit ? '…' : raw
    const w = displayWidth(piece)
    if (used + Math.max(w, 1) > limit && cur !== '') {
      out.push(cur)
      cur = ''
      used = 0
    }
    cur += piece
    used += w
  }
  out.push(cur)
  return out
}

export type EditorOptions = {
  maxRows?(): number
  placeholder?: string
  onSubmit(text: string): void
  onCancelKey?(): void
  complete?(prefix: string): string[]
  dim?(s: string): string
  /** Style for the prompt glyph itself; width math keeps using the unstyled prompt. */
  promptStyle?(s: string): string
  /** Style for the highlighted slash-menu row (the app passes a background colour). */
  menuStyle?(s: string): string
  /** Args shape and one-line description for a slash-menu candidate (the app passes the command table). */
  menuInfo?(name: string): { args?: string; description?: string } | undefined
}

// How many candidates the slash menu shows at once; the rest collapse into ↑/↓ count indicators.
const MENU_MAX_VISIBLE = 5

export class Editor implements Component {
  text = ''
  cursor = 0
  history: string[] = []
  private histIdx = -1
  private kitty = false
  private viewportStart = 0
  private menuIndex = 0
  private menuStart = 0

  constructor(private readonly o: EditorOptions) {}

  setKitty(v: boolean): void {
    this.kitty = v
  }

  setText(t: string): void {
    this.text = t
    this.cursor = t.length
  }

  clear(): void {
    this.setText('')
    this.histIdx = -1
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    const k = parseKey(data, this.kitty)
    const menu = this.menuCandidates()
    switch (k.name) {
      case 'enter': {
        // A trailing backslash is the way to enter a newline on terminals that cannot report
        // alt-enter or shift-enter at all.
        if (this.text.endsWith('\\')) {
          this.text = `${this.text.slice(0, -1)}\n`
          this.cursor = this.text.length
          return true
        }
        // The menu is open exactly when what is typed so far is an incomplete slash command: enter
        // accepts the highlighted one instead of submitting, the same as tab. A line that already
        // names a real command exactly (menu.length === 1 with that command as its only member,
        // which menuCandidates() itself never reports as "open") submits immediately, unchanged -
        // a fast typist who spells the whole command out is not forced through the menu.
        if (menu.length) {
          this.acceptCandidate(menu[this.menuIndex] as string)
          return true
        }
        if (!this.text.trim()) return true
        const t = this.text
        this.history.unshift(t)
        this.clear()
        this.o.onSubmit(t)
        return true
      }
      case 'alt-enter':
      case 'shift-enter':
        this.insert('\n')
        return true
      case 'backspace': {
        const from = this.prevBoundary()
        if (from < this.cursor) {
          this.text = this.text.slice(0, from) + this.text.slice(this.cursor)
          this.cursor = from
        }
        return true
      }
      case 'left':
        this.cursor = this.prevBoundary()
        return true
      case 'right':
        this.cursor = this.nextBoundary()
        return true
      // Per line, not per buffer. Every terminal editor moves to the ends of the line the cursor is
      // on; a jump to the ends of a multi-line draft would be a surprise with no key to undo it.
      case 'home':
        this.cursor = this.lineStart()
        return true
      case 'end':
        this.cursor = this.lineEnd()
        return true
      case 'up':
        if (menu.length) {
          this.menuIndex = (this.menuIndex - 1 + menu.length) % menu.length
        } else if (this.histIdx + 1 < this.history.length) {
          this.histIdx++
          this.setText(this.history[this.histIdx] as string)
        }
        return true
      case 'down':
        if (menu.length) {
          this.menuIndex = (this.menuIndex + 1) % menu.length
        } else if (this.histIdx > 0) {
          this.histIdx--
          this.setText(this.history[this.histIdx] as string)
        } else {
          this.histIdx = -1
          this.setText('')
        }
        return true
      case 'esc':
        this.clear()
        this.o.onCancelKey?.()
        return true
      case 'tab': {
        if (menu.length) {
          this.acceptCandidate(menu[this.menuIndex] as string)
          return true
        }
        const m = /(\S+)$/.exec(this.text.slice(0, this.cursor))
        const token = m?.[1]
        if (!token) return true
        const first = this.o.complete?.(token)?.[0]
        if (!first) return true
        this.text = `${this.text.slice(0, this.cursor - token.length)}${first} ${this.text.slice(this.cursor)}`
        this.cursor += first.length - token.length + 1
        return true
      }
      case 'char': {
        const s = (k.ch ?? '').replace(CONTROL, '')
        if (s) this.insert(s)
        return true
      }
      // Swallowed rather than passed on: an unrecognised escape sequence is not text and is not a
      // command, so the only correct thing to do with it is nothing.
      case 'unknown':
        return true
      default:
        return false
    }
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
  }

  private lineStart(): number {
    return this.text.lastIndexOf('\n', this.cursor - 1) + 1
  }

  private lineEnd(): number {
    const next = this.text.indexOf('\n', this.cursor)
    return next < 0 ? this.text.length : next
  }

  private prevBoundary(): number {
    const b = boundaries(this.text)
    let prev = 0
    for (const x of b) if (x < this.cursor) prev = x
    return prev
  }

  private nextBoundary(): number {
    for (const x of boundaries(this.text)) if (x > this.cursor) return x
    return this.text.length
  }

  /**
   * The slash-command menu is "open" exactly when the whole draft is one incomplete command token:
   * cursor at the end (so this is what is being typed right now, not an edit elsewhere in a longer
   * line), starting with `/`, with no space yet (a space means the user has moved on to arguments).
   * A single candidate that already equals the draft verbatim means the command is fully spelled
   * out already - there is nothing left to choose, so that case reports no candidates and lets
   * enter/tab fall through to their ordinary behavior (submit / prefix-complete) instead of forcing
   * an extra keystroke through the menu.
   */
  private menuCandidates(): string[] {
    if (this.cursor !== this.text.length || !/^\/\S*$/.test(this.text)) {
      this.menuIndex = 0
      this.menuStart = 0
      return []
    }
    const candidates = this.o.complete?.(this.text) ?? []
    if (candidates.length === 0 || (candidates.length === 1 && candidates[0] === this.text)) {
      this.menuIndex = 0
      this.menuStart = 0
      return []
    }
    this.menuIndex = Math.min(this.menuIndex, candidates.length - 1)
    return candidates
  }

  private acceptCandidate(candidate: string): void {
    this.text = `${candidate} `
    this.cursor = this.text.length
    this.menuIndex = 0
    this.menuStart = 0
  }

  private renderMenu(candidates: string[], width: number): string[] {
    const highlight = this.o.menuStyle ?? ((s: string) => s)
    const dim = this.o.dim ?? ((s: string) => s)
    // A five-row window follows the highlight: scrolling past either edge drags the window along,
    // and whatever lies outside it is reported as a dim ↑/↓ count instead of taking rows.
    let start = Math.max(0, Math.min(this.menuStart, Math.max(0, candidates.length - MENU_MAX_VISIBLE)))
    if (this.menuIndex < start) start = this.menuIndex
    if (this.menuIndex >= start + MENU_MAX_VISIBLE) start = this.menuIndex - MENU_MAX_VISIBLE + 1
    this.menuStart = start
    const shown = candidates.slice(start, start + MENU_MAX_VISIBLE)
    const lines = shown.map((c, i) => {
      const args = this.o.menuInfo?.(c)?.args
      const body = args ? `${c} ${dim(args)}` : c
      return start + i === this.menuIndex ? highlight(`› ${body}`) : `  ${body}`
    })
    const above = start
    const below = candidates.length - (start + shown.length)
    const indicators = [above > 0 ? `↑ ${above} more` : '', below > 0 ? `↓ ${below} more` : ''].filter(
      Boolean,
    )
    if (indicators.length) lines.push(`  ${dim(indicators.join('  '))}`)
    const description = this.o.menuInfo?.(candidates[this.menuIndex] as string)?.description
    if (description) lines.push(dim(description))
    // A useful box needs two sides and at least one content column. At widths below that, keep the
    // menu readable and honour the component width contract by dropping only the decoration.
    if (width < 3) return lines.map((line) => fitLine(line, width))

    // The menu wears a dim rounded frame hugging its widest row, the way pi draws it: a floating
    // box above the input line rather than bare rows bleeding into the scrollback. Normal terminals
    // get one column of breathing room on each side; a three- or four-column terminal keeps the
    // frame but sheds that padding so no rendered row can overflow the terminal.
    const padding = width >= 5 ? 1 : 0
    const inner = Math.min(Math.max(1, ...lines.map((line) => displayWidth(line))), width - 2 - padding * 2)
    const gap = ' '.repeat(padding)
    const side = dim('│')
    return [
      dim(`╭${'─'.repeat(inner + padding * 2)}╮`),
      ...lines.map((line) => `${side}${gap}${fitLine(line, inner)}${gap}${side}`),
      dim(`╰${'─'.repeat(inner + padding * 2)}╯`),
    ]
  }

  render(width: number): string[] {
    if (!Number.isFinite(width)) throw new Error('invalid editor width')
    width = Math.max(1, Math.trunc(width))
    const prompt = width > 2 ? PROMPT : width === 2 ? '❯' : ''
    const shown = prompt && this.o.promptStyle ? this.o.promptStyle(prompt) : prompt
    const continuation = width > 2 ? CONTINUATION : ' '.repeat(prompt.length)
    const inner = Math.max(1, width - prompt.length)
    if (!this.text) {
      const ph = wrapLine(this.o.placeholder ?? '', inner)[0] ?? ''
      return [`${shown}${CURSOR_MARKER}${this.o.dim ? this.o.dim(ph) : ph}`]
    }
    const marked = this.text.slice(0, this.cursor) + CURSOR_MARKER + this.text.slice(this.cursor)
    const out: string[] = []
    for (const [i, logical] of marked.split('\n').entries()) {
      const prefix = i === 0 ? shown : continuation
      for (const [j, seg] of wrapLine(logical, inner).entries())
        out.push((j === 0 ? prefix : continuation) + seg)
    }
    const requested = this.o.maxRows?.()
    const clamped =
      requested === undefined
        ? out
        : (() => {
            const rows = Number.isFinite(requested) ? Math.max(1, Math.trunc(requested)) : out.length
            const cursorRow = out.findIndex((line) => line.includes(CURSOR_MARKER))
            if (cursorRow < this.viewportStart) this.viewportStart = cursorRow
            if (cursorRow >= this.viewportStart + rows) this.viewportStart = cursorRow - rows + 1
            this.viewportStart = Math.max(0, Math.min(this.viewportStart, out.length - rows))
            return out.slice(this.viewportStart, this.viewportStart + rows)
          })()
    // The menu sits above the input line(s) it completes, not counted against maxRows: it is a
    // transient overlay reacting to what is being typed right now, not part of the draft itself.
    // The footer (status bar + hints) sits below the editor and is unaffected: the menu grows
    // upward out of the editor's own render output.
    const candidates = this.menuCandidates()
    return candidates.length ? [...this.renderMenu(candidates, width), ...clamped] : clamped
  }
}
