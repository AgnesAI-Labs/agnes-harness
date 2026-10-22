import { type Component, escapeControl } from '../component.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import type { ThemedAnsi } from '../theme.js'
import { fitLine } from './line.js'
export class Select implements Component {
  private idx = 0
  private readonly options: Array<{ id: string; label: string }>
  constructor(
    private readonly o: {
      options: Array<{ id: string; label: string }>
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
  render(width: number): string[] {
    const count = Math.max(1, Math.floor(this.o.maxRows?.() ?? this.options.length))
    const start = Math.max(0, Math.min(this.idx - count + 1, this.options.length - count))
    const ansi = this.o.ansi
    const lines = this.options.slice(start, start + count).map((option, offset) => {
      const i = start + offset
      const line = fitLine(`${i === this.idx ? '❯' : ' '} ${i + 1}. ${escapeControl(option.label)}`, width)
      // Painted after fitting so the selection background spans the whole row.
      return i === this.idx && ansi ? ansi.bg('selection', ansi.bold(ansi.fg('accent', line))) : line
    })
    if (!this.o.title) return lines
    const title = fitLine(escapeControl(this.o.title), width)
    return [ansi ? ansi.bold(title) : title, ...lines]
  }
}
