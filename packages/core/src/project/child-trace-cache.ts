import type { UISpan, UITurn } from '@agnes/protocol'
import { type ChildTaskRecord, isTerminalChildState } from '../child/types.js'
import { scanPages } from '../log/scan-pages.js'
import type { ScanQuery } from '../log/storage.js'
import type { Event, Seq } from '../types.js'
import { clipUtf16 } from './clip.js'
import type { TraceOwners } from './trace.js'
import { UIProjectionCell } from './ui.js'

export type ChildTraceSource = {
  lookup(childKey: string): Promise<Pick<ChildTaskRecord, 'parentKey' | 'boundarySeq' | 'state'> | null>
  scan(childKey: string, q: ScanQuery): Promise<Event[]>
}

export type ChildTraceLimits = { maxEntries: number; maxBytes: number; maxCells: number }

/** A child's folded span trees; read-only, shared with later probes. */
export type ChildTrace = {
  readonly spans: readonly UISpan[]
  readonly bytes: number
  /** Parent head when this child's fold last changed. */
  readonly changedAtParentSeq: Seq
}

type Entry = {
  boundarySeq: Seq
  lastSeq: Seq
  spans: UISpan[]
  /** The turn each of `spans` came from, to reuse the trees of turns that were already closed. */
  turnIds: string[]
  bytes: number
  changedAtParentSeq: Seq
  /** Live fold kept only while the child can still grow and the bounds allow it. */
  cell?: UIProjectionCell
  /** Encoded bytes of the rows behind `cell`, counted against the byte bound while it is kept. */
  cellBytes: number
  /** What this entry adds to the cache's byte count while it is stored. */
  counted: number
}

/** Kept for evicted children too, so folding the same rows again is not reported as a change. */
type Seen = Pick<Entry, 'boundarySeq' | 'lastSeq' | 'changedAtParentSeq'>

const DEFAULT_LIMITS: ChildTraceLimits = { maxEntries: 256, maxBytes: 8 * 1024 * 1024, maxCells: 8 }
const encoder = new TextEncoder()
const rowBytes = (rows: readonly Event[]) =>
  rows.reduce((sum, row) => sum + encoder.encode(JSON.stringify(row)).byteLength, 0)

/**
 * Per-parent cache of direct children's span trees. Every resolve re-checks the child record and
 * reads only rows past the folded tail, so a hit costs one lookup and one empty page. Eviction or
 * any failure only means the next resolve folds the child again from its boundary. The byte bound
 * covers the spans and the rows behind each live fold; the child just resolved is never evicted.
 */
export class ChildTraceCache {
  private readonly entries = new Map<string, Entry>()
  private readonly seen = new Map<string, Seen>()
  private bytes = 0
  private readonly limits: ChildTraceLimits

  constructor(
    private readonly parentKey: string,
    private readonly source: ChildTraceSource,
    limits: Partial<ChildTraceLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** Entry and live-fold counts and the bytes counted against the bound. */
  stats(): { entries: number; cells: number; bytes: number } {
    let cells = 0
    for (const entry of this.entries.values()) if (entry.cell) cells += 1
    return { entries: this.entries.size, cells, bytes: this.bytes }
  }

  /** Never throws: an unreadable or unauthorized child resolves to undefined. */
  async resolve(childKey: string, parentHead: Seq): Promise<ChildTrace | undefined> {
    try {
      const record = await this.source.lookup(childKey)
      if (!record || record.parentKey !== this.parentKey) {
        this.drop(childKey)
        this.seen.delete(childKey)
        return undefined
      }
      const entry =
        (await this.advance(childKey, record.boundarySeq, parentHead)) ??
        (await this.rebuild(childKey, record.boundarySeq, parentHead))
      if (!entry) return undefined
      if (isTerminalChildState(record.state)) delete entry.cell
      this.put(childKey, entry)
      this.evict(childKey)
      return entry
    } catch {
      this.drop(childKey)
      return undefined
    }
  }

  /** Folds new rows into the live cell; undefined asks for a rebuild. */
  private async advance(childKey: string, boundarySeq: Seq, parentHead: Seq): Promise<Entry | undefined> {
    const entry = this.entries.get(childKey)
    if (!entry || entry.boundarySeq !== boundarySeq) return undefined
    let rows: Event[]
    try {
      rows = await this.read(childKey, entry.lastSeq)
    } catch {
      return undefined
    }
    if (this.entries.get(childKey) !== entry) return undefined
    if (rows.length === 0) return entry
    const cell = entry.cell
    if (!cell || rows[0]?.seq !== cell.upto + 1) return undefined
    try {
      cell.apply(rows)
    } catch {
      return undefined
    }
    entry.cellBytes += rowBytes(rows)
    this.refresh(entry, cell)
    entry.changedAtParentSeq = parentHead
    return entry
  }

  private async rebuild(childKey: string, boundarySeq: Seq, parentHead: Seq): Promise<Entry | undefined> {
    this.drop(childKey)
    const rows = await this.read(childKey, boundarySeq)
    if (rows.length === 0) return undefined
    const cell = new UIProjectionCell(childKey, 'main')
    cell.startAfter(boundarySeq)
    cell.apply(rows)
    const entry: Entry = {
      boundarySeq,
      lastSeq: boundarySeq,
      spans: [],
      turnIds: [],
      bytes: 0,
      changedAtParentSeq: parentHead,
      cell,
      cellBytes: rowBytes(rows),
      counted: 0,
    }
    this.refresh(entry, cell)
    const before = this.seen.get(childKey)
    if (before?.boundarySeq === boundarySeq && before.lastSeq === entry.lastSeq)
      entry.changedAtParentSeq = before.changedAtParentSeq
    return entry
  }

  /** Takes the fold's spans; trees of turns closed before the previous tail are reused as they are. */
  private refresh(entry: Entry, cell: UIProjectionCell): void {
    const previous = new Map(entry.turnIds.map((id, index) => [id, entry.spans[index]]))
    const spans: UISpan[] = []
    const turnIds: string[] = []
    for (const turn of cell.turnList) {
      if (!turn.trace) continue
      const kept = previous.get(turn.id)
      const closed = turn.endSeq !== undefined && turn.endSeq <= entry.lastSeq
      spans.push(kept && closed ? kept : structuredClone(turn.trace))
      turnIds.push(turn.id)
    }
    entry.spans = spans
    entry.turnIds = turnIds
    entry.bytes = listBytes(spans) + 2
    entry.lastSeq = cell.upto
  }

  private async read(childKey: string, after: Seq): Promise<Event[]> {
    const rows: Event[] = []
    const pages = scanPages((q) => this.source.scan(childKey, q), {
      fromSeq: (after + 1) as Seq,
      order: 'asc',
    })
    for await (const page of pages) rows.push(...page)
    return rows
  }

  /** The one way an entry is stored: whatever was stored under the key is uncounted first. */
  private put(childKey: string, entry: Entry): void {
    this.drop(childKey)
    entry.counted = entry.bytes + (entry.cell ? entry.cellBytes : 0)
    this.bytes += entry.counted
    this.entries.set(childKey, entry)
    this.seen.delete(childKey)
    this.seen.set(childKey, {
      boundarySeq: entry.boundarySeq,
      lastSeq: entry.lastSeq,
      changedAtParentSeq: entry.changedAtParentSeq,
    })
    for (const key of this.seen.keys()) {
      if (this.seen.size <= this.limits.maxEntries * 4) break
      this.seen.delete(key)
    }
  }

  private drop(childKey: string): void {
    const entry = this.entries.get(childKey)
    if (!entry) return
    this.entries.delete(childKey)
    this.bytes -= entry.counted
  }

  private dropCell(entry: Entry): void {
    delete entry.cell
    this.bytes -= entry.counted - entry.bytes
    entry.counted = entry.bytes
  }

  /** Least recently used first: surplus live folds, then folds and entries while over the bytes. */
  private evict(keep: string): void {
    let cells = 0
    for (const entry of this.entries.values()) if (entry.cell) cells += 1
    for (const entry of this.entries.values()) {
      if (cells <= this.limits.maxCells) break
      if (!entry.cell) continue
      this.dropCell(entry)
      cells -= 1
    }
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.limits.maxBytes) break
      if (key !== keep && entry.cell) this.dropCell(entry)
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.limits.maxEntries && this.bytes <= this.limits.maxBytes) break
      if (key !== keep) this.drop(key)
    }
  }
}

/** Bytes of embedded child spans one web turn may carry. */
export const TRACE_SUBTREE_BUDGET = 128 * 1024

type SpanSize = { shallow: number; subtree: number; count: number }
const sizes = new WeakMap<UISpan, SpanSize>()
const byteLength = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength

/** Cached by object: cache spans are never modified after they are stored. */
function sizeOf(span: UISpan): SpanSize {
  const known = sizes.get(span)
  if (known) return known
  const shallow = byteLength({ ...span, children: [] })
  let subtree = shallow
  let count = 1
  for (const [index, child] of span.children.entries()) {
    const size = sizeOf(child)
    subtree += size.subtree + (index > 0 ? 1 : 0)
    count += size.count
  }
  const size = { shallow, subtree, count }
  sizes.set(span, size)
  return size
}

const listBytes = (spans: readonly UISpan[]): number =>
  spans.reduce((sum, span, index) => sum + sizeOf(span).subtree + (index > 0 ? 1 : 0), 0)
const listCount = (spans: readonly UISpan[]): number =>
  spans.reduce((sum, span) => sum + sizeOf(span).count, 0)

/** Stands in for the spans left out under `container`; the message is how many. */
const truncated = (container: UISpan, omitted: number): UISpan => ({
  id: `${clipUtf16(container.id, 118)}:truncated`,
  kind: 'other',
  name: 'trace-truncated',
  status: container.status,
  startSeq: container.startSeq,
  startedAt: container.startedAt,
  error: { code: 'TRACE_TRUNCATED', message: String(omitted) },
  children: [],
})

/**
 * Copies `source` under `container` within `budget.left` bytes. The caller guarantees room for one
 * placeholder covering all of `source`. Whole subtrees are taken while the rest can still be
 * marked; the first one that does not fit is descended into when its own placeholder fits, and
 * whatever follows becomes a single placeholder.
 */
function fill(container: UISpan, source: readonly UISpan[], budget: { left: number }): UISpan[] {
  const n = source.length
  const restBytes = new Array<number>(n + 1).fill(0)
  const restCount = new Array<number>(n + 1).fill(0)
  for (let i = n - 1; i >= 0; i -= 1) {
    const size = sizeOf(source[i] as UISpan)
    restBytes[i] = size.subtree + (restBytes[i + 1] ?? 0) + (i < n - 1 ? 1 : 0)
    restCount[i] = size.count + (restCount[i + 1] ?? 0)
  }
  const markBase = byteLength(truncated(container, 0)) - 1
  const mark = (omitted: number) => markBase + String(omitted).length
  const out: UISpan[] = []
  for (let i = 0; i < n; i += 1) {
    const child = source[i] as UISpan
    const comma = out.length > 0 ? 1 : 0
    if (comma + (restBytes[i] ?? 0) <= budget.left) {
      for (const rest of source.slice(i)) out.push(structuredClone(rest))
      budget.left -= comma + (restBytes[i] ?? 0)
      return out
    }
    const size = sizeOf(child)
    const later = i < n - 1 ? 1 + mark(restCount[i + 1] ?? 0) : 0
    if (comma + size.subtree + later <= budget.left) {
      out.push(structuredClone(child))
      budget.left -= comma + size.subtree
      continue
    }
    const inner =
      child.children.length > 0 ? byteLength(truncated(child, size.count - 1)) : Number.POSITIVE_INFINITY
    if (comma + size.shallow + inner + later <= budget.left) {
      const copy: UISpan = structuredClone({ ...child, children: [] })
      budget.left -= comma + size.shallow + later
      copy.children = fill(copy, child.children, budget)
      out.push(copy)
      if (later > 0) out.push(truncated(container, restCount[i + 1] ?? 0))
      return out
    }
    out.push(truncated(container, restCount[i] ?? 0))
    budget.left -= comma + mark(restCount[i] ?? 0)
    return out
  }
  return out
}

/**
 * Puts each resolved child's spans under its owner span in `turn`, which the caller owns. When all
 * of a turn's child trees fit in `budget` they are copied whole, exactly as the full projection
 * attaches them; otherwise each owner keeps room for at least its own placeholder and the trees
 * are cut to fit.
 */
export function embedChildTraces(
  turn: UITurn,
  owners: TraceOwners,
  traces: ReadonlyMap<string, ChildTrace | undefined>,
  budget: number = TRACE_SUBTREE_BUDGET,
): void {
  if (!turn.trace) return
  const targets: Array<{ span: UISpan; spans: readonly UISpan[] }> = []
  const claimed = new Set<string>()
  const visit = (span: UISpan) => {
    const key = span.kind === 'subagent' ? span.childSessionKey : undefined
    if (!key) {
      for (const child of span.children) visit(child)
      return
    }
    const owner = owners.get(key)
    const trace = traces.get(key)
    if (!trace || claimed.has(key) || owner?.turnId !== turn.id || owner.spanId !== span.id) return
    claimed.add(key)
    targets.push({ span, spans: trace.spans })
  }
  visit(turn.trace)
  if (targets.reduce((sum, target) => sum + listBytes(target.spans), 0) <= budget) {
    for (const target of targets) target.span.children = structuredClone(target.spans as UISpan[])
    return
  }
  const floors = targets.map((target) => byteLength(truncated(target.span, listCount(target.spans))))
  let reserved = floors.reduce((sum, floor) => sum + floor, 0)
  const state = { left: budget }
  for (const [index, target] of targets.entries()) {
    const floor = floors[index] ?? 0
    reserved -= floor
    if (state.left - reserved < floor) continue
    state.left -= reserved
    target.span.children = target.spans.length > 0 ? fill(target.span, target.spans, state) : []
    state.left += reserved
  }
}
