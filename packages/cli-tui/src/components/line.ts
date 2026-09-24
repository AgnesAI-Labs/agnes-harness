import { ANSI_RE, defang } from '../ansi.js'
import { displayWidth } from '../terminal.js'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
export function columns(width: number): number {
  if (!Number.isFinite(width)) throw new Error('invalid component width')
  return Math.max(1, Math.trunc(width))
}

/** Bounded single line; caller may supply trusted SGR, never raw untrusted labels. */
export function fitLine(text: string, width: number): string {
  width = columns(width)
  const clean = defang(text)
  if (displayWidth(clean) <= width) return clean + ' '.repeat(width - displayWidth(clean))
  let out = ''
  let used = 0
  let styled = false
  let at = 0
  let clipped = false
  const add = (part: string): boolean => {
    for (const { segment } of graphemes.segment(part)) {
      const size = displayWidth(segment)
      if (used + size > width - 1) return false
      out += segment
      used += size
    }
    return true
  }
  for (const match of clean.matchAll(ANSI_RE)) {
    if (!add(clean.slice(at, match.index))) {
      clipped = true
      break
    }
    out += match[0]
    styled = true
    at = match.index + match[0].length
  }
  // Only continue when no earlier text was clipped.
  if (!clipped) add(clean.slice(at))
  return `${out}…${styled ? '\x1b[0m' : ''}${' '.repeat(width - used - 1)}`
}
