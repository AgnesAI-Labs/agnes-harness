import { type Component, escapeControl } from '../component.js'
import { parseKey } from '../keys.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
import { fitLine } from './line.js'
import { Select } from './select.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export type FilterOption = {
  id: string
  label: string
  /** Extra text the filter matches besides the label, such as an id or a path. */
  search?: string
}

/**
 * A `Select` you can narrow by typing: case-insensitive substring over each option's label and search
 * text. Backspace deletes a character, Esc clears the filter before it closes the list, and digits pick a
 * row only while the filter is empty (after that they are text). Choosing returns the original option id.
 */
export class FilterSelect implements Component {
  private filter = ''
  private select: Select

  constructor(
    private readonly o: {
      options: FilterOption[]
      locale?: string
      onChoose(id: string): void
      onCancel?(): void
      ansi?: ThemedAnsi
      maxRows?(): number
    },
  ) {
    this.select = this.build()
  }

  private matches(): FilterOption[] {
    const needle = this.filter.toLowerCase()
    return this.o.options.filter((option) =>
      `${option.label}\n${option.search ?? ''}`.toLowerCase().includes(needle),
    )
  }

  private build(): Select {
    const { onChoose, onCancel, ansi, maxRows } = this.o
    return new Select({
      options: this.matches().map(({ id, label }) => ({ id, label })),
      onChoose,
      ...(onCancel ? { onCancel } : {}),
      ...(ansi ? { ansi } : {}),
      // The filter line takes a row of the picker's budget.
      ...(maxRows ? { maxRows: () => Math.max(1, maxRows() - (this.filter ? 1 : 0)) } : {}),
    })
  }

  private setFilter(next: string): void {
    this.filter = next
    this.select = this.build()
  }

  invalidate(): void {}

  handleInput(data: string): boolean {
    const key = parseKey(data, false)
    if (key.name === 'char' || key.name === 'paste') {
      const text = (key.ch ?? '').replace(/\s+/gu, ' ').replace(/\p{Cc}/gu, '')
      if (key.name === 'char' && !this.filter && /^[1-9]$/.test(text)) return this.select.handleInput(data)
      if (text) this.setFilter(this.filter + text)
      return true
    }
    if (key.name === 'backspace') {
      if (this.filter)
        this.setFilter(this.filter.slice(0, Array.from(GRAPHEMES.segment(this.filter)).at(-1)?.index))
      return true
    }
    if (key.name === 'esc' && this.filter) {
      this.setFilter('')
      return true
    }
    return this.select.handleInput(data)
  }

  render(width: number): string[] {
    const rows = this.select.render(width)
    if (!this.filter) return rows
    const shown = tt('picker.filter', this.o.locale ?? 'en', {
      q: escapeControl(this.filter),
      n: this.matches().length,
      total: this.o.options.length,
    })
    return [fitLine(this.o.ansi ? this.o.ansi.fg('muted', shown) : shown, width), ...rows]
  }
}
