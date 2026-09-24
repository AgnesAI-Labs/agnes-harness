import { eastAsianWidth } from 'get-east-asian-width'
import { ANSI_RE, type ColorTier, CURSOR_MARKER } from './ansi.js'

export type Capabilities = {
  color: ColorTier
  kittyKeyboard: boolean
  columns: number
  rows: number
}

export interface Terminal {
  readonly caps: Capabilities
  write(s: string): void
  enterRaw(): void
  leaveRaw(): void
  onInput(h: (data: string) => void): () => void
  onResize(h: (cols: number, rows: number) => void): () => void
  size(): { columns: number; rows: number }
}

// Everything is read from the environment the terminal itself sets. Asking the operating system
// instead would answer a different question: a Windows console under ConPTY understands the same
// sequences a Linux xterm does, and an ssh session into Linux from a dumb pipe understands none.
export function detectCapabilities(
  env: NodeJS.ProcessEnv,
  size: { columns: number; rows: number },
): Capabilities {
  let color: ColorTier = '16'
  if (env.NO_COLOR || env.TERM === 'dumb') color = 'none'
  else if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') color = 'truecolor'
  else if (/256color/.test(env.TERM ?? '')) color = '256'
  // TERM_PROGRAM is inherited by every process a terminal starts, multiplexers included, so it says
  // which emulator is at the far end and not which one will receive the sequence. tmux and screen set
  // TERM themselves; unless they are configured to pass extended keys through, the request comes back
  // as the literal text `[>1u` in the first row. Announcing it is theirs to do, not ours to guess.
  const multiplexed = /^(screen|tmux)/.test(env.TERM ?? '') || env.TMUX !== undefined
  const emulator =
    env.TERM_PROGRAM === 'kitty' || env.TERM_PROGRAM === 'WezTerm' || env.TERM_PROGRAM === 'ghostty'
  return { color, kittyKeyboard: emulator && !multiplexed, columns: size.columns, rows: size.rows }
}

// Nonspacing and enclosing marks and format characters take no cell of their own: a combining acute
// lands on the letter before it, and a zero-width joiner is not drawn at all. get-east-asian-width
// answers a property question and reports 1 for all of them, so they are filtered first.
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

// Asks for the emoji rendering of the character before it, which is drawn in two columns wherever it
// is honoured. Without this a heart or a keycap measures one column and every wrap boundary and
// cursor position later in that line is off by one.
const EMOJI_PRESENTATION = '\ufe0f'

/**
 * How many terminal columns a string occupies once written. Styling and the cursor marker are
 * stripped because neither is drawn. Control characters, tabs included, count nothing because the
 * renderer removes them rather than drawing them: a tab's width depends on the column it lands in,
 * which a component that only knows its own text cannot work out, and guessing would put the measured
 * width and the painted width out of step. Text that wants tabs must expand them to spaces first.
 *
 * Width is summed per code point, with marks and format characters at zero. A joined emoji sequence
 * therefore measures the sum of its parts rather than the single glyph some terminals compose, which
 * is deliberate: whether a terminal composes one depends on its font, and over-measuring only wraps a
 * line early, while under-measuring lets it overflow and the terminal wraps it itself -- after which
 * every row the renderer addresses is off by one.
 */
export function displayWidth(s: string): number {
  const chars = [...s.replaceAll(CURSOR_MARKER, '').replace(ANSI_RE, '')]
  let w = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const cp = ch.codePointAt(0) as number
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue
    if (ZERO_WIDTH.test(ch)) continue
    w += chars[i + 1] === EMOJI_PRESENTATION ? 2 : eastAsianWidth(cp)
  }
  return w
}

// Structural shapes rather than NodeJS.ReadStream / WriteStream, so a test can hand NodeTerminal a
// plain object and observe what it writes without casting real streams into existence.
export type InputStream = {
  setRawMode?(raw: boolean): void
  resume(): void
  pause(): void
  setEncoding(encoding: string): void
  on(event: 'data', handler: (chunk: string | Buffer) => void): void
  off(event: 'data', handler: (chunk: string | Buffer) => void): void
}

export type OutputStream = {
  columns?: number | undefined
  rows?: number | undefined
  write(s: string): void
  on(event: 'resize', handler: () => void): void
  off(event: 'resize', handler: () => void): void
}

export class FakeTerminal implements Terminal {
  readonly writes: string[] = []
  caps: Capabilities
  raw = false
  private dims: { columns: number; rows: number }
  private inputs: Array<(d: string) => void> = []
  private resizes: Array<(c: number, r: number) => void> = []

  constructor(dims: { columns: number; rows: number }, env: NodeJS.ProcessEnv = { NO_COLOR: '1' }) {
    this.dims = { ...dims }
    this.caps = detectCapabilities(env, dims)
  }

  write(s: string): void {
    this.writes.push(s)
  }
  enterRaw(): void {
    this.raw = true
  }
  leaveRaw(): void {
    this.raw = false
  }
  onInput(h: (d: string) => void): () => void {
    this.inputs.push(h)
    return () => {
      this.inputs = this.inputs.filter((x) => x !== h)
    }
  }
  onResize(h: (c: number, r: number) => void): () => void {
    this.resizes.push(h)
    return () => {
      this.resizes = this.resizes.filter((x) => x !== h)
    }
  }
  size(): { columns: number; rows: number } {
    return { ...this.dims }
  }
  feed(d: string): void {
    for (const h of [...this.inputs]) h(d)
  }
  resize(columns: number, rows: number): void {
    this.dims = { columns, rows }
    this.caps = { ...this.caps, columns, rows }
    for (const h of [...this.resizes]) h(columns, rows)
  }
}

export class NodeTerminal implements Terminal {
  readonly caps: Capabilities

  constructor(
    private readonly stdin: InputStream,
    private readonly stdout: OutputStream,
    env: NodeJS.ProcessEnv,
  ) {
    this.caps = detectCapabilities(env, { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 })
  }

  write(s: string): void {
    this.stdout.write(s)
  }

  // The progressive-enhancement request is sent only where it is understood. A terminal without the
  // kitty keyboard protocol echoes the unrecognised sequence into the prompt instead of ignoring it.
  enterRaw(): void {
    this.stdin.setRawMode?.(true)
    this.stdin.resume()
    this.stdin.setEncoding('utf8')
    if (this.caps.kittyKeyboard) this.stdout.write('\x1b[>1u')
  }

  leaveRaw(): void {
    if (this.caps.kittyKeyboard) this.stdout.write('\x1b[<u')
    this.stdin.setRawMode?.(false)
    this.stdin.pause()
  }

  onInput(h: (d: string) => void): () => void {
    const f = (d: string | Buffer): void => h(String(d))
    this.stdin.on('data', f)
    return () => this.stdin.off('data', f)
  }

  onResize(h: (c: number, r: number) => void): () => void {
    const f = (): void => h(this.stdout.columns ?? 80, this.stdout.rows ?? 24)
    this.stdout.on('resize', f)
    return () => this.stdout.off('resize', f)
  }

  size(): { columns: number; rows: number } {
    return { columns: this.stdout.columns ?? 80, rows: this.stdout.rows ?? 24 }
  }
}
