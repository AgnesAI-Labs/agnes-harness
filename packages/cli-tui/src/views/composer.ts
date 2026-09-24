import type { Ansi } from '../ansi.js'
import { type Component, padLine } from '../component.js'
import { fitLine } from '../components/line.js'
import { displayWidth } from '../terminal.js'

/** Full-width, one-row composer with model state integrated into its lower edge. */
export class Composer implements Component {
  private meta = ''

  constructor(
    private readonly editor: Component,
    private readonly ansi: Ansi,
  ) {}

  setMeta(text?: string): void {
    this.meta = text ?? ''
  }

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    if (width < 8) return this.editor.render(width)
    const frameWidth = width - 1
    const inner = frameWidth - 4
    const lead = ' '
    const side = this.ansi.dim('│')
    const availableMeta = Math.max(0, frameWidth - 4)
    const label = availableMeta >= 8 ? fitLine(this.meta, availableMeta - 2).trimEnd() : ''
    const meta = label ? ` ${label} ` : ''
    const rule = Math.max(0, frameWidth - 2 - displayWidth(meta))
    return [
      `${lead}${this.ansi.dim(`╭${'─'.repeat(frameWidth - 2)}╮`)}`,
      ...this.editor.render(inner).map((line) => `${lead}${side} ${padLine(line, inner)} ${side}`),
      `${lead}${this.ansi.dim(`╰${'─'.repeat(rule)}${meta}╯`)}`,
    ]
  }

  handleInput(data: string): boolean {
    return this.editor.handleInput?.(data) ?? false
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
