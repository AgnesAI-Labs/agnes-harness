/** Geometry for the trace ledger. Entries are ordered exactly as they appear in the list. */
export type TraceVirtualEntry = { key: string; kind: 'header' | 'row' }

export type TraceVirtualHeights = { header: number; row: number }

export type TraceVirtualLayout<T extends TraceVirtualEntry = TraceVirtualEntry> = {
  entries: readonly T[]
  /** Top edge of each entry, followed by the total height. */
  offsets: readonly number[]
  indexByKey: ReadonlyMap<string, number>
  totalHeight: number
}

export type TraceVirtualWindow = {
  /** First mounted entry, inclusive. */
  start: number
  /** Last mounted entry, exclusive. */
  end: number
  topPadding: number
  bottomPadding: number
  totalHeight: number
}

export type TraceVirtualAnchor = { key: string; offsetWithinEntry: number }

function requireFiniteNonnegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`)
}

function clamp(value: number, lower: number, upper: number): number {
  return Math.max(lower, Math.min(value, upper))
}

/** Build once per filtered/collapsed ledger, then reuse for scroll events. */
export function buildTraceVirtualLayout<T extends TraceVirtualEntry>(
  entries: readonly T[],
  heights: TraceVirtualHeights,
): TraceVirtualLayout<T> {
  for (const [name, height] of Object.entries(heights)) {
    if (!Number.isFinite(height) || height <= 0) throw new RangeError(`${name} height must be positive`)
  }
  const offsets = [0]
  const indexByKey = new Map<string, number>()
  for (const [index, entry] of entries.entries()) {
    if (indexByKey.has(entry.key)) throw new Error(`duplicate trace key: ${entry.key}`)
    indexByKey.set(entry.key, index)
    offsets.push((offsets[index] ?? 0) + heights[entry.kind])
  }
  return { entries, offsets, indexByKey, totalHeight: offsets[offsets.length - 1] ?? 0 }
}

/** First entry whose bottom edge is strictly after the given pixel position. */
function indexAtOffset(layout: TraceVirtualLayout, offset: number): number {
  let low = 0
  let high = layout.entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((layout.offsets[middle + 1] ?? 0) <= offset) low = middle + 1
    else high = middle
  }
  return low
}

/** First entry whose top edge is at or after the given pixel position. */
function indexStartingAtOrAfter(layout: TraceVirtualLayout, offset: number): number {
  let low = 0
  let high = layout.entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((layout.offsets[middle] ?? 0) < offset) low = middle + 1
    else high = middle
  }
  return low
}

/** Visible entries plus pixel overscan; padding keeps native scrollbar geometry intact. */
export function getTraceVirtualWindow(
  layout: TraceVirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 0,
): TraceVirtualWindow {
  requireFiniteNonnegative(viewportHeight, 'viewportHeight')
  requireFiniteNonnegative(overscanPx, 'overscanPx')
  const count = layout.entries.length
  if (count === 0) return { start: 0, end: 0, topPadding: 0, bottomPadding: 0, totalHeight: 0 }
  const top = clamp(
    Number.isFinite(scrollTop) ? scrollTop : 0,
    0,
    Math.max(0, layout.totalHeight - viewportHeight),
  )
  const start = Math.min(count - 1, indexAtOffset(layout, Math.max(0, top - overscanPx)))
  const end = Math.max(
    start + 1,
    indexStartingAtOrAfter(layout, Math.min(layout.totalHeight, top + viewportHeight + overscanPx)),
  )
  return {
    start,
    end: Math.min(count, end),
    topPadding: layout.offsets[start] ?? 0,
    bottomPadding: layout.totalHeight - (layout.offsets[Math.min(count, end)] ?? layout.totalHeight),
    totalHeight: layout.totalHeight,
  }
}

/** Remember the top visible entry before older records are prepended or new records are appended. */
export function captureTraceVirtualAnchor(
  layout: TraceVirtualLayout,
  scrollTop: number,
): TraceVirtualAnchor | undefined {
  if (layout.entries.length === 0) return undefined
  const top = clamp(Number.isFinite(scrollTop) ? scrollTop : 0, 0, layout.totalHeight)
  const index = Math.min(layout.entries.length - 1, indexAtOffset(layout, top))
  const entry = layout.entries[index]
  return entry ? { key: entry.key, offsetWithinEntry: top - (layout.offsets[index] ?? 0) } : undefined
}

/** Restore a captured entry after the list changes; fall back when a search removes that key. */
export function restoreTraceVirtualAnchor(
  layout: TraceVirtualLayout,
  anchor: TraceVirtualAnchor | undefined,
  fallbackScrollTop = 0,
  viewportHeight = 0,
): number {
  requireFiniteNonnegative(viewportHeight, 'viewportHeight')
  const index = anchor ? layout.indexByKey.get(anchor.key) : undefined
  const target =
    index === undefined || anchor === undefined
      ? fallbackScrollTop
      : (layout.offsets[index] ?? 0) + anchor.offsetWithinEntry
  return clamp(Number.isFinite(target) ? target : 0, 0, Math.max(0, layout.totalHeight - viewportHeight))
}

/** Scroll just enough to reveal a keyed entry, including one currently outside the mounted window. */
export function getTraceVirtualScrollTopForKey(
  layout: TraceVirtualLayout,
  key: string,
  scrollTop: number,
  viewportHeight: number,
): number | undefined {
  requireFiniteNonnegative(viewportHeight, 'viewportHeight')
  const index = layout.indexByKey.get(key)
  if (index === undefined) return undefined
  const top = clamp(
    Number.isFinite(scrollTop) ? scrollTop : 0,
    0,
    Math.max(0, layout.totalHeight - viewportHeight),
  )
  const entryTop = layout.offsets[index] ?? 0
  const entryBottom = layout.offsets[index + 1] ?? entryTop
  if (entryBottom - entryTop > viewportHeight) return entryTop
  if (entryTop < top) return entryTop
  if (entryBottom > top + viewportHeight)
    return clamp(entryBottom - viewportHeight, 0, Math.max(0, layout.totalHeight - viewportHeight))
  return top
}
