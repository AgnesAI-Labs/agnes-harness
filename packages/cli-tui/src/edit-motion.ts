import { displayWidth } from './terminal.js'

const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' })
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

// Offsets at which a word starts and ends. Punctuation and spaces are not words; Chinese is cut by the
// segmenter's dictionary, so "今天天气很好" moves in steps of "今天", "天气", "很好".
function words(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const s of WORDS.segment(text))
    if (s.isWordLike) out.push({ start: s.index, end: s.index + s.segment.length })
  return out
}

/** Start of the word the cursor is in or just after: where Alt-B and Ctrl-W stop. */
export function prevWordStart(text: string, cursor: number): number {
  let at = 0
  for (const w of words(text)) if (w.start < cursor) at = w.start
  return at
}

/** End of the word the cursor is in or just before: where Alt-F and Alt-D stop. */
export function nextWordEnd(text: string, cursor: number): number {
  for (const w of words(text)) if (w.end > cursor) return w.end
  return text.length
}

/** Offset where the line holding `cursor` begins. (lastIndexOf with a negative index would still look at 0.) */
export function lineStartOf(text: string, cursor: number): number {
  return cursor <= 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1
}

/** Display columns between the start of the cursor's line and the cursor. */
export function lineColumn(text: string, cursor: number): number {
  return displayWidth(text.slice(lineStartOf(text, cursor), cursor))
}

/**
 * Where the cursor lands one logical line up (-1) or down (1), at the display column `column` or as
 * near before it as the target line allows; undefined when there is no such line.
 */
export function moveLine(text: string, cursor: number, dir: -1 | 1, column: number): number | undefined {
  const here = lineStartOf(text, cursor)
  let start: number
  if (dir < 0) {
    if (here === 0) return undefined
    start = lineStartOf(text, here - 1)
  } else {
    const next = text.indexOf('\n', cursor)
    if (next < 0) return undefined
    start = next + 1
  }
  const nl = text.indexOf('\n', start)
  const end = nl < 0 ? text.length : nl
  let at = start
  let width = 0
  for (const { segment } of GRAPHEMES.segment(text.slice(start, end))) {
    const w = displayWidth(segment)
    if (width + w > column) break
    width += w
    at += segment.length
  }
  return at
}
