import { createAnsi } from './ansi.js'
import type { Component } from './component.js'
import { fitLine } from './components/line.js'
import { actionFor } from './keymap.js'
import { parseKey } from './keys.js'
import { tt } from './locale-extended.js'
import type { TuiMouse } from './mouse.js'
import { findMatches, highlight, type Match } from './pager-search.js'
import type { Terminal } from './terminal.js'
import type { ThemedAnsi, TuiTheme } from './theme.js'
import type { Timeline } from './views/timeline.js'

export type PagerOptions = {
  theme: TuiTheme
  /** Its size is the screen the pager fills; its colour depth is what the frame is drawn with. */
  term: Pick<Terminal, 'caps' | 'size'>
  locale: string
  /** The loaded conversation, entry by entry, and whether older history than that exists. */
  timeline: Pick<Timeline, 'blocks' | 'earlier'>
  /** Reads one page of older history into the loaded window; false when nothing came. */
  loadEarlier(): Promise<boolean>
  /** The same clipboard path as `/copy` and a mouse selection, and the tip it shows afterwards. */
  mouse: Pick<TuiMouse, 'copy' | 'overlay'>
  changed(): void
}

const MAX_QUERY = 200
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

/**
 * Ctrl-T: the whole loaded conversation on a full screen of its own. It reads a snapshot of the
 * timeline's rows and keeps its own scroll position, so the live view underneath neither moves nor
 * is touched while it is open. Older history is read a page at a time when the top is reached again.
 * `/` searches the rows (case-insensitive, plain text), `n` and `N` step through the hits and `c`
 * copies the whole message the current hit is in.
 */
export class PagerOverlay implements Component {
  private active = false
  private lines: string[] = []
  // Where each entry starts among the rows, and the text a copy of it takes.
  private starts: number[] = []
  private texts: string[] = []
  private top = 0
  private max = 0
  private width = 0
  private stale = true
  private loading = false
  private query = ''
  private draft: string | undefined
  private found: Match[] = []
  private byRow = new Map<number, Match[]>()
  private cur = 0

  constructor(private readonly o: PagerOptions) {}

  get open(): boolean {
    return this.active
  }

  /** Opens at the newest output, like the conversation itself. */
  show(): void {
    this.active = true
    this.stale = true
    this.top = Number.MAX_SAFE_INTEGER
    this.o.changed()
  }

  close(): void {
    this.active = false
    this.lines = []
    this.query = ''
    this.draft = undefined
    this.search()
    this.o.changed()
  }

  invalidate(): void {
    this.stale = true
  }

  /** Negative is up. Trying to go up from the first row reads the next older page, when there is one. */
  scroll(delta: number): void {
    if (!this.active) return
    const from = Math.min(this.top, this.max)
    if (delta < 0 && from === 0) {
      void this.more()
      return
    }
    this.top = Math.max(0, Math.min(this.max, from + delta))
    this.o.changed()
  }

  private async more(): Promise<void> {
    if (this.loading || !this.o.timeline.earlier) return
    this.loading = true
    try {
      if ((await this.o.loadEarlier()) && this.active) {
        const before = this.lines.length
        const at = this.found[this.cur]
        this.layout(this.width)
        // What the user was looking at stays where it was: the new rows came in above it.
        const added = this.lines.length - before
        this.top += added
        if (at)
          this.cur = Math.max(
            0,
            this.found.findIndex((m) => m.row === at.row + added && m.start === at.start),
          )
        this.o.changed()
      }
    } catch {
      // The projection reports its own read failures; the pager just stays where it is.
    } finally {
      this.loading = false
    }
  }

  /** Lays the loaded entries out as rows for `width`, and finds the query in them again. */
  private layout(width: number): void {
    const lines: string[] = this.o.timeline.earlier
      ? [this.ansi.fg('faint', tt('timeline.earlierHistory', this.o.locale))]
      : []
    const lead = lines.length
    this.starts = []
    this.texts = []
    for (const block of this.o.timeline.blocks(width)) {
      if (lines.length > lead) lines.push('')
      this.starts.push(lines.length)
      this.texts.push(block.text)
      lines.push(...block.rows)
    }
    this.lines = lines.length === 0 ? [this.ansi.fg('faint', tt('pager.empty', this.o.locale))] : lines
    this.width = width
    this.search()
  }

  /** Finds `query` in the rows; the current hit stays at its place in the order where it can. */
  private search(): void {
    const lead = this.starts[0] ?? this.lines.length
    this.found = findMatches(this.lines.slice(lead), this.query).map((m) => ({ ...m, row: m.row + lead }))
    this.byRow = new Map()
    for (const m of this.found) this.byRow.set(m.row, [...(this.byRow.get(m.row) ?? []), m])
    this.cur = Math.min(this.cur, Math.max(0, this.found.length - 1))
  }

  private jump(): void {
    const at = this.found[this.cur]
    if (!at) return
    const height = Math.max(1, this.o.term.size().rows - 1)
    this.top = Math.max(0, Math.min(this.lines.length - height, at.row - Math.floor(height / 2)))
    this.o.changed()
  }

  private step(by: number): void {
    if (this.found.length === 0) return
    this.cur = (this.cur + by + this.found.length) % this.found.length
    this.jump()
  }

  private copy(): void {
    const at = this.found[this.cur]
    const text = at ? this.texts[this.starts.findLastIndex((start) => start <= at.row)] : undefined
    if (text !== undefined) this.o.mouse.copy(text)
  }

  /** A key typed into the query: Enter searches, Esc leaves the old search as it was. */
  private type(data: string): void {
    const key = parseKey(data, false)
    const draft = this.draft ?? ''
    if (key.name === 'enter') {
      this.query = draft
      this.draft = undefined
      this.cur = 0
      this.search()
      this.jump()
    } else if (key.name === 'esc' || key.name === 'ctrl-c') this.draft = undefined
    else if (key.name === 'backspace') this.draft = Array.from(draft).slice(0, -1).join('')
    else if (key.name === 'char' || key.name === 'paste')
      this.draft = Array.from(draft + (key.ch ?? '').replace(CONTROL, ''))
        .slice(0, MAX_QUERY)
        .join('')
    this.o.changed()
  }

  handleInput(data: string): boolean {
    if (!this.active) return false
    if (this.draft !== undefined) {
      this.type(data)
      return true
    }
    const key = parseKey(data, false)
    const page = Math.max(1, this.o.term.size().rows - 2)
    switch (actionFor('pager', key.name === 'char' ? (key.ch ?? '') : key.name)) {
      case 'pager-close':
        this.close()
        break
      case 'pager-up':
        this.scroll(-1)
        break
      case 'pager-down':
        this.scroll(1)
        break
      case 'pager-page-up':
        this.scroll(-page)
        break
      case 'pager-page-down':
        this.scroll(page)
        break
      case 'pager-top':
        this.scroll(Number.NEGATIVE_INFINITY)
        break
      case 'pager-bottom':
        this.scroll(Number.POSITIVE_INFINITY)
        break
      case 'pager-search':
        this.draft = ''
        this.o.changed()
        break
      case 'pager-next':
        this.step(1)
        break
      case 'pager-prev':
        this.step(-1)
        break
      case 'pager-copy':
        this.copy()
        break
    }
    return true
  }

  private statusText(height: number): string {
    const locale = this.o.locale
    if (this.draft !== undefined) return tt('pager.typing', locale, { query: this.draft })
    if (this.query === '') {
      const position = tt('pager.status', locale, {
        from: Math.min(this.top + 1, this.lines.length),
        to: Math.min(this.top + height, this.lines.length),
        total: this.lines.length,
      })
      return `${tt('pager.hint', locale)} · ${position}`
    }
    const at = this.found.length === 0 ? 0 : this.cur + 1
    return `${tt('pager.found', locale, { query: this.query, at, total: this.found.length })} · ${tt('pager.hintFound', locale)}`
  }

  render(width: number): string[] {
    if (!this.active) return []
    if (this.stale || width !== this.width) {
      this.layout(width)
      this.stale = false
    }
    const height = Math.max(1, this.o.term.size().rows - 1)
    this.max = Math.max(0, this.lines.length - height)
    this.top = Math.min(Math.max(0, this.top), this.max)
    const current = this.found[this.cur]
    const body = this.lines.slice(this.top, this.top + height).map((line, i) => {
      const hits = this.byRow.get(this.top + i)
      return hits ? highlight(line, hits, current) : line
    })
    while (body.length < height) body.push('')
    const rows = [...body, this.ansi.fg('faint', fitLine(this.statusText(height), width))]
    this.o.mouse.overlay(rows, height, width)
    return this.o.theme.frame(createAnsi(this.o.term.caps.color), rows, width, height + 1)
  }

  private get ansi(): ThemedAnsi {
    return this.o.theme.ansi(createAnsi(this.o.term.caps.color))
  }
}
