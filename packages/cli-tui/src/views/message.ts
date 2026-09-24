import type { Ansi } from '../ansi.js'
import { type Component, escapeControl, padLine, wrapText } from '../component.js'
import type { TuiTheme } from '../theme.js'

/** A Grok-like turn separator: quiet full-width surface, with only the role marker in brand colour. */
export class UserMessage implements Component {
  private readonly text: string

  constructor(
    text: string,
    private readonly ansi: Ansi,
    private readonly theme: TuiTheme,
    private readonly accent = 141,
  ) {
    this.text = escapeControl(text)
  }

  invalidate(): void {}

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    if (width < 3) return wrapText(this.text, width)
    const inset = width >= 8 ? 1 : 0
    const inner = Math.max(1, width - inset * 2)
    const marker = this.ansi.bold(this.ansi.fg(this.accent, '›'))
    return wrapText(this.text, Math.max(1, inner - 4)).map((line, index) => {
      const prefix = index === 0 ? `  ${marker} ` : '    '
      const body = padLine(line, Math.max(1, inner - 4))
      return `${' '.repeat(inset)}${this.theme.surface(this.ansi, prefix)}${this.theme.surface(
        this.ansi,
        body,
      )}${this.theme.surface(this.ansi, ' '.repeat(inset))}`
    })
  }

  /** Shell history stays compact and free of fullscreen surface padding. */
  transcript(width: number): string[] {
    return wrapText(`you: ${this.text}`, Math.max(1, width))
  }
}
