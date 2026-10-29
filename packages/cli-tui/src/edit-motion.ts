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

// Offsets in the text at which a character begins. Moving and deleting by these rather than by code
// unit keeps a combining mark with the letter it sits on and treats a surrogate pair as one keypress.
export function boundaries(text: string): number[] {
  const out = [0]
  for (const s of GRAPHEMES.segment(text)) out.push(s.index + s.segment.length)
  return out
}

/** Start of the character before `cursor` (0 when there is none). */
export function prevBoundaryOf(text: string, cursor: number): number {
  let prev = 0
  for (const x of boundaries(text)) if (x < cursor) prev = x
  return prev
}

/** Start of the character after the one at `cursor` (the text's length when there is none). */
export function nextBoundaryOf(text: string, cursor: number): number {
  for (const x of boundaries(text)) if (x > cursor) return x
  return text.length
}

/** Start of the next word after `cursor`; the text's length when there is none. */
export function nextWordStart(text: string, cursor: number): number {
  for (const w of words(text)) if (w.start > cursor) return w.start
  return text.length
}

/** The last character of the word the cursor is in, or of the next one when it already stands on a word's last character. */
export function wordLastChar(text: string, cursor: number): number {
  for (const w of words(text)) {
    const last = prevBoundaryOf(text, w.end)
    if (last > cursor) return last
  }
  return prevBoundaryOf(text, text.length)
}

/** The word the cursor stands in, if it does: where `cw` stops. */
export function wordEndAt(text: string, cursor: number): number | undefined {
  return words(text).find((w) => w.start <= cursor && cursor < w.end)?.end
}

/** Offset where the line holding `cursor` ends (at its newline, or the text's end). */
export function lineEndOf(text: string, cursor: number): number {
  const next = text.indexOf('\n', cursor)
  return next < 0 ? text.length : next
}
