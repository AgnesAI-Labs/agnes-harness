const annotation = /^<!--\s*expires_at:/u
const iso = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/u

export function expiryTime(value: string): number {
  const match = iso.exec(value)
  if (!match) return NaN
  const [, date, time, zone] = match
  // Date.parse normalizes February 30 and other impossible dates. Reject those too.
  const midnight = new Date(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight.getTime()) || !midnight.toISOString().startsWith(`${date}T`)) return NaN
  return time ? Date.parse(`${date}T${time}${zone ?? 'Z'}`) : midnight.getTime()
}

export function* annotations(content: string) {
  let pending: { start: number; expiresAt: number }[] = []
  for (const line of content.matchAll(/[^\n]*\n|[^\n]+$/gu)) {
    const text = line[0].trim()
    if (!text) {
      for (const item of pending) yield { ...item, end: line.index }
      pending = []
      continue
    }
    const match = annotation.exec(text)
    if (match && text.indexOf('-->') === text.length - 3) {
      pending.push({ start: line.index, expiresAt: expiryTime(text.slice(match[0].length, -3).trim()) })
    }
  }
  for (const item of pending) yield { ...item, end: content.length }
}

const STRICT = /^<!-- (\/?)refinement:(r[0-9a-z]{10}) -->$/
/** Anything that looks like a marker, well-formed or not, so a damaged one is never read as text. */
const LOOSE = /^\s*<!--\s*\/?\s*refinement\s*:/i
/** A marker-like line that closes; any other marker-like line opens, even when damaged. */
const CLOSING = /^\s*<!--\s*\//
const BOM = '\uFEFF'

export type MarkerLine = Readonly<{
  /** Offset of the line's first character, after a byte order mark. */
  start: number
  /** Offset just past the line, including its line break. */
  end: number
  text: string
  /** Absent for a marker-like line that is not well-formed. */
  id?: string
  open: boolean
}>
export function markerLines(text: string): MarkerLine[] {
  const markers: MarkerLine[] = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline + 1
    const raw = text.slice(start, newline === -1 ? text.length : newline)
    const skip = raw.startsWith(BOM) ? BOM.length : 0
    const line = raw.slice(skip).replace(/\r$/, '')
    if (LOOSE.test(line)) {
      const strict = STRICT.exec(line)
      markers.push(
        strict
          ? { start: start + skip, end, text: line, id: strict[2]!, open: strict[1] === '' }
          : { start: start + skip, end, text: line, open: !CLOSING.test(line) },
      )
    }
    start = end
  }
  return markers
}
