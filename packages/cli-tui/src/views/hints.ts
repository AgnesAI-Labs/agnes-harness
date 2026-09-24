import { type Component, escapeControl } from '../component.js'
import { fitLine } from '../components/line.js'
import type { ActionItem } from '../slots.js'

/** Context-only hint bar: the first four `sidebar.action` fills mapped to F1-F4. */
export class Hints implements Component {
  private actions: ActionItem[] = []

  set(actions: ActionItem[]): void {
    this.actions = actions.slice(0, 4)
  }
  invalidate(): void {}
  render(width: number): string[] {
    if (this.actions.length === 0) return []
    return [fitLine(this.actions.map((a, i) => `F${i + 1} ${escapeControl(a.label)}`).join('  '), width)]
  }
}
