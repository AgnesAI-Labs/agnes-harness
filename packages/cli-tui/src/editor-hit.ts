import { CURSOR_MARKER } from './component.js'
import { displayWidth } from './terminal.js'

export const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The graphemes of a marked line, with the cursor marker as a piece of its own. */
function piecesOf(line: string): string[] {
  return line
    .split(CURSOR_MARKER)
    .flatMap((part, i) => [
      ...(i ? [CURSOR_MARKER] : []),
      ...Array.from(GRAPHEMES.segment(part), ({ segment }) => segment),
    ])
}

/**
 * Splits one logical line into the visual lines it occupies, breaking on columns rather than on
 * characters. The cursor marker takes no column of its own but is treated as needing one when
 * deciding where to break: a cursor sitting just past the last column of a full line belongs at the
 * start of the next line, not in a column the terminal does not have.
 */
export function wrapLine(line: string, width: number): string[] {
  const limit = Math.max(1, width)
  const out: string[] = []
  let cur = ''
  let used = 0
  for (const raw of piecesOf(line)) {
    const piece = displayWidth(raw) > limit ? '…' : raw
    const w = displayWidth(piece)
    if (used + Math.max(w, 1) > limit && cur !== '') {
      out.push(cur)
      cur = ''
      used = 0
    }
    cur += piece
    used += w
  }
  out.push(cur)
  return out
}

/**
 * The text offset under a click on the editor, in the layout `Editor.render` draws at `width`:
 * `row` counts text rows from the top of the whole draft (a scrolled viewport adds its start), `col`
 * counts columns from the editor's left edge. The prompt or a continuation prefix lands on the start
 * of its row, a wide character's right half lands after it, and a column past the end lands on the
 * row's end. Undefined when `row` is outside the draft.
 */
export function offsetAtCell(
  text: string,
  cursor: number,
  width: number,
  row: number,
  col: number,
): number | undefined {
  width = Math.max(1, Math.trunc(width))
  const promptWidth = width > 2 ? 2 : width === 2 ? 1 : 0
  const continuationWidth = width > 2 ? 2 : promptWidth
  const inner = Math.max(1, width - promptWidth)
  if (row < 0) return undefined
  if (!text) return row === 0 ? 0 : undefined
  const marked = text.slice(0, cursor) + CURSOR_MARKER + text.slice(cursor)
  const sources = text.split('\n')
  let top = 0
  let lineStart = 0
  for (const [i, logical] of marked.split('\n').entries()) {
    const source = Array.from(GRAPHEMES.segment(sources[i] ?? ''), ({ segment }) => segment)
    const segs = wrapLine(logical, inner)
    if (row >= top + segs.length) {
      top += segs.length
      lineStart += (sources[i] ?? '').length + 1
      continue
    }
    const at = row - top
    let index = 0
    for (const seg of segs.slice(0, at)) index += piecesOf(seg).filter((p) => p !== CURSOR_MARKER).length
    let offset = lineStart + source.slice(0, index).join('').length
    const x = col - (i === 0 && at === 0 ? promptWidth : continuationWidth)
    let used = 0
    for (const piece of piecesOf(segs[at] ?? '')) {
      if (piece === CURSOR_MARKER) continue
      const w = displayWidth(piece)
      // The cell's left half belongs to the character before the click, its right half to the one after.
      if ((x - used) * 2 < w) break
      used += w
      offset += source[index]?.length ?? 0
      index++
    }
    return offset
  }
  return undefined
}
