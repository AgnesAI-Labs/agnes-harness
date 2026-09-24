// Style tokens and the two control-sequence constants the renderer needs. Everything here is a pure
// string function so that a component can be rendered and asserted on without a terminal.

export type ColorTier = 'none' | '16' | '256' | 'truecolor'

// Placed in a rendered line to say where the hardware cursor belongs. The renderer removes every
// occurrence before writing the frame, so it never reaches the terminal and never occupies a column.
// A NUL-delimited word rather than a bare NUL: a lone NUL arriving inside model output would
// otherwise be indistinguishable from a deliberate cursor placement.
export const CURSOR_MARKER = '\x00CUR\x00'

// Select Graphic Rendition only -- the sequences the tokens below emit. These change colour and
// weight and draw nothing, so they cost no columns. Every other escape sequence moves the cursor,
// erases, or switches modes, and none of those is allowed to survive as a sequence at all.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
export const ANSI_RE = /\x1b\[[0-9;]*m/g

// Keeps SGR intact and removes every other control byte, the bare escape included. What follows a
// removed escape stays as ordinary text -- `\x1b[2J` becomes the three printable columns `[2J` -- so
// what a component measured is what the terminal paints. Deleting the whole sequence instead would
// make the measured width and the painted width disagree in the other direction.
//
// This is the only place the guarantee can be made. A component cannot know whether its text came
// from a model, and a line that reaches the terminal with a live erase sequence in it does not merely
// look wrong: the renderer's record of the frame no longer matches the screen, so the differential
// pass finds nothing to repair and the damage outlives the frame that caused it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const DEFANG = /(\x1b\[[0-9;]*m)|[\x00-\x1f\x7f-\x9f]/g

export function defang(line: string): string {
  return line.replace(DEFANG, (_m, sgr: string | undefined) => sgr ?? '')
}

export type Ansi = {
  bold(s: string): string
  dim(s: string): string
  fg(n: number, s: string): string
  bg(n: number, s: string): string
  reset: string
}

/** Maps a CSS-style RGB brand accent to its nearest xterm-256 cube colour. */
export function xterm256(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match?.[1]) return 7
  const rgb = [0, 2, 4].map((offset) => Number.parseInt(match[1]?.slice(offset, offset + 2) ?? '0', 16))
  const levels = [0, 95, 135, 175, 215, 255]
  const nearest = (value: number): number => {
    let best = 0
    for (let i = 1; i < levels.length; i++)
      if (Math.abs(value - (levels[i] ?? 0)) < Math.abs(value - (levels[best] ?? 0))) best = i
    return best
  }
  return 16 + 36 * nearest(rgb[0] ?? 0) + 6 * nearest(rgb[1] ?? 0) + nearest(rgb[2] ?? 0)
}

// Reduce a 256-colour index to one of the 16 basic colours. A terminal that only understands the
// basic set renders `38;5;n` as literal garbage rather than ignoring it, so a 16-colour tier has to
// translate rather than pass the index through.
export function basic16(n: number): number {
  if (n < 16) return n
  if (n >= 232) return n < 238 ? 0 : n < 244 ? 8 : n < 250 ? 7 : 15
  const c = n - 16
  const r = Math.floor(c / 36)
  const g = Math.floor((c % 36) / 6)
  const b = c % 6
  const idx = (r >= 3 ? 1 : 0) | (g >= 3 ? 2 : 0) | (b >= 3 ? 4 : 0)
  return Math.max(r, g, b) >= 5 ? idx + 8 : idx
}

export function createAnsi(tier: ColorTier): Ansi {
  if (tier === 'none') return { bold: (s) => s, dim: (s) => s, fg: (_n, s) => s, bg: (_n, s) => s, reset: '' }
  const colour = (n: number, base: number, bright: number, s: string, off: number): string => {
    if (tier === '16') {
      const i = basic16(n)
      return `\x1b[${i < 8 ? base + i : bright + i - 8}m${s}\x1b[${off}m`
    }
    return `\x1b[${off - 1};5;${n}m${s}\x1b[${off}m`
  }
  return {
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
    dim: (s) => `\x1b[2m${s}\x1b[22m`,
    fg: (n, s) => colour(n, 30, 90, s, 39),
    bg: (n, s) => colour(n, 40, 100, s, 49),
    reset: '\x1b[0m',
  }
}
