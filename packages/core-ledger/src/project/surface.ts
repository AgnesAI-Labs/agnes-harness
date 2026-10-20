import { CoreError, type Event, type Seq } from '@agnes/core-common/types'
import type { SessionStart } from '@agnes/protocol'

/**
 * One node of what the model sees. A `summary` node stands in for the range it masks; the masked
 * rows are still in the ledger, and `masked` records which range and which rows it was built from.
 */
export type SurfaceNode = {
  seq: Seq
  kind: 'user' | 'assistant' | 'tool_result' | 'summary'
  event: Event
  pinned: boolean
  masked?: { start: Seq; end: Seq; sourceEventSeqs: Seq[] }
}

/**
 * A surface's nodes as they stood when taken; `byId` and `nestedToolUseIds` are the live, append-only
 * maps, read up to the fork seq. `nestedToolUseIds` maps each nested call's id to the seq of its
 * `tool/call` row, which is what lets a seed keep only the ids that existed at its fork point.
 */
export type SurfaceSnapshot = {
  nodes: readonly SurfaceNode[]
  replaceGeneration: number
  byId: ReadonlyMap<Seq, Event>
  nestedToolUseIds: ReadonlyMap<string, Seq>
}

/**
 * Whether a `tool/call` row's data is a nested call: one a tool made through `ctx.tools.invoke`,
 * which carries `depth > 0`. The model never asked for it, so neither it nor its result is shown.
 */
export function isNestedCall(data: unknown): boolean {
  const depth = (data as { depth?: unknown } | null | undefined)?.depth
  return typeof depth === 'number' && depth > 0
}

/** Message types carried by the surface; delegated session starts also reset its scope. */
const KIND: Record<string, SurfaceNode['kind']> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool_result',
}

/** Whether `e` is the result of a nested call, which never reaches the surface. */
function hiddenResult(e: Event, nested: ReadonlyMap<string, Seq>): boolean {
  return e.type === 'tool/result' && nested.has(String((e.data as { toolUseId?: unknown }).toolUseId))
}

/**
 * Folds one event onto a surface the caller owns, in place. `changed` says whether the surface is
 * different afterwards; `replaced` says whether a range was actually masked, which is what a
 * generation counter should count — an event whose range no longer resolves changes nothing.
 */
function applyEvent(
  nodes: SurfaceNode[],
  e: Event,
  pins: Set<Seq>,
  nested: Map<string, Seq>,
): { changed: boolean; replaced: boolean } {
  if (e.type === 'session/start') {
    const start = e.data as unknown as SessionStart
    if (start.parent && start.delegation?.kind === 'spawn') {
      // Ancestry remains in the ledger, but a spawned task owns a fresh conversation.
      // In particular, the parent's still-running spawn/workflow is not a child tool call.
      const changed = nodes.length > 0
      nodes.length = 0
      return { changed, replaced: changed }
    }
  }
  if (e.type === 'tool/call') {
    // Read only to remember which calls are nested; a call is never a node of its own.
    if (isNestedCall(e.data)) nested.set(String((e.data as { toolUseId?: unknown }).toolUseId), e.seq)
    return { changed: false, replaced: false }
  }
  const kind = KIND[e.type]
  if (!kind) return { changed: false, replaced: false }
  // A nested call's result belongs to the tool that made the call, not to the conversation. This is
  // read by call id, so a refused result (which names no source rows) is hidden like any other.
  if (hiddenResult(e, nested)) return { changed: false, replaced: false }
  if (typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') {
    const { start, end } = e.surfaceOp
    const i = nodes.findIndex((n) => n.seq === start)
    const j = nodes.findIndex((n) => n.seq === end)
    // An unresolvable range is tolerated on a rebuild rather than fatal: the append path validated it
    // when it was written, so the fold's job here is to reproduce a history, not to re-adjudicate it.
    if (i === -1 || j === -1 || j < i) return { changed: false, replaced: false }
    const summary: SurfaceNode = {
      seq: e.seq,
      kind: 'summary',
      event: e,
      pinned: false,
      masked: { start, end, sourceEventSeqs: e.sourceEventSeqs ?? [] },
    }
    // The summary takes the range's place, so an earlier summary caught inside the range is masked
    // along with everything else and the surface never carries two.
    nodes.splice(i, j - i + 1, summary)
    return { changed: true, replaced: true }
  }
  nodes.push({ seq: e.seq, kind, event: e, pinned: pins.has(e.seq) })
  return { changed: true, replaced: false }
}

export function computeSurface(
  events: Iterable<Event>,
  opts: { lane?: string; upto?: Seq; pins?: Set<Seq> } = {},
): SurfaceNode[] {
  const lane = opts.lane ?? 'main'
  const pins = opts.pins ?? new Set<Seq>()
  const nodes: SurfaceNode[] = []
  const nested = new Map<string, Seq>()
  for (const e of events) {
    if (opts.upto !== undefined && e.seq > opts.upto) break
    if ((e.lane ?? 'main') !== lane) continue
    applyEvent(nodes, e, pins, nested)
  }
  return nodes
}

/**
 * Whether masking `surface[i..j]` keeps every tool call and its results on the same side. A result's
 * owner is read by position: the nearest assistant before it, looking back past results and users
 * (a batch's refused results and the runtime_context note written between them). The look-back
 * stops at a summary, because whatever call sat beyond it is already masked; such a result is an
 * orphan already and may be masked freely. The range may not start on a result, and the node after
 * it may not be a result, which would otherwise sit right behind the summary with no call before it.
 * Call ids are deliberately not read: a surface restored from a checkpoint, or a fork child reading
 * its parent's prefix, has the positions but not the ledger state that attributes calls.
 */
export function pairClosed(surface: readonly SurfaceNode[], i: number, j: number): boolean {
  if (surface[i]?.kind === 'tool_result' || surface[j + 1]?.kind === 'tool_result') return false
  let owner = -1
  for (let k = 0; k < surface.length; k++) {
    const kind = surface[k]?.kind
    if (kind === 'assistant') owner = k
    else if (kind === 'summary') owner = -1
    else if (kind === 'tool_result' && owner >= 0 && (k >= i && k <= j) !== (owner >= i && owner <= j))
      return false
  }
  return true
}

/**
 * Rejects a replace before it is written. A range that does not resolve to a run of the current
 * surface, covers a node compaction was told to keep, does not match the rows it claims to summarize,
 * or would separate a tool call from its result is refused.
 */
export function validateReplace(
  op: { start: Seq; end: Seq },
  sourceEventSeqs: Seq[],
  surface: readonly SurfaceNode[],
  _events: Map<Seq, Event>,
): void {
  const i = surface.findIndex((n) => n.seq === op.start)
  const j = surface.findIndex((n) => n.seq === op.end)
  if (i === -1 || j === -1 || j < i)
    throw new CoreError('E_SURFACE_RANGE', 'replace range is not contiguous on the current surface', {
      ...op,
    })
  if (surface.slice(i, j + 1).some((n) => n.pinned))
    throw new CoreError('E_SURFACE_RANGE', 'replace range covers a pinned node', { ...op })
  if (sourceEventSeqs[0] !== op.start || sourceEventSeqs[sourceEventSeqs.length - 1] !== op.end)
    throw new CoreError('E_SURFACE_RANGE', 'sourceEventSeqs must start/end at the range boundaries', {
      ...op,
    })
  if (!pairClosed(surface, i, j))
    throw new CoreError('E_SURFACE_RANGE', 'replace range splits a tool call from its result', { ...op })
}

let seedSurfaceImpl: (lane: string, snap: SurfaceSnapshot, seq: Seq) => SurfaceCache

/**
 * The surface of one lane, maintained as rows arrive rather than refolded per read. `replaceGeneration`
 * counts masks and scope resets actually applied, so a consumer caching the surface can tell
 * an append from a rewrite.
 */
export class SurfaceCache {
  // Only this class holds #nodes and changes it in place. What it hands out is #view: a copy made
  // on the first read after a change and kept until the next, so an array a caller holds never
  // changes under it and reads between changes return the same array.
  #nodes: SurfaceNode[] = []
  #view: readonly SurfaceNode[] | undefined
  readonly #byId = new Map<Seq, Event>()
  // Nested calls are not model-visible rows, so they stay out of #byId; only their ids are kept.
  readonly #nested = new Map<string, Seq>()
  readonly #lane: string
  readonly #pins: Set<Seq>
  #upto = 0
  replaceGeneration = 0

  static {
    // Kept off the class so the root export cannot build a surface from a caller-made snapshot.
    seedSurfaceImpl = (lane, snap, seq) => {
      const cache = new SurfaceCache(lane)
      cache.#nodes = snap.nodes.map((n) => (n.pinned ? { ...n, pinned: false } : n))
      for (const [id, event] of snap.byId) if (id <= seq) cache.#byId.set(id, event)
      for (const [id, callSeq] of snap.nestedToolUseIds) if (callSeq <= seq) cache.#nested.set(id, callSeq)
      cache.replaceGeneration = snap.replaceGeneration
      cache.#upto = seq
      return cache
    }
  }

  /** The highest seq this surface has been handed, whatever its lane or type. */
  get upto(): Seq {
    return this.#upto
  }

  snapshot(): SurfaceSnapshot {
    return {
      nodes: this.nodes(),
      replaceGeneration: this.replaceGeneration,
      byId: this.#byId,
      nestedToolUseIds: this.#nested,
    }
  }

  constructor(lane: string, pins: Set<Seq> = new Set()) {
    this.#lane = lane
    this.#pins = pins
  }

  push(events: Event[]): void {
    for (const e of events) {
      if (e.seq > this.#upto) this.#upto = e.seq
      if ((e.lane ?? 'main') !== this.#lane) continue
      const applied = applyEvent(this.#nodes, e, this.#pins, this.#nested)
      if (KIND[e.type] && !hiddenResult(e, this.#nested)) this.#byId.set(e.seq, e)
      if (applied.changed) this.#view = undefined
      if (applied.replaced) this.replaceGeneration++
    }
  }

  nodes(): readonly SurfaceNode[] {
    this.#view ??= this.#nodes.slice()
    return this.#view
  }

  /** The model-visible rows by seq, as the append path hands them to validateReplace. */
  eventsById(): Map<Seq, Event> {
    return this.#byId
  }

  /** Marks a node unmaskable. Compaction pins what it must keep before it proposes a range. */
  pin(seq: Seq): void {
    this.#pins.add(seq)
    this.#nodes = this.#nodes.map((n) => (n.seq === seq ? { ...n, pinned: true } : n))
    this.#view = undefined
  }
}

/**
 * A child's surface at fork point `seq`, built from its parent's snapshot. Pins are the parent's
 * compaction bookkeeping and do not carry over; the parent's nodes are shared, never modified.
 */
export function seedSurface(lane: string, snap: SurfaceSnapshot, seq: Seq): SurfaceCache {
  return seedSurfaceImpl(lane, snap, seq)
}
