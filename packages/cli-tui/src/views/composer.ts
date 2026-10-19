import { type Component, padLine } from '../component.js'
import { fitLine } from '../components/line.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'

/** Full-width, one-row composer with model state integrated into its lower edge. */
export class Composer implements Component {
  private meta = ''

  constructor(
    private readonly editor: Component,
    private readonly ansi: ThemedAnsi,
  ) {}

  /** `model · thinking`; the part before the first ` · ` is the model and reads a step louder. */
  setMeta(text?: string): void {
    this.meta = text ?? ''
  }

  render(width: number): string[] {
    width = Math.max(1, Math.trunc(width))
    if (width < 8) return this.editor.render(width)
    const frameWidth = width - 1
    const inner = frameWidth - 4
    const lead = ' '
    const edge = (s: string) => this.ansi.fg('borderStrong', s)
    const side = edge('│')
    const availableMeta = Math.max(0, frameWidth - 4)
    const label = availableMeta >= 8 ? fitLine(this.meta, availableMeta - 2).trimEnd() : ''
    const split = label.indexOf(' · ')
    const [model, rest] = split < 0 ? [label, ''] : [label.slice(0, split), label.slice(split)]
    const meta = label ? ` ${this.ansi.fg('muted', model)}${rest && this.ansi.fg('faint', rest)} ` : ''
    const rule = Math.max(0, frameWidth - 2 - displayWidth(meta))
    return [
      `${lead}${edge(`╭${'─'.repeat(frameWidth - 2)}╮`)}`,
      ...this.editor.render(inner).map((line) => `${lead}${side} ${padLine(line, inner)} ${side}`),
      `${lead}${edge(`╰${'─'.repeat(rule)}`)}${meta}${edge('╯')}`,
    ]
  }

  handleInput(data: string): boolean {
    return this.editor.handleInput?.(data) ?? false
  }

  invalidate(): void {
    this.editor.invalidate()
  }
}
