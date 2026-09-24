import { CURSOR_MARKER } from './ansi.js'
import { displayWidth } from './terminal.js'

export { CURSOR_MARKER }

// A component turns an available width into the exact lines it wants on screen. handleInput returns
// true when it consumed the data, so a container can stop at the first child that took it; a
// container with no answer would have to broadcast every keystroke to every child.
export interface Component {
  render(width: number): string[]
  /** Optional plain shell-history form when the fullscreen TUI exits. */
  transcript?(width: number): string[]
  handleInput?(data: string): boolean
  invalidate(): void
}

// Lines are returned at their natural length and the renderer erases the rest of the row, so nothing
// pads. Padding here would put trailing spaces inside styled runs and would make a line's own width
// unrecoverable to whatever composes it.
export function padLine(line: string, width: number): string {
  const w = displayWidth(line)
  return w >= width ? line : line + ' '.repeat(width - w)
}

// Word wrapping by display width. A word longer than the line is broken by character rather than
// allowed to overflow, because an overflowing line makes the terminal wrap on its own and every row
// below it is then off by one from what the renderer believes it wrote.
export function wrapText(text: string, width: number): string[] {
  const limit = Math.max(1, width)
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word
      if (displayWidth(candidate) <= limit) {
        line = candidate
        continue
      }
      if (line) {
        out.push(line)
        line = ''
      }
      let chunk = ''
      for (const ch of word) {
        if (chunk !== '' && displayWidth(chunk + ch) > limit) {
          out.push(chunk)
          chunk = ''
        }
        chunk += ch
      }
      line = chunk
    }
    out.push(line)
  }
  return out
}

// C0 and C1 bytes in text that came from a model or a tool. ESC is included: a run of untrusted text
// must not be able to set colours, move the cursor or switch character sets. Trusted chrome applies
// styling after this, never before.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g

export function escapeControl(s: string): string {
  return s.replace(CONTROL, (c) => (c === '\n' ? c : ''))
}

export class Text implements Component {
  private cache: { width: number; lines: string[] } | null = null

  constructor(
    private text: string,
    private readonly opts: { wrap?: boolean; style?: (s: string) => string } = {},
  ) {}

  set(text: string): void {
    this.text = text
    this.invalidate()
  }

  invalidate(): void {
    this.cache = null
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines
    const raw = this.opts.wrap === false ? this.text.split('\n') : wrapText(this.text, width)
    const lines = this.opts.style ? raw.map(this.opts.style) : raw
    this.cache = { width, lines }
    return lines
  }
}

export class Spacer implements Component {
  constructor(private readonly n = 1) {}
  render(_width: number): string[] {
    return Array.from({ length: this.n }, () => '')
  }
  invalidate(): void {}
}

/** A full-width visual plane with quiet internal padding; input still belongs to its child. */
export class Rule implements Component {
  constructor(
    private readonly label?: string,
    private readonly style?: (s: string) => string,
  ) {}
  render(width: number): string[] {
    const head = this.label ? `── ${this.label} ` : ''
    const headWidth = displayWidth(head)
    const line = headWidth >= width ? head : head + '─'.repeat(width - headWidth)
    return [this.style ? this.style(line) : line]
  }
  invalidate(): void {}
}

export class VStack implements Component {
  readonly children: Component[]

  constructor(children: Component[] = []) {
    this.children = [...children]
  }

  add(c: Component): void {
    this.children.push(c)
  }
  remove(c: Component): void {
    const i = this.children.indexOf(c)
    if (i >= 0) this.children.splice(i, 1)
  }
  clear(): void {
    this.children.length = 0
  }
  invalidate(): void {
    for (const c of this.children) c.invalidate()
  }
  render(width: number): string[] {
    return this.children.flatMap((c) => c.render(width))
  }
  handleInput(data: string): boolean {
    for (const c of this.children) if (c.handleInput?.(data)) return true
    return false
  }
}
