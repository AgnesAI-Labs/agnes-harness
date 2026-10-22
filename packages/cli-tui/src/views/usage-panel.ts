import { type Component, escapeControl, wrapText } from '../component.js'
import { Box } from '../components/box.js'
import { actionFor } from '../keymap.js'
import { parseKey } from '../keys.js'
import { tt } from '../locale-extended.js'
import type { ThemedAnsi } from '../theme.js'

/** Read-only command report. Consumes keys until dismissed without sending a prompt. */
export class UsagePanel implements Component {
  private report: string | undefined
  private title = ''
  private offset = 0
  private total = 0
  private height = 1
  /** Bumped by every show and close, so a late result can tell the panel it asked for is gone. */
  version = 0
  constructor(
    private readonly options: { ansi: ThemedAnsi; locale?: string; maxRows(): number; changed(): void },
  ) {}
  show(text: string, title?: string): void {
    this.title = title ?? tt('usagePanel.title', this.options.locale ?? 'en')
    this.report = escapeControl(text)
    this.offset = 0
    this.version++
    this.options.changed()
  }
  get open(): boolean {
    return this.report !== undefined
  }
  close(): void {
    this.report = undefined
    this.version++
    this.options.changed()
  }
  invalidate(): void {}
  handleInput(data: string): boolean {
    if (this.report === undefined) return false
    const action = actionFor('panel', parseKey(data, false).name)
    if (action === 'panel-close' || data === 'q') this.close()
    else {
      if (action === 'panel-up') this.offset -= 1
      if (action === 'panel-down') this.offset += 1
      if (action === 'panel-page-up') this.offset -= this.height
      if (action === 'panel-page-down') this.offset += this.height
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
      render: () => [
        ...lines.slice(this.offset, this.offset + this.height),
        this.options.ansi.fg('faint', tt('usagePanel.scrollHint', this.options.locale ?? 'en')),
      ],
      invalidate() {},
    }
    return new Box(body, { title: this.title, ansi: this.options.ansi }).render(width)
  }
}
