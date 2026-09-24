import { type Ansi, CURSOR_MARKER } from './ansi.js'
import { displayWidth } from './terminal.js'

export type TuiThemeName = 'light' | 'dark' | 'mono'

/** One restrained terminal palette: violet identifies Agnes; the other colours carry state. */
export const tuiColor = {
  muted: 245,
  success: 78,
  warning: 178,
  danger: 203,
} as const

const SURFACE = {
  light: { background: 254, foreground: 238 },
  dark: { background: 236, foreground: 255 },
} as const

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

  frame(base: Ansi, rows: string[], width: number, height: number): string[] {
    if (this.current === 'mono' || !base.reset) return rows
    const bg = base.bg(this.current === 'light' ? 255 : 234, '').replace('\x1b[49m', '')
    const fg = base.fg(this.current === 'light' ? 238 : 252, '').replace('\x1b[39m', '')
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

  ansi(base: Ansi): Ansi {
    return {
      bold: (text) => base.bold(text),
      dim: (text) =>
        this.current === 'mono' ? base.dim(text) : base.fg(this.current === 'light' ? 242 : 248, text),
      fg: (colour, text) =>
        this.current === 'mono'
          ? text
          : base.fg(
              this.current === 'light'
                ? (({ 78: 28, 178: 130, 203: 160, 141: 98 } as Record<number, number>)[colour] ?? colour)
                : colour,
              text,
            ),
      bg: (colour, text) => (this.current === 'mono' ? text : base.bg(colour, text)),
      get reset() {
        return base.reset
      },
    }
  }

  /** Paint one independent segment; composing segments avoids nested colour-reset bleed. */
  surface(ansi: Ansi, text: string): string {
    if (this.current === 'mono') return text
    const colours = SURFACE[this.current]
    return ansi.bg(colours.background, ansi.fg(colours.foreground, text))
  }

  menu(ansi: Ansi, text: string): string {
    if (this.current === 'mono') return ansi.bold(text)
    return this.current === 'light' ? ansi.bg(254, ansi.fg(238, text)) : ansi.bg(240, ansi.fg(255, text))
  }
}
