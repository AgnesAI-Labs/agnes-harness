import type { Colour } from '../ansi.js'
import { type Component, escapeControl, padLine, wrapText } from '../component.js'
import type { Tone } from '../palette.js'
import type { ThemedAnsi, TuiTheme } from '../theme.js'

/** A quiet full-width surface whose brand-colour left edge runs down every wrapped row. */
export class UserMessage implements Component {
  private readonly text: string

  constructor(
    text: string,
    private readonly ansi: ThemedAnsi,
    private readonly theme: TuiTheme,
    private readonly accent: Tone | Colour = 'accent',
  ) {
    this.text = escapeControl(text)
  }

  invalidate(): void {}

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    // Raw view: the words alone, with no bar and no padding to come along in a copy.
    if (width < 3 || this.ansi.raw) return wrapText(this.text, width)
    const inset = width >= 8 ? 1 : 0
    const inner = Math.max(1, width - inset * 2)
    const prefix = `${this.ansi.bold(this.ansi.fg(this.accent, '▍'))} `
    return wrapText(this.text, Math.max(1, inner - 2)).map((line) => {
      const body = padLine(line, Math.max(1, inner - 2))
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
