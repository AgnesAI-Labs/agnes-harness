import { type Component, CURSOR_MARKER } from './component.js'
import { fitLine } from './components/line.js'
import { lineColumn, lineStartOf, moveLine, nextWordEnd, prevWordStart } from './edit-motion.js'
import { type MentionItem, type MentionState, mentionText, mentionToken } from './file-mentions.js'
import { type Key, parseKey } from './keys.js'
import { tt } from './locale-extended.js'
import type { Tone } from './palette.js'
import { HistorySearch, PromptHistory } from './prompt-history.js'
import { displayWidth } from './terminal.js'
import type { ThemedAnsi } from './theme.js'
import { UndoStack } from './undo.js'

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

// A paste past either bound shows as one chip in the buffer and goes out in full on submit.
const PASTE_FOLD_LINES = 10
const PASTE_FOLD_CHARS = 1000

const PROMPT = '❯ '
const CONTINUATION = '  '

const MENU_LEFT_MAX = 30
const MENU_SUMMARY_MIN = 8

/** Cut to at most `max` columns, ending in `…` when anything was dropped; empty when it cannot fit. */
function truncateTo(text: string, max: number): string {
  if (displayWidth(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (displayWidth(out + ch) > max - 1) break
    out += ch
  }
  return max >= 2 ? `${out}…` : ''
}

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
  locale?: string
  onSubmit(text: string): void
  onCancelKey?(): void
  /** Ctrl-G: the app hands the draft to the user's own editor and writes the result back with `replaceDraft`. */
  onExternalEdit?(): void
  /** Sent prompts, kept across runs when it has a file; without it history lasts this editor's lifetime. */
  history?: PromptHistory
  /** True while a turn runs: esc then interrupts it and leaves the draft alone. */
  busy?(): boolean
  complete?(prefix: string): string[]
  /** Styles the prompt glyph, placeholder and slash menu; width math always uses the unstyled text. */
  ansi?: ThemedAnsi
  /** Args shape and short summary for a slash-menu candidate (the app passes the command table). */
  menuInfo?(name: string): { args?: string; summary?: string } | undefined
  /** Workspace paths for the `@` menu; without it `@` is plain text. */
  mentions?: { get(query: string): MentionState }
  /** The `@` menu's status rows, shown when it has nothing to choose. */
  mentionNotes?: { loading: string; empty: string; failed: string }
}

// What the open menu offers: the rows to choose from, how to take one, and a status row when empty.
type Menu = { labels: string[]; accept(index: number): void; note?: string; slash: boolean }

// How many candidates the slash menu shows at once; the rest collapse into ↑/↓ count indicators.
const MENU_MAX_VISIBLE = 5

export class Editor implements Component {
  text = ''
  cursor = 0
  private readonly store: PromptHistory
  private search: HistorySearch | undefined
  private histIdx = -1
  private kitty = false
  private viewportStart = 0
  private menuIndex = 0
  private menuStart = 0
  // The text before the cursor when Esc closed the `@` menu: it stays closed until that changes.
  private dismissed: string | undefined
  private mentionQuery: string | undefined
  // Chip text to the pasted text it stands for; lives only as long as this process.
  private readonly pastes = new Map<string, string>()
  private pasteCount = 0
  // The last text cut by Ctrl-K, Ctrl-U, Ctrl-W or Alt-D: one buffer, replaced by each cut, never the system clipboard.
  private killed = ''
  private readonly undo = new UndoStack()
  // The display column vertical moves aim for, so a short line in between does not lose it.
  private goalColumn: number | undefined

  constructor(private readonly o: EditorOptions) {
    this.store = o.history ?? new PromptHistory()
  }

  /** Newest first. */
  get history(): string[] {
    return this.store.entries
  }

  setKitty(v: boolean): void {
    this.kitty = v
  }

  /** Every draft source (queue, external editor, history, a failed send) lands here: nothing it holds may act on the terminal. */
  setText(raw: string): void {
    const t = raw.replace(/\r\n?/g, '\n').replaceAll('\t', '  ').replace(CONTROL, '')
    this.text = t
    this.cursor = t.length
  }

  clear(): void {
    this.setText('')
    this.histIdx = -1
    this.pastes.clear()
    this.undo.clear()
  }

  /** Swaps the whole draft for `t` as one undoable step. */
  replaceDraft(t: string): void {
    this.undo.record({ text: this.text, cursor: this.cursor }, false)
    this.setText(t)
    this.histIdx = -1
  }

  /** Forgets what Ctrl-Z could undo, for when the draft no longer belongs to what is on screen (a session switch). */
  resetUndo(): void {
    this.undo.clear()
  }

  /** The draft with every paste chip replaced by the text it stands for: what a submit sends. */
  expanded(): string {
    let out = this.text
    for (const [chip, text] of this.pastes) out = out.replaceAll(chip, () => text)
    return out
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    const k = parseKey(data, this.kitty)
    if (this.search) return this.searching(k, data)
    const before = { text: this.text, cursor: this.cursor }
    const generation = this.undo.generation
    const handled = this.handleKey(k)
    const edited = this.text !== before.text
    // An undo, redo or clear moved the history itself and is not an edit to record.
    if (edited && generation === this.undo.generation) this.undo.record(before, k.name === 'char')
    else if (k.name !== 'char') this.undo.endRun()
    if (edited || (k.name !== 'up' && k.name !== 'down')) this.goalColumn = undefined
    return handled
  }

  private handleKey(k: Key): boolean {
    const menu = this.openMenu()
    const choices = menu?.labels.length ?? 0
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
        if (menu && choices) {
          menu.accept(this.menuIndex)
          return true
        }
        if (!this.text.trim()) return true
        const t = this.expanded()
        this.store.add(t)
        this.clear()
        this.o.onSubmit(t)
        return true
      }
      case 'alt-enter':
      case 'shift-enter':
        this.insert('\n')
        return true
      case 'backspace': {
        const before = this.text.slice(0, this.cursor)
        const chip = [...this.pastes.keys()].find((c) => before.endsWith(c))
        if (chip) {
          this.text = before.slice(0, before.length - chip.length) + this.text.slice(this.cursor)
          this.cursor -= chip.length
          return true
        }
        const from = this.prevBoundary()
        if (from < this.cursor) {
          this.text = this.text.slice(0, from) + this.text.slice(this.cursor)
          this.cursor = from
        }
        return true
      }
      case 'left':
      case 'ctrl-b':
        this.cursor = this.prevBoundary()
        return true
      case 'right':
      case 'ctrl-f':
        this.cursor = this.nextBoundary()
        return true
      // Per line, not per buffer. Every terminal editor moves to the ends of the line the cursor is
      // on; a jump to the ends of a multi-line draft would be a surprise with no key to undo it.
      case 'home':
      case 'ctrl-a':
        this.cursor = this.lineStart()
        return true
      case 'end':
      case 'ctrl-e':
        this.cursor = this.lineEnd()
        return true
      case 'up':
        if (choices) {
          this.menuIndex = (this.menuIndex - 1 + choices) % choices
        } else if (!this.moveVertically(-1) && this.histIdx + 1 < this.history.length) {
          // History starts only past the first line of a multi-line draft.
          this.histIdx++
          this.setText(this.history[this.histIdx] as string)
        }
        return true
      case 'down':
        if (choices) {
          this.menuIndex = (this.menuIndex + 1) % choices
        } else if (!this.moveVertically(1)) {
          // History starts only past the last line of a multi-line draft.
          if (this.histIdx > 0) {
            this.histIdx--
            this.setText(this.history[this.histIdx] as string)
          } else {
            this.histIdx = -1
            this.setText('')
          }
        }
        return true
      case 'esc':
        if (menu && !menu.slash) {
          this.dismissed = this.text.slice(0, this.cursor)
          return true
        }
        if (!this.o.busy?.()) this.clear()
        this.o.onCancelKey?.()
        return true
      case 'tab': {
        if (menu) {
          if (choices) menu.accept(this.menuIndex)
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
      case 'paste':
        this.paste(k.ch ?? '')
        return true
      case 'ctrl-r':
        this.search = new HistorySearch(this.store, { text: this.text, cursor: this.cursor })
        return true
      case 'char': {
        const s = (k.ch ?? '').replace(CONTROL, '')
        if (s) this.insert(s)
        return true
      }
      // Swallowed rather than passed on: an unrecognised escape sequence is not text and is not a
      // command, so the only correct thing to do with it is nothing.
      case 'unknown':
      case 'alt-up':
        return true
      default:
        return this.readlineKey(k)
    }
  }

  // The emacs keys beyond plain cursor moves: word motion, cuts and Ctrl-Y, undo and redo, Ctrl-G.
  private readlineKey(k: Key): boolean {
    switch (k.name) {
      case 'word-left':
        this.cursor = prevWordStart(this.text, this.cursor)
        return true
      case 'word-right':
        this.cursor = nextWordEnd(this.text, this.cursor)
        return true
      case 'ctrl-k': {
        // At the end of a line the cut takes the newline, so lines can be joined.
        const end = this.lineEnd()
        this.kill(this.cursor, end > this.cursor ? end : Math.min(this.text.length, end + 1))
        return true
      }
      case 'ctrl-u':
        this.kill(this.lineStart(), this.cursor)
        return true
      case 'ctrl-w':
      case 'word-delete-back':
        this.kill(prevWordStart(this.text, this.cursor), this.cursor)
        return true
      case 'word-delete':
        this.kill(this.cursor, nextWordEnd(this.text, this.cursor))
        return true
      case 'ctrl-y':
        if (this.killed) this.insert(this.killed)
        return true
      case 'ctrl-z':
      case 'ctrl-shift-z': {
        const now = { text: this.text, cursor: this.cursor }
        const to = k.name === 'ctrl-z' ? this.undo.undo(now) : this.undo.redo(now)
        if (to) {
          this.text = to.text
          this.cursor = to.cursor
        }
        return true
      }
      case 'ctrl-g':
        this.o.onExternalEdit?.()
        return true
      default:
        return false
    }
  }

  private kill(from: number, to: number): void {
    if (to <= from) return
    this.killed = this.text.slice(from, to)
    this.text = this.text.slice(0, from) + this.text.slice(to)
    this.cursor = from
  }

  // True when the draft has another line in that direction and the cursor moved onto it.
  private moveVertically(dir: -1 | 1): boolean {
    if (!this.text.includes('\n')) return false
    const column = this.goalColumn ?? lineColumn(this.text, this.cursor)
    const to = moveLine(this.text, this.cursor, dir, column)
    if (to === undefined) return false
    this.goalColumn = column
    this.cursor = to
    return true
  }

  // Keys while Ctrl-R search is open. Enter takes the match into the draft without sending it; esc puts
  // the original draft back; any other key takes the match and then does what it always does.
  private searching(k: Key, data: string): boolean {
    const search = this.search as HistorySearch
    switch (k.name) {
      case 'ctrl-r':
        search.older()
        return true
      case 'char': {
        const text = (k.ch ?? '').replace(CONTROL, '')
        if (text) search.type(text)
        return true
      }
      case 'backspace':
        search.erase()
        return true
      case 'paste':
      case 'unknown':
        return true
      case 'esc':
        this.search = undefined
        this.text = search.draft.text
        this.cursor = search.draft.cursor
        return true
      default: {
        this.search = undefined
        if (search.hit !== undefined) this.setText(search.hit)
        else {
          this.text = search.draft.text
          this.cursor = search.draft.cursor
        }
        return k.name === 'enter' ? true : this.handleInput(data)
      }
    }
  }

  private renderSearch(search: HistorySearch, width: number): string[] {
    const locale = this.o.locale ?? 'en'
    const first = search.hit?.split('\n')[0] ?? ''
    const hit = search.hit === undefined ? (search.query ? tt('search.none', locale) : '') : first
    const more = search.hit?.includes('\n') ? ' …' : ''
    return wrapLine(`${tt('search.label', locale)} '${search.query}${CURSOR_MARKER}': ${hit}${more}`, width)
  }

  // Terminals paste a newline as a carriage return; tabs would not survive the renderer, and every
  // other control byte is dropped as it is from typed text.
  private paste(raw: string): void {
    const text = raw.replace(/\r\n?/g, '\n').replaceAll('\t', '  ').replace(CONTROL, '')
    const lines = text.split('\n').length
    if (lines <= PASTE_FOLD_LINES && text.length <= PASTE_FOLD_CHARS) {
      this.insert(text)
      return
    }
    const chip = tt('paste.chip', this.o.locale ?? 'en', { n: ++this.pasteCount, lines })
    this.pastes.set(chip, text)
    this.insert(chip)
  }

  private insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor)
    this.cursor += s.length
  }

  private lineStart(): number {
    return lineStartOf(this.text, this.cursor)
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
    if (this.cursor !== this.text.length || !/^\/\S*$/.test(this.text)) return []
    const candidates = this.o.complete?.(this.text) ?? []
    if (candidates.length === 0 || (candidates.length === 1 && candidates[0] === this.text)) return []
    this.menuIndex = Math.min(this.menuIndex, candidates.length - 1)
    return candidates
  }

  private acceptCandidate(candidate: string): void {
    this.text = `${candidate} `
    this.cursor = this.text.length
    this.menuIndex = 0
    this.menuStart = 0
  }

  /** The slash menu when the draft is a command being typed, else the `@` menu for a mention at the cursor. */
  private openMenu(): Menu | undefined {
    const slash = this.menuCandidates()
    if (slash.length) {
      this.mentionQuery = undefined
      return { labels: slash, slash: true, accept: (i) => this.acceptCandidate(slash[i] as string) }
    }
    const before = this.text.slice(0, this.cursor)
    if (before !== this.dismissed) this.dismissed = undefined
    const token = this.o.mentions && this.dismissed === undefined ? mentionToken(before) : undefined
    const state = token && this.o.mentions?.get(token.query)
    if (!token || !state) {
      // Nothing open: the next menu to open starts at its top.
      this.menuIndex = 0
      this.menuStart = 0
      this.mentionQuery = undefined
      return undefined
    }
    if (token.query !== this.mentionQuery) this.menuIndex = 0
    this.mentionQuery = token.query
    const items = state.items
    this.menuIndex = Math.min(this.menuIndex, Math.max(0, items.length - 1))
    const notes = this.o.mentionNotes ?? {
      loading: 'Searching…',
      empty: 'No matching files',
      failed: 'Cannot search files',
    }
    return {
      labels: items.map((item) => (item.directory ? `${item.id}/` : item.id)),
      slash: false,
      accept: (i) => this.acceptMention(token.start, items[i] as MentionItem),
      ...(items.length
        ? {}
        : { note: state.status === 'ready' ? notes.empty : (state.reason ?? notes[state.status]) }),
    }
  }

  private acceptMention(start: number, item: MentionItem): void {
    const rest = this.text.slice(this.cursor)
    // A file mention ends in a space; one already following the cursor serves.
    const head = this.text.slice(0, start) + mentionText(item).replace(/ $/u, /^\s/u.test(rest) ? '' : ' ')
    this.text = head + rest
    this.cursor = head.length
    this.menuIndex = 0
    this.menuStart = 0
  }

  private paint(tone: Tone, s: string): string {
    return this.o.ansi ? this.o.ansi.fg(tone, s) : s
  }

  private bold(s: string): string {
    return this.o.ansi ? this.o.ansi.bold(s) : s
  }

  private renderMenu({ labels: candidates, note, slash }: Menu, width: number): string[] {
    // A five-row window follows the highlight: scrolling past either edge drags the window along,
    // and whatever lies outside it is reported as a faint ↑/↓ count instead of taking rows.
    let start = Math.max(0, Math.min(this.menuStart, Math.max(0, candidates.length - MENU_MAX_VISIBLE)))
    if (this.menuIndex < start) start = this.menuIndex
    if (this.menuIndex >= start + MENU_MAX_VISIBLE) start = this.menuIndex - MENU_MAX_VISIBLE + 1
    this.menuStart = start
    const shown = candidates.slice(start, start + MENU_MAX_VISIBLE)
    const selected = candidates.length ? this.menuIndex - start : -1
    const info = (name: string | undefined) =>
      slash && name !== undefined ? this.o.menuInfo?.(name) : undefined
    // Left column per row: pointer, name and args. The name is never cut; args shrink to fit
    // MENU_LEFT_MAX. The summary column appears only when it keeps MENU_SUMMARY_MIN columns.
    const layout = (cap: number) =>
      shown.map((c) => {
        const entry = info(c)
        const nameWidth = 2 + displayWidth(c)
        const args = entry?.args ? truncateTo(entry.args, cap - nameWidth - 1) : ''
        return { c, args, summary: entry?.summary, left: nameWidth + (args ? 1 + displayWidth(args) : 0) }
      })
    const avail = width - 2 - (width >= 5 ? 2 : 0)
    let rows = layout(MENU_LEFT_MAX)
    const withSummary =
      width >= 3 &&
      rows.some((r) => r.summary) &&
      avail >= Math.max(0, ...rows.map((r) => r.left)) + 2 + MENU_SUMMARY_MIN
    // Without the summary column the args keep today's untruncated layout.
    if (!withSummary) rows = layout(Number.POSITIVE_INFINITY)
    const leftWidth = Math.max(0, ...rows.map((r) => r.left))
    const lines = rows.map((r, i) => {
      const body = r.args ? `${this.bold(r.c)} ${this.paint('faint', r.args)}` : this.bold(r.c)
      const left = i === selected ? `${this.bold(this.paint('accent', '❯'))} ${body}` : `  ${body}`
      if (!withSummary || !r.summary) return left
      return `${left}${' '.repeat(leftWidth - r.left + 2)}${this.paint('muted', r.summary)}`
    })
    if (note) lines.push(`  ${this.paint('faint', note)}`)
    const above = start
    const below = candidates.length - (start + shown.length)
    const indicators = [above > 0 ? `↑ ${above} more` : '', below > 0 ? `↓ ${below} more` : ''].filter(
      Boolean,
    )
    if (indicators.length) lines.push(`  ${this.paint('faint', indicators.join('  '))}`)
    // A useful box needs two sides and at least one content column. At widths below that, keep the
    // menu readable and honour the component width contract by dropping only the decoration.
    if (width < 3) return lines.map((line) => fitLine(line, width))

    // The menu wears a rounded frame hugging its widest row: a floating box above the input line
    // rather than bare rows bleeding into the scrollback. Normal terminals get one column of
    // breathing room on each side; a three- or four-column terminal keeps the frame but sheds that
    // padding so no rendered row can overflow the terminal.
    const padding = width >= 5 ? 1 : 0
    const inner = Math.min(Math.max(1, ...lines.map((line) => displayWidth(line))), width - 2 - padding * 2)
    const gap = ' '.repeat(padding)
    const side = this.paint('border', '│')
    const ansi = this.o.ansi
    return [
      this.paint('border', `╭${'─'.repeat(inner + padding * 2)}╮`),
      ...lines.map((line, i) => {
        const row = `${gap}${fitLine(line, inner)}${gap}`
        return `${side}${i === selected && ansi ? ansi.bg('selection', row) : row}${side}`
      }),
      this.paint('border', `╰${'─'.repeat(inner + padding * 2)}╯`),
    ]
  }

  render(width: number): string[] {
    if (!Number.isFinite(width)) throw new Error('invalid editor width')
    width = Math.max(1, Math.trunc(width))
    if (this.search) return this.renderSearch(this.search, width)
    const prompt = width > 2 ? PROMPT : width === 2 ? '❯' : ''
    const shown = prompt && this.bold(this.paint('accent', prompt))
    const continuation = width > 2 ? CONTINUATION : ' '.repeat(prompt.length)
    const inner = Math.max(1, width - prompt.length)
    if (!this.text) {
      const ph = wrapLine(this.o.placeholder ?? '', inner)[0] ?? ''
      return [`${shown}${CURSOR_MARKER}${this.paint('faint', ph)}`]
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
    const menu = this.openMenu()
    return menu ? [...this.renderMenu(menu, width), ...clamped] : clamped
  }
}
