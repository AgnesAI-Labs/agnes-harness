import { ANSI_RE } from './ansi.js'

/** A hit in one pager row, as code point offsets into the row's text with its ANSI codes removed. */
export type Match = { row: number; start: number; end: number }

export const stripAnsi = (line: string): string => line.replace(ANSI_RE, '')

// Lower-cased one code point at a time, so offsets stay the same in the text and in the query. A
// character that lower-cases to several (a dotted capital I) is left as it is.
const fold = (text: string): string[] =>
  Array.from(text, (c) => {
    const lower = c.toLowerCase()
    return Array.from(lower).length === 1 ? lower : c
  })

/**
 * Every place `query` occurs in `lines`, in reading order: case-insensitive, a plain substring and
 * never a pattern, looked for in the text a row shows (ANSI codes removed). A hit never spans rows.
 */
export function findMatches(lines: readonly string[], query: string): Match[] {
  const needle = fold(query)
  if (needle.length === 0) return []
  const found: Match[] = []
  lines.forEach((line, row) => {
    const hay = fold(stripAnsi(line))
    for (let start = 0; start + needle.length <= hay.length; ) {
      if (needle.every((c, i) => hay[start + i] === c)) {
        found.push({ row, start, end: start + needle.length })
        start += needle.length
      } else start++
    }
  })
  return found
}

const ON = '\x1b[7m'
const OFF = '\x1b[27m'
const CURRENT_ON = '\x1b[7;4m'
const CURRENT_OFF = '\x1b[27;24m'

/** `line` with its hits (offsets as `findMatches` gives them) in reverse video, the current one underlined too. */
export function highlight(line: string, hits: readonly Match[], current?: Match): string {
  if (hits.length === 0) return line
  let out = ''
  let at = 0
  let lit = undefined as Match | undefined
  const set = (next: Match | undefined) => {
    if (next === lit) return
    if (lit) out += lit === current ? CURRENT_OFF : OFF
    if (next) out += next === current ? CURRENT_ON : ON
    lit = next
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape is the point
  for (const [token, code] of line.matchAll(/(\x1b\[[0-9;]*m)|[\s\S]/gu)) {
    if (code !== undefined) {
      // A colour code inside a hit may end the reverse video; say it again after the code.
      out += token
      if (lit) out += lit === current ? CURRENT_ON : ON
      continue
    }
    set(hits.find((h) => at >= h.start && at < h.end))
    out += token
    at++
  }
  set(undefined)
  return out
}
