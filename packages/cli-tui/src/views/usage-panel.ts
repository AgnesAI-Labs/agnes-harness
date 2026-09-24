import type { Ansi } from '../ansi.js'
import { type Component, escapeControl, wrapText } from '../component.js'
import { Box } from '../components/box.js'
import { parseKey } from '../keys.js'

/** Read-only command report. Consumes keys until dismissed without sending a prompt. */
export class UsagePanel implements Component {
  private report: string | undefined
  private title = '会话用量'
  private offset = 0
  private total = 0
  private height = 1
  constructor(private readonly options: { ansi: Ansi; maxRows(): number; changed(): void }) {}
  show(text: string, title = '会话用量'): void {
    this.report = escapeControl(text)
    this.title = title
    this.offset = 0
    this.options.changed()
  }
  close(): void {
    this.report = undefined
    this.options.changed()
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    if (this.report === undefined) return false
    const name = parseKey(data, false).name
    if (name === 'esc' || name === 'enter' || name === 'ctrl-c' || data === 'q') this.close()
    else {
      if (name === 'up') this.offset -= 1
      if (name === 'down') this.offset += 1
      if (name === 'pgup') this.offset -= this.height
      if (name === 'pgdn') this.offset += this.height
      this.offset = Math.max(0, Math.min(this.offset, this.total - this.height))
      this.options.changed()
    }
    return true
  }
  render(width: number): string[] {
    if (this.report === undefined) return []
    const lines = wrapText(this.report, Math.max(1, width - 4))
    this.height = Math.max(1, this.options.maxRows() - 3)
    this.total = lines.length
    this.offset = Math.max(0, Math.min(this.offset, this.total - this.height))
    const body = {
      render: () => [...lines.slice(this.offset, this.offset + this.height), '↑↓ 滚动 · Esc 关闭'],
      invalidate() {},
    }
    return new Box(body, { title: this.title, rounded: true, border: this.options.ansi.dim }).render(width)
  }
}
