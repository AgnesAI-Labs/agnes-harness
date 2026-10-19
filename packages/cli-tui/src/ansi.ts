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

/** An xterm-256 index, or `#rrggbb` that each tier renders as closely as it can. */
export type Colour = number | `#${string}`

export type Ansi = {
  bold(s: string): string
  dim(s: string): string
  italic(s: string): string
  underline(s: string): string
  fg(c: Colour, s: string): string
  bg(c: Colour, s: string): string
  reset: string
}

/** Admits configuration text as a colour only when it really is `#rrggbb`. */
export function hexColour(s: string): `#${string}` | undefined {
  return /^#[0-9a-f]{6}$/i.test(s) ? (s as `#${string}`) : undefined
}

const channels = (hex: `#${string}`): number[] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
const CUBE = [0, 95, 135, 175, 215, 255]
const rgb256 = (n: number): number[] =>
  n >= 232
    ? Array(3).fill(8 + 10 * (n - 232))
    : [CUBE[Math.floor((n - 16) / 36)] ?? 0, CUBE[Math.floor((n - 16) / 6) % 6] ?? 0, CUBE[(n - 16) % 6] ?? 0]

/** The colour-cube or gray-ramp index (16-255) nearest to `hex` by squared RGB distance. */
function nearest256(hex: `#${string}`): number {
  const want = channels(hex)
  let best = 16
  let bestDistance = Number.POSITIVE_INFINITY
  for (let n = 16; n < 256; n++) {
    const distance = rgb256(n).reduce((sum, v, i) => sum + (v - (want[i] ?? 0)) ** 2, 0)
    if (distance < bestDistance) [best, bestDistance] = [n, distance]
  }
  return best
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
  if (tier === 'none') {
    const same = (s: string) => s
    return {
      bold: same,
      dim: same,
      italic: same,
      underline: same,
      fg: (_c, s) => s,
      bg: (_c, s) => s,
      reset: '',
    }
  }
  const colour = (c: Colour, base: number, bright: number, s: string, off: number): string => {
    if (tier === 'truecolor' && typeof c === 'string')
      return `\x1b[${off - 1};2;${channels(c).join(';')}m${s}\x1b[${off}m`
    const n = typeof c === 'number' ? c : nearest256(c)
    if (tier === '16') {
      const i = basic16(n)
      return `\x1b[${i < 8 ? base + i : bright + i - 8}m${s}\x1b[${off}m`
    }
    return `\x1b[${off - 1};5;${n}m${s}\x1b[${off}m`
  }
  return {
    bold: (s) => `\x1b[1m${s}\x1b[22m`,
    dim: (s) => `\x1b[2m${s}\x1b[22m`,
    italic: (s) => `\x1b[3m${s}\x1b[23m`,
    underline: (s) => `\x1b[4m${s}\x1b[24m`,
    fg: (c, s) => colour(c, 30, 90, s, 39),
    bg: (c, s) => colour(c, 40, 100, s, 49),
    reset: '\x1b[0m',
  }
}
