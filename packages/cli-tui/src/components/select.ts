import { type Component, escapeControl } from '../component.js'
import { parseKey } from '../keys.js'
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
      /** Optional viewport for long dynamic lists; selection still ranges over every option. */
      maxRows?(): number
    },
  ) {
    this.options = o.options.map((option) => ({ ...option }))
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    const key = parseKey(data, false)
    if (key.name === 'up') {
      this.idx = Math.max(0, this.idx - 1)
      return true
    }
    if (key.name === 'down') {
      this.idx = Math.max(0, Math.min(this.options.length - 1, this.idx + 1))
      return true
    }
    if (key.name === 'enter') {
      const option = this.options[this.idx]
      if (option) this.o.onChoose(option.id)
      return true
    }
    if (key.name === 'esc') {
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
    const lines = this.options.slice(start, start + count).map((option, offset) => {
      const i = start + offset
      return fitLine(`${i === this.idx ? '▶' : ' '} ${i + 1}. ${escapeControl(option.label)}`, width)
    })
    return this.o.title ? [fitLine(escapeControl(this.o.title), width), ...lines] : lines
  }
}
