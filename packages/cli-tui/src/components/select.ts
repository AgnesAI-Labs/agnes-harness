import { type Component, escapeControl } from '../component.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import type { ThemedAnsi } from '../theme.js'
import { displayWidth } from '../terminal.js'
import { fitLine } from './line.js'

export type SelectOption = {
  id: string
  label: string
  /** A muted second column, aligned across the rows; left out below DESCRIPTION_MIN_WIDTH columns. */
  description?: string
  /** Marks the option in use now with an accent ` ✓` after its label. */
  current?: boolean
}

/** A list never shows more than this many options; the rest sit behind `↑ N more` / `↓ N more`. */
const MAX_VISIBLE = 8
/** Rows narrower than this drop the description column and keep the label whole. */
const DESCRIPTION_MIN_WIDTH = 50
/** The description column keeps at least this much room before a long label is cut. */
const DESCRIPTION_ROOM = 16

export class Select implements Component {
  private idx = 0
  private readonly options: SelectOption[]
  constructor(
    private readonly o: {
      options: SelectOption[]
      onChoose(id: string): void
      onCancel?(): void
      title?: string
      /** Marks the chosen row with the selection background and a bold accent. */
      ansi?: ThemedAnsi
      /** Optional viewport for long dynamic lists; selection still ranges over every option. */
      maxRows?(): number
    },
  ) {
    this.options = o.options.map((option) => ({ ...option }))
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    const key = parseKey(data, false)
    const action = actionFor('picker', key.name)
    if (action === 'picker-up') {
      this.idx = Math.max(0, this.idx - 1)
      return true
    }
    if (action === 'picker-down') {
      this.idx = Math.max(0, Math.min(this.options.length - 1, this.idx + 1))
      return true
    }
    if (action === 'picker-page-up' || action === 'picker-page-down') {
      const page = this.cap()
      const next = this.idx + (action === 'picker-page-up' ? -page : page)
      this.idx = Math.max(0, Math.min(this.options.length - 1, next))
      return true
    }
    if (action === 'picker-choose') {
      const option = this.options[this.idx]
      if (option) this.o.onChoose(option.id)
      return true
    }
    if (action === 'picker-cancel') {
      this.o.onCancel?.()
      return true
    }
    if (key.name === 'char' && key.ch && /^[1-9]$/.test(key.ch)) {
      const option = this.options[Number(key.ch) - 1]
      if (option) {
        this.idx = Number(key.ch) - 1
        this.o.onChoose(option.id)
      }
      return true
    }
    return false
  }
  /** How many rows the list may use, hint rows included. */
  private cap(): number {
    return Math.max(1, Math.min(MAX_VISIBLE, Math.floor(this.o.maxRows?.() ?? this.options.length)))
  }

  /** The window of options around the selection; the `↑`/`↓` hint rows count against the cap. */
  private window(cap: number): { start: number; end: number } {
    const n = this.options.length
    if (n <= cap) return { start: 0, end: n }
    for (let size = cap; size >= Math.max(1, cap - 2); size--) {
      const start = Math.max(0, Math.min(this.idx - size + 1, n - size))
      if (size + (start > 0 ? 1 : 0) + (start + size < n ? 1 : 0) <= cap) return { start, end: start + size }
    }
    const size = Math.max(1, cap - 2)
    const start = Math.max(0, Math.min(this.idx - size + 1, n - size))
    return { start, end: start + size }
  }

  render(width: number): string[] {
    const ansi = this.o.ansi
    const paint = (tone: 'faint' | 'muted' | 'accent', s: string) => (ansi ? ansi.fg(tone, s) : s)
    const { start, end } = this.window(this.cap())
    const rows = this.options.slice(start, end).map((option, offset) => {
      const i = start + offset
      const head = `${i === this.idx ? '❯' : ' '} `
      const num = `${i + 1}. `
      const label = escapeControl(option.label)
      const mark = option.current ? ' ✓' : ''
      return { i, head, num, label, mark, description: option.description && escapeControl(option.description) }
    })
    const left = (r: (typeof rows)[number]) => displayWidth(`${r.head}${r.num}${r.label}${r.mark}`)
    const showDescription = width >= DESCRIPTION_MIN_WIDTH && rows.some((r) => r.description)
    const column = showDescription
      ? Math.min(Math.max(...rows.map(left)), width - 2 - DESCRIPTION_ROOM)
      : 0
    const lines = rows.map((r) => {
      const selected = r.i === this.idx
      const plain = `${r.head}${r.num}${r.label}${r.mark}`
      const body = selected
        ? plain
        : `${r.head}${paint('faint', r.num)}${r.label}${r.mark ? paint('accent', r.mark) : ''}`
      const cell = showDescription ? fitLine(body, column) : body
      const text = `${cell}${r.description && showDescription ? `  ${selected ? r.description : paint('muted', r.description)}` : ''}`
      const line = fitLine(text, width)
      // Painted after fitting so the selection background spans the whole row.
      return selected && ansi ? ansi.bg('selection', ansi.bold(ansi.fg('accent', line))) : line
    })
    const more = (arrow: string, count: number) =>
      fitLine(paint('faint', `  ${arrow} ${count} more`), width)
    const out = [
      ...(start > 0 ? [more('↑', start)] : []),
      ...lines,
      ...(end < this.options.length ? [more('↓', this.options.length - end)] : []),
    ]
    if (!this.o.title) return out
    const title = fitLine(escapeControl(this.o.title), width)
    return [ansi ? ansi.bold(title) : title, ...out]
  }
}
