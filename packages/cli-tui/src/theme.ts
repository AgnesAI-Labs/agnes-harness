import { type Ansi, type Colour, CURSOR_MARKER } from './ansi.js'
import { PALETTE, type Tone } from './palette.js'
import { displayWidth } from './terminal.js'

export type TuiThemeName = 'light' | 'dark' | 'mono'

/**
 * The styling components receive: colours are named by `Tone` and resolved against the current
 * theme, or given as a `Colour` that arrives as data (a brand accent). Function-typed members keep a
 * raw `Ansi`, which cannot resolve a tone, from being passed where this is expected.
 */
export type ThemedAnsi = Omit<Ansi, 'fg' | 'bg'> & {
  fg: (c: Tone | Colour, s: string) => string
  bg: (c: Tone | Colour, s: string) => string
}

/** Mutable session theme. Components keep one façade, so switching takes effect on the next frame. */
export class TuiTheme {
  private current: TuiThemeName

  constructor(name: TuiThemeName = 'light') {
    this.current = name
  }

  get name(): TuiThemeName {
    return this.current
  }

  set(name: TuiThemeName): void {
    this.current = name
  }

  /** What `tone` looks like in the current theme; mono has no colours. */
  colour(tone: Tone): Colour | undefined {
    return this.current === 'mono' ? undefined : PALETTE[this.current][tone]
  }

  frame(base: Ansi, rows: string[], width: number, height: number): string[] {
    const bgColour = this.colour('bg')
    const fgColour = this.colour('fg')
    if (bgColour === undefined || fgColour === undefined || !base.reset) return rows
    const bg = base.bg(bgColour, '').replace('\x1b[49m', '')
    const fg = base.fg(fgColour, '').replace('\x1b[39m', '')
    return Array.from({ length: Math.max(height, rows.length) }, (_, i) => {
      const raw = rows[i] ?? ''
      const padded = raw + ' '.repeat(Math.max(0, width - displayWidth(raw.replaceAll(CURSOR_MARKER, ''))))
      const line = padded
        .replaceAll('\x1b[0m', `${base.reset}${bg}${fg}`)
        .replaceAll('\x1b[39m', fg)
        .replaceAll('\x1b[49m', bg)
      return `${bg}${fg}${line}${base.reset}`
    })
  }

  ansi(base: Ansi): ThemedAnsi {
    const resolve = (c: Tone | Colour): Colour | undefined =>
      typeof c === 'number' || c.startsWith('#') ? (c as Colour) : this.colour(c as Tone)
    const paint = (layer: 'fg' | 'bg', c: Tone | Colour, text: string): string => {
      if (this.current === 'mono') return text
      const colour = resolve(c)
      return colour === undefined ? text : base[layer](colour, text)
    }
    return {
      bold: (text) => base.bold(text),
      dim: (text) => (this.current === 'mono' ? base.dim(text) : paint('fg', 'muted', text)),
      italic: (text) => base.italic(text),
      underline: (text) => base.underline(text),
      fg: (c, text) => paint('fg', c, text),
      bg: (c, text) => paint('bg', c, text),
      get reset() {
        return base.reset
      },
    }
  }

  /** Paint one independent segment; composing segments avoids nested colour-reset bleed. */
  surface(ansi: ThemedAnsi, text: string): string {
    if (this.current === 'mono') return text
    return ansi.bg('surface', ansi.fg('surfaceFg', text))
  }

  menu(ansi: ThemedAnsi, text: string): string {
    if (this.current === 'mono') return ansi.bold(text)
    return ansi.bg('selection', ansi.fg('fg', text))
  }
}
