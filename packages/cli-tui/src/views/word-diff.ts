import { escapeVisible } from '../component.js'

/** A removed or added line of a diff; `marks` are the changed [from, to) ranges of its shown text. */
export type MarkedOp = { mark: ' ' | '+' | '-'; text: string; marks?: Array<[number, number]> }

/** The text of a diff line as it is drawn: tabs widened and control and invisible format characters made visible. */
export const shownText = (text: string): string => escapeVisible(text.replaceAll('\t', '  '))

// Past these a pair is shown as two plain changed lines: the word compare is a quadratic table, and a
// line that long is rarely an edit of one word.
const MAX_CHARS = 500
const MAX_TOKENS = 250
const MAX_PAIRS = 400
// Under this share of the words in common the lines are different lines, not one edited line.
const MIN_SHARED = 0.4

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu

/** Changed [from, to) ranges in `a` and in `b`, or undefined when the pair should stay line-level. */
export function wordRanges(
  a: string,
  b: string,
): [Array<[number, number]>, Array<[number, number]>] | undefined {
  if (a.length > MAX_CHARS || b.length > MAX_CHARS) return undefined
  const ta = a.match(TOKEN) ?? []
  const tb = b.match(TOKEN) ?? []
  if (ta.length > MAX_TOKENS || tb.length > MAX_TOKENS) return undefined
  const n = ta.length
  const m = tb.length
  const w = m + 1
  const lcs = new Uint16Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        ta[i] === tb[j]
          ? (lcs[(i + 1) * w + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * w + j] as number, lcs[i * w + j + 1] as number)
  const keepA = new Array<boolean>(n).fill(false)
  const keepB = new Array<boolean>(m).fill(false)
  let shared = 0
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (ta[i] === tb[j]) {
      keepA[i] = keepB[j] = true
      if (!/^\s+$/.test(ta[i] as string)) shared += (ta[i] as string).length
      i++
      j++
    } else if ((lcs[(i + 1) * w + j] as number) >= (lcs[i * w + j + 1] as number)) i++
    else j++
  }
  const size = (s: string) => s.replace(/\s+/g, '').length
  if (shared < MIN_SHARED * Math.max(size(a), size(b))) return undefined
  const ranges = (tokens: string[], keep: boolean[]): Array<[number, number]> => {
    const out: Array<[number, number]> = []
    let at = 0
    // Only spaces since the last mark ended: the next changed word joins it, so a phrase is one block.
    let joinable = false
    tokens.forEach((token, i) => {
      const end = at + token.length
      if (!/^\s+$/.test(token)) {
        const last = out.at(-1)
        if (keep[i]) joinable = false
        else {
          if (last && joinable) last[1] = end
          else out.push([at, end])
          joinable = true
        }
      }
      at = end
    })
    return out
  }
  return [ranges(ta, keepA), ranges(tb, keepB)]
}

/** Marks the changed words of paired removed/added lines (the i-th removed with the i-th added of a change). */
export function markWords(ops: MarkedOp[]): void {
  let pairs = 0
  for (let i = 0; i < ops.length; ) {
    if (ops[i]?.mark === ' ') {
      i++
      continue
    }
    const removed: MarkedOp[] = []
    const added: MarkedOp[] = []
    for (; i < ops.length && ops[i]?.mark !== ' '; i++)
      (ops[i]?.mark === '-' ? removed : added).push(ops[i] as MarkedOp)
    for (let k = 0; k < Math.min(removed.length, added.length) && pairs < MAX_PAIRS; k++, pairs++) {
      const [from, to] = [removed[k] as MarkedOp, added[k] as MarkedOp]
      const found = wordRanges(shownText(from.text), shownText(to.text))
      if (!found) continue
      from.marks = found[0]
      to.marks = found[1]
    }
  }
}

/** `text` with each [from, to) range (offsets in the whole line; `text` starts at `base`) passed through `paint`. */
export function applyMarks(
  text: string,
  marks: ReadonlyArray<[number, number]>,
  paint: (s: string) => string,
  base = 0,
): string {
  let at = 0
  let out = ''
  for (const [from, to] of marks) {
    const a = Math.max(from - base, at)
    const b = Math.min(to - base, text.length)
    if (b <= a) continue
    out += text.slice(at, a) + paint(text.slice(a, b))
    at = b
  }
  return out + text.slice(at)
}

/**
 * Which lines of a unified diff are `---`/`+++` file headers: only those before a file's first hunk
 * (the start of the text, or a `diff ` / `── ` file line, up to its `@@`). Inside a hunk, a removed
 * line whose text starts with `-- ` also begins with `--- `.
 */
export function fileHeaderLines(lines: readonly string[]): boolean[] {
  let header = true
  return lines.map((line) => {
    if (line.startsWith('@@')) header = false
    else if (line.startsWith('diff ') || line.startsWith('── ')) header = true
    return header && /^(\+\+\+|---) /.test(line)
  })
}

/** Changed-word ranges for the lines of a unified diff (offsets count the leading `+`/`-`), by line index. */
export function unifiedMarks(lines: readonly string[]): Map<number, Array<[number, number]>> {
  const headers = fileHeaderLines(lines)
  const ops: Array<MarkedOp & { at: number }> = lines.map((line, at) => ({
    mark: headers[at] ? ' ' : line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ',
    text: line.slice(1),
    at,
  }))
  markWords(ops)
  return new Map(
    ops.flatMap((op) =>
      op.marks ? [[op.at, op.marks.map(([a, b]) => [a + 1, b + 1] as [number, number])] as const] : [],
    ),
  )
}
