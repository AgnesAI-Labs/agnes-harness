import { createAnsi } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import type { ActionItem } from '../slots.js'
import { type ThemedAnsi, TuiTheme } from '../theme.js'

/** Context-only hint bar: the first four `sidebar.action` fills mapped to F1-F4. */
export class Hints implements Component {
  private actions: ActionItem[] = []

  constructor(private readonly ansi: ThemedAnsi = new TuiTheme('mono').ansi(createAnsi('none'))) {}

  set(actions: ActionItem[]): void {
    this.actions = actions.slice(0, 4)
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (this.actions.length === 0) return []
    const pairs = this.actions.map(
      (a, i) =>
        `${this.ansi.bold(this.ansi.fg('accent', `F${i + 1}`))} ${this.ansi.fg('faint', escapeControl(a.label))}`,
    )
    return [fitLine(pairs.join('  '), width)]
  }
}
