import { type Component, escapeControl } from '../component.js'
import { displayWidth } from '../terminal.js'
import type { ThemedAnsi } from '../theme.js'
import { type KeyHint, keyHints } from './key-hints.js'
import { columns, fitLine } from './line.js'

export class Box implements Component {
  collapsed: boolean
  constructor(
    private readonly child: Component,
    private readonly o: {
      title?: string
      collapsed?: boolean
      /** Frame in the border tone and a bold title, unless `border`/`titleStyle` override them. */
      ansi?: ThemedAnsi
      /** Rounded corners (╭╮╰╯) by default; false draws the square set. */
      rounded?: boolean
      /** Style for the frame characters only (borders and the collapsed ▸), never the child body. */
      border?(s: string): string
      /** Style for the escaped title text. Styling after escapeControl keeps untrusted titles inert. */
      titleStyle?(s: string): string
      /** Sits in the bottom border like the title in the top one; gets the columns it may use and returns styled text. */
      footer?(room: number): string
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
    const ansi = this.o.ansi
    const border = this.o.border ?? ((s: string) => (ansi ? ansi.fg('border', s) : s))
    const titleStyle = this.o.titleStyle ?? ((s: string) => (ansi ? ansi.bold(s) : s))
    const title = this.o.title ? ` ${escapeControl(this.o.title)} ` : ''
    const styledTitle = title ? titleStyle(title) : ''
    if (this.collapsed || width < 5) return [fitLine(`${border('▸')}${styledTitle}`, width)]
    // `╭─ Title ─╮`: the lead rule is dropped first when a long title needs the column.
    const lead = title && displayWidth(title) <= width - 4 ? 1 : 0
    const room = width - 2 - lead
    const heading = displayWidth(styledTitle) <= room ? styledTitle : fitLine(styledTitle, room)
    const [tl, tr, bl, br] = this.o.rounded === false ? ['┌', '┐', '└', '┘'] : ['╭', '╮', '╰', '╯']
    const top =
      border(tl) +
      (lead ? border('─') : '') +
      heading +
      border(`${'─'.repeat(room - displayWidth(heading))}${tr}`)
    const foot = this.o.footer?.(Math.max(0, width - 6)) ?? ''
    const footText = foot ? ` ${foot} ` : ''
    const footRoom = width - 2 - (footText ? 1 : 0)
    const footing = displayWidth(footText) <= footRoom ? footText : fitLine(footText, footRoom)
    const bottom = footing
      ? border(bl) + border('─') + footing + border(`${'─'.repeat(footRoom - displayWidth(footing))}${br}`)
      : border(`${bl}${'─'.repeat(width - 2)}${br}`)
    return [
      top,
      ...this.child
        .render(width - 4)
        .map((line) => `${border('│')} ${fitLine(line, width - 4)} ${border('│')}`),
      bottom,
    ]
  }
}

/**
 * The frame every picker and panel wears: rounded, borderStrong, the title only in the top border and the
 * key hints (move, confirm, others, close) in the bottom one.
 */
export function dialogBox(
  child: Component,
  o: { title?: string; ansi: ThemedAnsi; hints: readonly KeyHint[] },
): Box {
  const { ansi } = o
  return new Box(child, {
    ...(o.title === undefined ? {} : { title: o.title }),
    ansi,
    border: (s) => ansi.fg('borderStrong', s),
    footer: (room) => keyHints(o.hints, ansi, room),
  })
}
