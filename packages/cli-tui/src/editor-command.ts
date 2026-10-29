import { CURSOR_MARKER } from './component.js'

/**
 * Where the recognised slash command sits in the first logical line once the cursor marker is spliced
 * in, as a `[start, end)` range of that marked line; undefined when the draft does not start with a
 * known command. `known` is the question the completion menu asks, so both agree on what a command is.
 * The marker takes no column, so the range only tells which characters to colour, never where to wrap.
 */
export function commandSpan(
  text: string,
  cursor: number,
  known: (token: string) => boolean,
): [number, number] | undefined {
  const token = /^\/[^\s]*/u.exec(text)?.[0]
  if (!token || !known(token)) return undefined
  const m = CURSOR_MARKER.length
  return [cursor === 0 ? m : 0, token.length <= cursor ? token.length : token.length + m]
}

/**
 * Paints the part of `seg` (which starts `at` characters into the marked line) that falls inside
 * `span`. A cursor marker inside the span stays unstyled, so styling never wraps the marker.
 */
export function paintSpan(
  seg: string,
  at: number,
  span: [number, number] | undefined,
  paint: (text: string) => string,
): string {
  if (!span) return seg
  const lo = Math.max(span[0], at) - at
  const hi = Math.min(span[1], at + seg.length) - at
  if (lo >= hi) return seg
  const styled = seg
    .slice(lo, hi)
    .split(CURSOR_MARKER)
    .map((part) => (part ? paint(part) : part))
    .join(CURSOR_MARKER)
  return seg.slice(0, lo) + styled + seg.slice(hi)
}
