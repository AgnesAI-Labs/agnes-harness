import { DEFAULT_BRANDING } from '@agnes/sdk'
import { type Ansi, type Colour, CURSOR_MARKER, hexColour } from './ansi.js'
import { BRAND_RAMP, PALETTE, type Tone } from './palette.js'
import { displayWidth } from './terminal.js'

const QUIET: ReadonlySet<Tone | Colour> = new Set<Tone>(['muted', 'faint', 'border', 'thinking'])

/** The stock accent follows the theme's own accent; only a deliberate white-label hex is kept as given. */
export function brandColour(accent: string): Tone | Colour {
  return accent === DEFAULT_BRANDING.accent ? 'accent' : (hexColour(accent) ?? 'accent')
}

/** False in mono and on the none tier, where state has to be carried by glyph and weight instead. */
export const paintsColour = (ansi: ThemedAnsi): boolean => ansi.fg('accent', 'x') !== 'x'

/** Linear RGB blend along evenly spaced stops; `t` is clamped to 0..1. Non-hex stops give no answer. */
export function blendColours(stops: readonly (Colour | undefined)[], t: number): Colour | undefined {
  const hex = stops.map((c) => (typeof c === 'string' ? hexColour(c) : undefined))
  const rgb = hex.map((c) => (c ? [1, 3, 5].map((k) => Number.parseInt(c.slice(k, k + 2), 16)) : undefined))
  const first = rgb[0]
  if (first === undefined || rgb.some((c) => c === undefined)) return undefined
  if (rgb.length === 1) return hex[0]
  const span = rgb.length - 1
  const at = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * span
  const i = Math.min(span - 1, Math.floor(at))
  const a = rgb[i] ?? first
  const b = rgb[i + 1] ?? first
  const mixed = a.map((v, k) => Math.round(v + ((b[k] ?? v) - v) * (at - i)))
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

export type TuiThemeName = 'light' | 'dark' | 'mono'

/**
 * The styling components receive: colours are named by `Tone` and resolved against the current
 * theme, or given as a `Colour` that arrives as data (a brand accent). Function-typed members keep a
 * raw `Ansi`, which cannot resolve a tone, from being passed where this is expected.
 */
export type ThemedAnsi = Omit<Ansi, 'fg' | 'bg'> & {
  fg: (c: Tone | Colour, s: string) => string
  bg: (c: Tone | Colour, s: string) => string
  /** True while `/raw` is on: views leave out the bars, rails and shading that a terminal copy would carry along. */
  readonly raw?: boolean
  /** Bumps whenever the theme changes in place, so a view that remembers its painted rows knows to repaint. */
  readonly revision?: number
}

/** Mutable session theme. Components keep one façade, so switching takes effect on the next frame. */
export class TuiTheme {
  private current: TuiThemeName
  private tones: Partial<Record<Tone, string>> | undefined
  private revision = 0
  /** The copy-friendly view (`/raw`); every `ansi()` façade reads it as it draws. */
  raw = false

  constructor(name: TuiThemeName = 'dark', tones?: Partial<Record<Tone, string>>) {
    this.current = name
    this.tones = tones
  }

  get name(): TuiThemeName {
    return this.current
  }

  /** `tones` are a custom theme's replacements for the palette's own; mono has no colours to replace. */
  set(name: TuiThemeName, tones?: Partial<Record<Tone, string>>): void {
    this.current = name
    this.tones = tones
    this.revision++
  }

  /** What `tone` looks like in the current theme; mono has no colours. */
  colour(tone: Tone): Colour | undefined {
    if (this.current === 'mono') return undefined
    return (this.tones?.[tone] as Colour | undefined) ?? PALETTE[this.current][tone]
  }

  /** The brand gradient, darkest first; mono has none. */
  ramp(): readonly Colour[] {
    return this.current === 'mono' ? [] : BRAND_RAMP[this.current]
  }

  /** The brand gradient sampled at `t` (0..1); mono has none. */
  rampAt(t: number): Colour | undefined {
    return blendColours(this.ramp(), t)
  }

  /** A gradient through existing tones sampled at `t` (0..1); mono has none. */
  toneAt(tones: readonly Tone[], t: number): Colour | undefined {
    return blendColours(
      tones.map((tone) => this.colour(tone)),
      t,
    )
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
    const theme = this
    const resolve = (c: Tone | Colour): Colour | undefined =>
      typeof c === 'number' || c.startsWith('#') ? (c as Colour) : this.colour(c as Tone)
    const paint = (layer: 'fg' | 'bg', c: Tone | Colour, text: string): string => {
      // Mono has no hues, but quiet text still has to read as quieter than the content around it.
      if (this.current === 'mono') return text && layer === 'fg' && QUIET.has(c) ? base.dim(text) : text
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
      get raw() {
        return theme.raw
      },
      get revision() {
        return theme.revision
      },
    }
  }

  /** Paint one independent segment; composing segments avoids nested colour-reset bleed. */
  surface(ansi: ThemedAnsi, text: string): string {
    if (this.current === 'mono') return text
    return ansi.bg('surface', ansi.fg('surfaceFg', text))
  }
}
