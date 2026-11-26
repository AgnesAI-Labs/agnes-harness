import type { MemoryFile } from '@agnes/extension-api'
import { fault } from './content.js'

export type Segment = Readonly<{ view: number; raw?: number; length: number }>

export type HideRange = Readonly<{
  start: number
  end: number
  appliesTo: 'note' | 'read' | 'both' | 'index'
  reason: string
  notice?: string
  readNotice?: string
  mergeGroup?: string
  omittedIds?: readonly string[]
}>

export type MemoryView = Readonly<{
  path: string
  content: string
  segments: readonly Segment[]
  hidden: boolean
  omitted: readonly string[]
}>

export type MarkerSpan = Readonly<{ start: number; end: number }>

type ActiveRange = {
  start: number
  end: number
  appliesTo: 'note' | 'read' | 'both'
  notice?: string
  mergeGroup?: string
  silent: boolean
  weight: number
}

function collectOmittedIds(ranges: readonly HideRange[]): string[] {
  const ids = new Set<string>()
  for (const range of ranges) {
    if (range.appliesTo === 'note' && range.notice === undefined && range.mergeGroup === undefined) continue
    for (const id of range.omittedIds ?? []) ids.add(id)
  }
  return [...ids].sort()
}

function normalizeActiveRanges(
  ranges: readonly HideRange[],
  kind: 'note' | 'read',
  textLength: number,
): ActiveRange[] {
  const raw: ActiveRange[] = []
  for (const range of ranges) {
    if (range.appliesTo !== 'both' && range.appliesTo !== kind) continue
    const start = Math.max(0, Math.min(range.start, textLength))
    const end = Math.max(0, Math.min(range.end, textLength))
    if (end <= start) continue
    const silent = range.notice === undefined && range.mergeGroup === undefined
    raw.push({
      start,
      end,
      appliesTo: range.appliesTo,
      ...(range.notice !== undefined ? { notice: range.notice } : {}),
      ...(range.mergeGroup !== undefined ? { mergeGroup: range.mergeGroup } : {}),
      silent,
      weight: 1,
    })
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: ActiveRange[] = []
  for (const current of raw) {
    const previous = merged.at(-1)
    if (!previous || current.start >= previous.end) {
      merged.push(current)
      continue
    }
    previous.end = Math.max(previous.end, current.end)
    if (!current.silent) {
      if (previous.silent) {
        previous.silent = false
        if (current.notice !== undefined) previous.notice = current.notice
        if (current.mergeGroup !== undefined) previous.mergeGroup = current.mergeGroup
      } else if (previous.mergeGroup !== undefined && previous.mergeGroup === current.mergeGroup) {
        previous.weight += current.weight
      } else if (
        current.notice !== undefined &&
        previous.notice !== undefined &&
        !previous.notice.includes(current.notice)
      ) {
        previous.notice = `${previous.notice}\n${current.notice}`
      }
    }
  }
  return merged
}

function collectReadNotices(
  ranges: readonly HideRange[],
  kind: 'note' | 'read',
  textLength: number,
  active: readonly ActiveRange[],
): Array<{ pos: number; text: string }> {
  if (kind !== 'read') return []
  const items: Array<{ pos: number; text: string }> = []
  for (const range of ranges) {
    if (range.appliesTo !== 'note' || !range.readNotice) continue
    const pos = Math.max(0, Math.min(range.end, textLength))
    const hiddenAtPos = active.some((entry) => !entry.silent && pos > entry.start && pos < entry.end)
    if (!hiddenAtPos) items.push({ pos, text: range.readNotice })
  }
  items.sort((a, b) => a.pos - b.pos)
  return items
}

export function buildView(
  entry: MemoryFile,
  ranges: readonly HideRange[],
  kind: 'note' | 'read',
  formatMerged?: (group: string, count: number) => string,
): MemoryView {
  const text = entry.content
  const omitted = collectOmittedIds(ranges)
  const active = normalizeActiveRanges(ranges, kind, text.length)
  if (!active.length && text.length === 0) {
    return {
      path: entry.path,
      content: '',
      segments: [{ view: 0, raw: 0, length: 0 }],
      hidden: false,
      omitted,
    }
  }
  const readNotices = collectReadNotices(ranges, kind, text.length, active)
  const segments: Segment[] = []
  let content = ''
  let cursor = 0
  let noticeIdx = 0

  const appendSynthetic = (note: string) => {
    if (!note) return
    segments.push({ view: content.length, length: note.length })
    content += note
  }
  const emitRawSlice = (from: number, to: number) => {
    if (to <= from) return
    segments.push({ view: content.length, raw: from, length: to - from })
    content += text.slice(from, to)
  }
  const keep = (from: number, to: number) => {
    let pos = from
    while (noticeIdx < readNotices.length && readNotices[noticeIdx]!.pos < from) noticeIdx++
    while (noticeIdx < readNotices.length && readNotices[noticeIdx]!.pos <= to) {
      const item = readNotices[noticeIdx++]!
      emitRawSlice(pos, item.pos)
      pos = item.pos
      const atLineBreak = item.pos > 0 && text[item.pos - 1] === '\n'
      const prefix = item.pos === 0 || atLineBreak ? '' : '\n'
      const suffix = atLineBreak ? '\n' : ''
      appendSynthetic(`${prefix}${item.text}${suffix}`)
    }
    emitRawSlice(pos, to)
  }

  for (let i = 0; i < active.length; ) {
    const current = active[i]!
    keep(cursor, current.start)
    if (current.silent) {
      cursor = current.end
      i++
      continue
    }
    let j = i
    let count = current.weight
    while (
      current.mergeGroup !== undefined &&
      j + 1 < active.length &&
      !active[j + 1]!.silent &&
      active[j + 1]!.mergeGroup === current.mergeGroup &&
      active[j + 1]!.start === active[j]!.end
    ) {
      j++
      count += active[j]!.weight
    }
    const end = active[j]!.end
    const label =
      current.mergeGroup !== undefined
        ? formatMerged
          ? formatMerged(current.mergeGroup, count)
          : (current.notice ?? '')
        : (current.notice ?? '')
    if (label) {
      const note = label + (end > 0 && text[end - 1] === '\n' ? '\n' : '')
      appendSynthetic(note)
    }
    cursor = end
    i = j + 1
  }
  keep(cursor, text.length)
  if (text.length === 0 && !segments.length) segments.push({ view: 0, length: content.length })
  return {
    path: entry.path,
    content,
    segments,
    hidden: readNotices.length > 0 || active.some((range) => kind === 'read' || !range.silent),
    omitted,
  }
}

export function rawOffsetToLine(rawText: string, rawOffset: number): number {
  const clamped = Math.max(0, Math.min(rawOffset, rawText.length))
  return rawText.slice(0, clamped).split('\n').length
}

export function mapViewOffsetToRaw(view: MemoryView, viewOffset: number): number | undefined {
  const findIn = (inclusiveEnd: boolean) =>
    view.segments.find(
      (seg) =>
        seg.raw !== undefined &&
        seg.view <= viewOffset &&
        (inclusiveEnd ? viewOffset <= seg.view + seg.length : viewOffset < seg.view + seg.length),
    )
  const hit = findIn(false) ?? findIn(true)
  return hit?.raw === undefined ? undefined : hit.raw + (viewOffset - hit.view)
}

export function mapViewSpanToRawLines(
  rawText: string,
  view: MemoryView,
  viewStart: number,
  viewEnd: number,
): { lineStart: number; lineEnd: number } | undefined {
  if (viewEnd <= viewStart) {
    const raw = mapViewOffsetToRaw(view, viewStart)
    if (raw === undefined) return undefined
    const line = rawOffsetToLine(rawText, raw)
    return { lineStart: line, lineEnd: line }
  }
  let minRaw: number | undefined
  let maxRaw: number | undefined
  for (const seg of view.segments) {
    if (seg.raw === undefined || seg.length === 0) continue
    const ovStart = Math.max(viewStart, seg.view)
    const ovEnd = Math.min(viewEnd, seg.view + seg.length)
    if (ovEnd <= ovStart) continue
    const rawStart = seg.raw + (ovStart - seg.view)
    const rawLast = seg.raw + (ovEnd - 1 - seg.view)
    minRaw = minRaw === undefined ? rawStart : Math.min(minRaw, rawStart)
    maxRaw = maxRaw === undefined ? rawLast : Math.max(maxRaw, rawLast)
  }
  if (minRaw === undefined || maxRaw === undefined) return undefined
  return {
    lineStart: rawOffsetToLine(rawText, minRaw),
    lineEnd: rawOffsetToLine(rawText, maxRaw),
  }
}

/** Keep previously hidden spans when editing live bytes. If a span itself changed and
 * cannot be located uniquely, cover the changed region until the next turn. */
export function retainedEditRanges(prior: string, live: string, ranges: readonly HideRange[]): HideRange[] {
  const hidden = ranges.filter((range) => range.appliesTo !== 'note')
  if (!hidden.length || prior === live) return hidden
  let left = 0
  while (left < prior.length && left < live.length && prior[left] === live[left]) left++
  let right = prior.length
  const delta = live.length - prior.length
  while (right > left && right + delta > left && prior[right - 1] === live[right + delta - 1]) right--
  return hidden.map((range) => {
    if (range.end <= left) return range
    if (range.start >= right) return { ...range, start: range.start + delta, end: range.end + delta }
    const text = prior.slice(range.start, range.end)
    const start = live.indexOf(text)
    if (text && start >= 0 && live.indexOf(text, start + 1) < 0)
      return { ...range, start, end: start + text.length }
    return { ...range, start: Math.min(range.start, left), end: Math.max(range.end, right) + delta }
  })
}

export function replaceInMemoryView(
  stored: string,
  view: MemoryView,
  markers: readonly MarkerSpan[],
  oldText: string,
  newText: string,
  markerSetFn: (text: string) => string,
): string {
  const first = oldText ? view.content.indexOf(oldText) : -1
  if (first === -1) throw fault('MEMORY_REPLACE_NOT_FOUND')
  if (view.content.indexOf(oldText, first + 1) !== -1) throw fault('MEMORY_REPLACE_AMBIGUOUS')
  const segment = view.segments.find(
    (entry) => first >= entry.view && first + oldText.length <= entry.view + entry.length,
  )
  if (segment?.raw === undefined) throw fault('MEMORY_HIDDEN_PARAGRAPHS')
  const start = segment.raw + (first - segment.view)
  const end = start + oldText.length
  if (markers.some((marker) => start < marker.end && end > marker.start)) throw fault('MEMORY_MARKER_CHANGED')
  const result = stored.slice(0, start) + newText + stored.slice(end)
  if (markerSetFn(result) !== markerSetFn(stored)) throw fault('MEMORY_MARKER_CHANGED')
  return result
}
