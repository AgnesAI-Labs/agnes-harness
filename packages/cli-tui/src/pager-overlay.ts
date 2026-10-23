import { createAnsi } from './ansi.js'
import type { Component } from './component.js'
import { fitLine } from './components/line.js'
import { actionFor } from './keymap.js'
import { parseKey } from './keys.js'
import { tt } from './locale-extended.js'
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
  changed(): void
}

/**
 * Ctrl-T: the whole loaded conversation on a full screen of its own. It reads a snapshot of the
 * timeline's rows and keeps its own scroll position, so the live view underneath neither moves nor
 * is touched while it is open. Older history is read a page at a time when the top is reached again.
 */
export class PagerOverlay implements Component {
  private active = false
  private lines: string[] = []
  private top = 0
  private max = 0
  private width = 0
  private stale = true
  private loading = false

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
        this.lines = this.build(this.width)
        // What the user was looking at stays where it was: the new rows came in above it.
        this.top += this.lines.length - before
        this.o.changed()
      }
    } catch {
      // The projection reports its own read failures; the pager just stays where it is.
    } finally {
      this.loading = false
    }
  }

  private build(width: number): string[] {
    const out: string[] = this.o.timeline.earlier
      ? [this.ansi.fg('faint', tt('timeline.earlierHistory', this.o.locale))]
      : []
    const lead = out.length
    for (const block of this.o.timeline.blocks(width)) {
      if (out.length > lead) out.push('')
      out.push(...block.rows)
    }
    return out.length === 0 ? [this.ansi.fg('faint', tt('pager.empty', this.o.locale))] : out
  }

  handleInput(data: string): boolean {
    if (!this.active) return false
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
    }
    return true
  }

  render(width: number): string[] {
    if (!this.active) return []
    if (this.stale || width !== this.width) {
      this.lines = this.build(width)
      this.width = width
      this.stale = false
    }
    const height = Math.max(1, this.o.term.size().rows - 1)
    this.max = Math.max(0, this.lines.length - height)
    this.top = Math.min(Math.max(0, this.top), this.max)
    const body = this.lines.slice(this.top, this.top + height)
    while (body.length < height) body.push('')
    const position = tt('pager.status', this.o.locale, {
      from: Math.min(this.top + 1, this.lines.length),
      to: Math.min(this.top + height, this.lines.length),
      total: this.lines.length,
    })
    const status = this.ansi.fg('faint', fitLine(`${tt('pager.hint', this.o.locale)} · ${position}`, width))
    return this.o.theme.frame(createAnsi(this.o.term.caps.color), [...body, status], width, height + 1)
  }

  private get ansi(): ThemedAnsi {
    return this.o.theme.ansi(createAnsi(this.o.term.caps.color))
  }
}
