import type { MemoryParagraphValidity, MemoryValidityView } from '@agnes/extension-api'
import { fault, hash, omissionLine } from './content.js'
import { buildView, type HideRange, replaceInMemoryView, type Segment } from './view.js'

/**
 * Managed paragraphs: text the Host saved into the workspace index, wrapped in one marker line before
 * and one after. Whether each one is still in force lives in the Host's records, not in the file; the
 * agent sees only paragraphs the Host's validity view answers `valid` for.
 */
export const PARAGRAPH_ID = /^r[0-9a-z]{10}$/
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
export type ParsedParagraph = Readonly<{ id: string; start: number; end: number; text: string }>
export type ParagraphAnomaly = Readonly<{
  id?: string
  kind: 'duplicate' | 'unclosed' | 'nested' | 'stray'
  start: number
  end: number
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

/**
 * Well-formed paragraphs and every damaged marker, in one pass. An id that opens or closes more than
 * once is a duplicate everywhere. An opening marker that is damaged or has no closing marker of its
 * own is unclosed: it runs through the next marker line when that one closes, else up to the next
 * marker or the end, so the body of a paragraph with a damaged opener stays hidden. A paragraph
 * holding another marker is nested; a closing marker on its own is stray.
 */
export function parseParagraphs(text: string): {
  paragraphs: ParsedParagraph[]
  anomalies: ParagraphAnomaly[]
} {
  const markers = markerLines(text)
  const seen = new Map<string, number>()
  const closers = new Map<string, number[]>()
  markers.forEach((marker, index) => {
    if (!marker.id) return
    const key = `${marker.open ? 'open' : 'close'}:${marker.id}`
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (!marker.open) closers.set(marker.id, [...(closers.get(marker.id) ?? []), index])
  })
  const repeated = (id: string) => (seen.get(`open:${id}`) ?? 0) > 1 || (seen.get(`close:${id}`) ?? 0) > 1
  // Openers are visited in order, so each id's closer list is walked once overall.
  const cursor = new Map<string, number>()
  const closerAfter = (id: string, index: number): number => {
    const list = closers.get(id) ?? []
    let at = cursor.get(id) ?? 0
    while (at < list.length && list[at]! <= index) at++
    cursor.set(id, at)
    return list[at] ?? -1
  }
  const paragraphs: ParsedParagraph[] = []
  const anomalies: ParagraphAnomaly[] = []
  for (let i = 0; i < markers.length; ) {
    const marker = markers[i]!
    if (!marker.open) {
      anomalies.push({
        ...(marker.id ? { id: marker.id } : {}),
        kind: 'stray',
        start: marker.start,
        end: marker.end,
      })
      i++
      continue
    }
    const close = marker.id ? closerAfter(marker.id, i) : -1
    if (close === -1) {
      const next = markers[i + 1]
      const through = next !== undefined && !next.open
      anomalies.push({
        ...(marker.id ? { id: marker.id } : {}),
        kind: 'unclosed',
        start: marker.start,
        end: through ? next.end : (next?.start ?? text.length),
      })
      i += through ? 2 : 1
      continue
    }
    const region = { start: marker.start, end: markers[close]!.end }
    const inner = markers.slice(i + 1, close)
    if (inner.length) {
      anomalies.push({ id: marker.id!, kind: 'nested', ...region })
      for (const id of new Set(inner.map((other) => other.id)))
        if (id !== marker.id) anomalies.push({ ...(id ? { id } : {}), kind: 'nested', ...region })
    } else if (repeated(marker.id!)) {
      anomalies.push({ id: marker.id!, kind: 'duplicate', ...region })
    } else {
      const body = text.slice(marker.end, markers[close]!.start)
      paragraphs.push({ id: marker.id!, ...region, text: body.replace(/\r?\n$/, '') })
    }
    i = close + 1
  }
  return { paragraphs, anomalies }
}

/** What the agent sees of a stored file, and how its offsets map back onto the stored text. */
export type ParagraphView = Readonly<{
  content: string
  /** True when the file holds any marker-like line; only then may revision inputs change. */
  managed: boolean
  /** Ids left out, sorted; damaged markers without an id are not listed. */
  omittedIds: readonly string[]
  hidden: boolean
  markers: readonly MarkerLine[]
  segments: readonly Segment[]
}>

export { omissionLine }

/** A view that throws or answers out of range counts as unverifiable. */
export function validityOf(view: MemoryValidityView | undefined): (id: string) => MemoryParagraphValidity {
  return (id) => {
    if (!view) return 'unknown'
    try {
      const answer = view.validity(id)
      return answer === 'valid' || answer === 'expired' || answer === 'delivered' ? answer : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}

/** The whole stored text, for files whose markers are not managed (topic files). */
export function plainView(text: string): ParagraphView {
  return {
    content: text,
    managed: false,
    omittedIds: [],
    hidden: false,
    markers: markerLines(text),
    segments: [{ view: 0, raw: 0, length: text.length }],
  }
}

export function managedParagraphRanges(
  text: string,
  validity: (id: string) => MemoryParagraphValidity,
): { managed: boolean; markers: readonly MarkerLine[]; ranges: HideRange[] } {
  const markers = markerLines(text)
  if (!markers.length) return { managed: false, markers, ranges: [] }
  const { paragraphs, anomalies } = parseParagraphs(text)
  const ranges: HideRange[] = []
  for (const anomaly of anomalies) {
    ranges.push({
      start: anomaly.start,
      end: anomaly.end,
      appliesTo: 'both',
      reason: 'managed-omitted',
      mergeGroup: 'managed',
      ...(anomaly.id ? { omittedIds: [anomaly.id] } : {}),
    })
  }
  for (const paragraph of paragraphs) {
    const answer = validity(paragraph.id)
    if (answer !== 'valid' && answer !== 'delivered') {
      ranges.push({
        start: paragraph.start,
        end: paragraph.end,
        appliesTo: 'both',
        reason: 'managed-omitted',
        mergeGroup: 'managed',
        omittedIds: [paragraph.id],
      })
    } else if (answer === 'delivered') {
      ranges.push({
        start: paragraph.start,
        end: paragraph.end,
        appliesTo: 'note',
        reason: 'managed-delivered',
      })
    }
  }
  return { managed: true, markers, ranges }
}

/**
 * What the agent is shown of a stored index. `read` (files the agent opens) shows a `delivered`
 * paragraph like a `valid` one; `note` (the memory snapshot) leaves it out without an omission line,
 * since the Host gives it to the model itself. Both count the same paragraphs as omitted.
 */
export function paragraphView(
  text: string,
  validity: (id: string) => MemoryParagraphValidity,
  use: 'note' | 'read' = 'read',
): ParagraphView {
  const { managed, markers, ranges } = managedParagraphRanges(text, validity)
  if (!managed) return plainView(text)
  const built = buildView(
    { path: 'MEMORY.md', content: text, hash: '', bytes: Buffer.byteLength(text), lines: 0 },
    ranges,
    use,
    (group, count) => (group === 'managed' ? omissionLine(count) : ''),
  )
  return {
    content: built.content,
    managed: true,
    omittedIds: built.omitted,
    hidden: built.hidden,
    markers,
    segments: built.segments,
  }
}

/**
 * Each well-formed paragraph's id and text, sorted, so a whole-file write that edits a managed
 * paragraph or moves its markers across other lines can be told apart from one that keeps them.
 */
export function paragraphTexts(text: string): string {
  return JSON.stringify(
    parseParagraphs(text)
      .paragraphs.map(({ id, text }) => [id, text])
      .sort(([a], [b]) => (a! < b! ? -1 : 1)),
  )
}

/** Marker lines as a sorted list, so two texts can be compared for any added, removed or changed marker. */
export function markerSet(text: string): string {
  return JSON.stringify(
    markerLines(text)
      .map((marker) => marker.text)
      .sort(),
  )
}

/**
 * The stored text with the one occurrence of `oldText` in the agent's view replaced. The match must
 * lie in text the view shows as stored (not on an omission line) and touch no marker line.
 */
export function replaceInView(stored: string, view: ParagraphView, oldText: string, newText: string): string {
  return replaceInMemoryView(
    stored,
    {
      path: 'MEMORY.md',
      content: view.content,
      segments: view.segments,
      hidden: view.hidden,
      omitted: view.omittedIds,
    },
    view.markers,
    oldText,
    newText,
    markerSet,
  )
}

export type ParagraphChange = Readonly<
  { op: 'put'; id: string; text: string; expectTextHash?: string } | { op: 'remove'; id: string }
>

const wrap = (id: string, text: string, newline: boolean) =>
  `<!-- refinement:${id} -->\n${text}\n<!-- /refinement:${id} -->${newline ? '\n' : ''}`

/**
 * Apply all changes or none. Bytes outside the touched paragraphs stay as stored.
 *
 * - Put replaces a paragraph in place (keeping whether its closing line ended in a line break) or
 *   appends a new one after a blank line. Appending to text that does not end in a line break adds
 *   two and leaves the paragraph's own closing line without one; that missing break records the
 *   original ending.
 * - Remove cuts the paragraph and the separator an append added: two line breaks before a last
 *   paragraph without a final break, else one blank line.
 *
 * Put then remove therefore gives back the exact bytes only while the text next to the paragraph is
 * as the append left it; callers must not rely on an undo restoring an earlier hash.
 */
export function applyParagraphChanges(stored: string, changes: readonly ParagraphChange[]): string {
  if (!changes.length) throw fault('MEMORY_PARAGRAPH_INVALID')
  const ids = new Set<string>()
  for (const change of changes) {
    if (typeof change?.id !== 'string' || !PARAGRAPH_ID.test(change.id) || ids.has(change.id))
      throw fault('MEMORY_PARAGRAPH_INVALID')
    ids.add(change.id)
    if (change.op === 'put') {
      if (typeof change.text !== 'string') throw fault('MEMORY_PARAGRAPH_INVALID')
      if (
        change.expectTextHash !== undefined &&
        (typeof change.expectTextHash !== 'string' || !change.expectTextHash)
      )
        throw fault('MEMORY_PARAGRAPH_INVALID')
      if (markerLines(change.text).length) throw fault('MEMORY_MARKER_CHANGED')
    } else if (change.op !== 'remove') throw fault('MEMORY_PARAGRAPH_INVALID')
  }
  let text = stored
  for (const change of changes) {
    const { paragraphs, anomalies } = parseParagraphs(text)
    if (anomalies.some((anomaly) => anomaly.id === change.id)) throw fault('MEMORY_PARAGRAPH_ANOMALY')
    const found = paragraphs.find((paragraph) => paragraph.id === change.id)
    if (change.op === 'put') {
      if (change.expectTextHash !== undefined && (!found || hash(found.text) !== change.expectTextHash))
        throw fault('MEMORY_PARAGRAPH_EDITED')
      if (found)
        text =
          text.slice(0, found.start) +
          wrap(change.id, change.text, text[found.end - 1] === '\n') +
          text.slice(found.end)
      else if (!text) text = wrap(change.id, change.text, true)
      else if (text.endsWith('\n')) text = `${text}\n${wrap(change.id, change.text, true)}`
      else text = `${text}\n\n${wrap(change.id, change.text, false)}`
      continue
    }
    if (!found) throw fault('MEMORY_PARAGRAPH_NOT_FOUND')
    let before = text.slice(0, found.start)
    const after = text.slice(found.end)
    if (after === '' && text[found.end - 1] !== '\n' && before.endsWith('\n\n')) before = before.slice(0, -2)
    else if (before.endsWith('\n\n') && (after === '' || after.startsWith('\n'))) before = before.slice(0, -1)
    text = before + after
  }
  return text
}
