import { type Component, escapeControl } from '../component.js'
import { fitLine } from './line.js'
export class List implements Component {
  private items: string[]
  constructor(items: string[]) {
    this.items = [...items]
  }
  set(items: string[]): void {
    this.items = [...items]
  }
  invalidate(): void {}
  render(width: number): string[] {
    return this.items.map((item) => fitLine(escapeControl(item), width))
  }
}
