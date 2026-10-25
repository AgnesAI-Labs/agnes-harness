import { type Component, escapeControl } from '../component.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'
import { fitLine } from './line.js'
import { Select, type SelectOption } from './select.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export type FilterOption = SelectOption & {
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
      /** The filter text to start with, for a list rebuilt around the same query. */
      initialFilter?: string
      /** Tab: the owner may swap the list; the current filter is handed over to carry across. */
      onScope?(filter: string): void
      /** Shown when there is nothing to list and no filter is typed. */
      emptyText?: string
    },
  ) {
    this.filter = o.initialFilter ?? ''
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
      options: this.matches().map(({ search: _search, ...option }) => option),
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
    const action = actionFor('picker', key.name)
    if (action === 'picker-scope') {
      this.o.onScope?.(this.filter)
      return true
    }
    if (action === 'picker-erase') {
      if (this.filter)
        this.setFilter(this.filter.slice(0, Array.from(GRAPHEMES.segment(this.filter)).at(-1)?.index))
      return true
    }
    if (action === 'picker-cancel' && this.filter) {
      this.setFilter('')
      return true
    }
    return this.select.handleInput(data)
  }

  render(width: number): string[] {
    const { ansi } = this.o
    const faint = (text: string) => (ansi ? ansi.italic(ansi.fg('faint', text)) : text)
    const locale = this.o.locale ?? 'en'
    const rows = this.select.render(width)
    // Nothing to list: the owner's own text with no filter, otherwise the shared "no matches" line.
    const empty = rows.length
      ? rows
      : [
          fitLine(
            faint(escapeControl(this.filter ? tt('dialog.noMatches', locale) : (this.o.emptyText ?? ''))),
            width,
          ),
        ]
    if (!this.filter) return rows.length || this.o.emptyText ? empty : rows
    const shown = `⌕ ${escapeControl(this.filter)}  ${this.matches().length}/${this.o.options.length}`
    return [fitLine(ansi ? ansi.fg('muted', shown) : shown, width), ...empty]
  }
}
