import type { Ansi } from '../ansi.js'
import { type Component, escapeControl } from '../component.js'
import { displayWidth } from '../terminal.js'
import { columns, fitLine } from './line.js'

export class Box implements Component {
  collapsed: boolean
  constructor(
    private readonly child: Component,
    private readonly o: {
      title?: string
      collapsed?: boolean
      ansi?: Ansi
      /** Rounded corners (╭╮╰╯) instead of the default square set. */
      rounded?: boolean
      /** Style for the frame characters only (borders and the collapsed ▸), never the child body. */
      border?(s: string): string
      /** Style for the escaped title text. Styling after escapeControl keeps untrusted titles inert. */
      titleStyle?(s: string): string
    } = {},
  ) {
    this.collapsed = o.collapsed ?? false
  }
  toggle(): void {
    this.collapsed = !this.collapsed
  }
  invalidate(): void {
    this.child.invalidate()
  }
  handleInput(data: string): boolean {
    return !this.collapsed && (this.child.handleInput?.(data) ?? false)
  }
  render(width: number): string[] {
    width = columns(width)
    const border = this.o.border ?? ((s: string) => s)
    const title = this.o.title ? ` ${escapeControl(this.o.title)} ` : ''
    const styledTitle = this.o.titleStyle ? this.o.titleStyle(title) : title
    if (this.collapsed || width < 5) return [fitLine(`${border('▸')}${styledTitle}`, width)]
    const heading = displayWidth(styledTitle) <= width - 2 ? styledTitle : fitLine(styledTitle, width - 2)
    const [tl, tr, bl, br] = this.o.rounded ? ['╭', '╮', '╰', '╯'] : ['┌', '┐', '└', '┘']
    const top = border(tl) + heading + border(`${'─'.repeat(width - 2 - displayWidth(heading))}${tr}`)
    return [
      top,
      ...this.child
        .render(width - 4)
        .map((line) => `${border('│')} ${fitLine(line, width - 4)} ${border('│')}`),
      border(`${bl}${'─'.repeat(width - 2)}${br}`),
    ]
  }
}
