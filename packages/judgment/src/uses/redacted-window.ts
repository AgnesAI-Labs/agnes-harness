import { redactedRanges } from './redacted-range.js'

/** Mask with full context, but retain only characters from the original excerpt window. */
export function redactedWindow(text: string, limit: number, edge: 'first' | 'last'): string {
  const start = edge === 'first' ? 0 : Math.max(0, text.length - limit)
  const end = edge === 'first' ? Math.min(text.length, limit) : text.length
  return redactedRanges(text)(start, end)
}
