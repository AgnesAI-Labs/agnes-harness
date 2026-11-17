import { findTerms } from './find-scan.js'
import { redactedRanges } from './redacted-range.js'

export type FindWindow = {
  start: number
  end: number
  startLine: number
  endLine: number
  fragment: boolean
  text: string
  summary: string
}
type Span = Pick<FindWindow, 'start' | 'end' | 'startLine' | 'endLine' | 'fragment'> & { bytes: number }
const MAX_BYTES = 8192
const encoder = new TextEncoder()

/** Complete original lines; overlong lines are split only at Unicode code point boundaries. */
export function findWindows(text: string, query: string): FindWindow[] {
  const spans: Span[] = []
  let pending: Span | undefined
  const flush = () => {
    if (pending) spans.push(pending)
    pending = undefined
  }
  let line = 1
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline + 1
    const bytes = encoder.encode(text.slice(start, end)).length
    if (bytes <= MAX_BYTES) {
      if (pending && pending.bytes + bytes > MAX_BYTES) flush()
      if (pending) {
        pending.end = end
        pending.endLine = line
        pending.bytes += bytes
      } else pending = { start, end, startLine: line, endLine: line, bytes, fragment: false }
    } else {
      flush()
      let cursor = start
      let fragmentStart = start
      let fragmentBytes = 0
      while (cursor < end) {
        const cp = text.codePointAt(cursor) ?? 0
        const size = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4
        if (fragmentBytes + size > MAX_BYTES) {
          spans.push({
            start: fragmentStart,
            end: cursor,
            startLine: line,
            endLine: line,
            bytes: fragmentBytes,
            fragment: true,
          })
          fragmentStart = cursor
          fragmentBytes = 0
        }
        fragmentBytes += size
        cursor += cp > 0xffff ? 2 : 1
      }
      spans.push({
        start: fragmentStart,
        end,
        startLine: line,
        endLine: line,
        bytes: fragmentBytes,
        fragment: true,
      })
    }
    start = end
    line++
  }
  flush()
  const terms = findTerms(query)
  const ranked = spans
    .map((span) => {
      const lower = text.slice(span.start, span.end).toLowerCase()
      return { span, rank: terms.filter((term) => lower.includes(term)).length }
    })
    .sort((a, b) => b.rank - a.rank || a.span.start - b.span.start)
    .slice(0, 24)
  const redact = redactedRanges(text)
  return ranked.map(({ span: { bytes: _bytes, ...span } }) => {
    let summaryEnd = Math.min(span.end, span.start + 256)
    if (summaryEnd < span.end && /[\uD800-\uDBFF]/.test(text[summaryEnd - 1] ?? '')) summaryEnd--
    return { ...span, text: redact(span.start, span.end), summary: redact(span.start, summaryEnd) }
  })
}
