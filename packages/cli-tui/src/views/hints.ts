import { createAnsi } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
import { keyHints } from '../components/key-hints.js'
import { fitLine } from '../components/line.js'
import type { ActionItem } from '../slots.js'
import { type ThemedAnsi, TuiTheme } from '../theme.js'

/** Context-only hint bar: the first four `sidebar.action` fills mapped to F1-F4. */
export class Hints implements Component {
  private actions: ActionItem[] = []

  constructor(
    private readonly ansi: ThemedAnsi = new TuiTheme('mono').ansi(createAnsi('none')),
    // A line shown above the F-key row while the conversation is scrolled up and has new output below.
    private readonly below: () => string | undefined = () => undefined,
  ) {}

  set(actions: ActionItem[]): void {
    this.actions = actions.slice(0, 4)
  }
  invalidate(): void {}
  render(width: number): string[] {
    const below = this.below()
    const note = below === undefined ? [] : [fitLine(this.ansi.fg('accent', escapeControl(below)), width)]
    if (this.actions.length === 0) return note
    const row = keyHints(
      this.actions.map((a, i) => ({ key: `F${i + 1}`, label: a.label })),
      this.ansi,
      width,
    )
    return [...note, fitLine(row, width)]
  }
}
