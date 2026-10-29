import type { TuiThemeName } from './theme.js'

export type Background = 'light' | 'dark'

/** OSC 11 asks the terminal for its background colour; the reply is `OSC 11 ; rgb:RRRR/GGGG/BBBB BEL|ST`. */
export const BACKGROUND_QUERY = '\x1b]11;?\x07'
export const BACKGROUND_TIMEOUT_MS = 100

const REPLY_START = '\x1b]11;'
// Longer than any real reply; a held fragment that grows past it is junk and is dropped.
const MAX_HELD = 64

/** Background from `rgb:` (1 to 4 hex digits a channel) by relative luminance, or undefined when unreadable. */
export function parseBackground(body: string): Background | undefined {
  const m = /^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i.exec(body.trim())
  if (!m) return undefined
  const [r, g, b] = [m[1], m[2], m[3]].map(
    (h) => Number.parseInt(h as string, 16) / (16 ** (h as string).length - 1),
  )
  const luminance = 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number)
  return luminance > 0.5 ? 'light' : 'dark'
}

/** `COLORFGBG` is `fg;bg` (sometimes `fg;default;bg`): the last field 7 or 15 is a light background. */
export function backgroundFromEnv(env: NodeJS.ProcessEnv): Background | undefined {
  const last = env.COLORFGBG?.split(';').pop()
  if (last === undefined || !/^\d+$/.test(last)) return undefined
  return last === '7' || last === '15' ? 'light' : 'dark'
}

/** Where a reply ends: BEL, or ST (ESC backslash), whichever comes first. */
function replyEnd(tail: string): { at: number; length: number } | undefined {
  const bel = tail.indexOf('\x07')
  const st = tail.indexOf('\x1b\\')
  if (bel >= 0 && (st < 0 || bel < st)) return { at: bel, length: 1 }
  return st >= 0 ? { at: st, length: 2 } : undefined
}

/**
 * Takes OSC 11 replies out of terminal input, however late they arrive or however they are mixed with
 * typing, so a reply can never be read as keys. A reply cut across two chunks is held until it ends.
 */
export class BackgroundReplyFilter {
  private held = ''

  constructor(private readonly onReply: (background: Background | undefined) => void) {}

  push(data: string): string {
    let rest = this.held + data
    this.held = ''
    let out = ''
    for (;;) {
      const at = rest.indexOf(REPLY_START)
      if (at < 0) break
      const tail = rest.slice(at + REPLY_START.length)
      const end = replyEnd(tail)
      if (!end) {
        out += rest.slice(0, at)
        if (tail.length < MAX_HELD) this.held = rest.slice(at)
        return out
      }
      out += rest.slice(0, at)
      this.onReply(parseBackground(tail.slice(0, end.at)))
      rest = tail.slice(end.at + end.length)
    }
    // A chunk may end partway through the introducer. A lone ESC stays a key (Esc must not wait).
    for (let n = Math.min(REPLY_START.length - 1, rest.length); n >= 2; n--) {
      if (REPLY_START.startsWith(rest.slice(rest.length - n))) {
        this.held = rest.slice(rest.length - n)
        rest = rest.slice(0, rest.length - n)
        break
      }
    }
    return out + rest
  }
}

/** The theme an `auto` preference stands for, given what the terminal is known to look like. */
export function resolveAuto(background: Background | undefined): TuiThemeName {
  return background ?? 'dark'
}
