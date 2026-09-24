// The usage bookkeeping the UI cell kept before it stopped copying per row, kept verbatim as the
// reference the equivalence tests compare against: cache-health's seen-effect set copied on every
// inference cost row, and the surface rebuilt as a new array for every node.
import type { CostLedger, RequestHeader } from '@agnes/protocol'
import type { CacheHealthState, CacheInvalidationRecord } from '../../src/project/cache-health.js'
import type { SurfaceNode } from '../../src/project/surface.js'
import type { Event, Seq } from '../../src/types.js'

export type ReferenceCacheHealthState = Omit<CacheHealthState, 'seenEffectIds'> & {
  seenEffectIds: ReadonlySet<string>
}

export function referenceInitialCacheHealthState(): ReferenceCacheHealthState {
  return {
    seenEffectIds: new Set(),
    compactionSeen: false,
    cumulativeCacheRead: 0,
    cumulativePromptTokens: 0,
  }
}

const MIN_CACHE_FOOTPRINT = 2048

function detectCacheInvalidation(
  prev: { input: number; cacheRead: number; cacheWrite: number } | undefined,
  current: { input: number; cacheRead: number; cacheWrite: number },
): { reprocessedTokens: number } | undefined {
  if (!prev) return undefined
  if (prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined
  if (current.cacheRead > 0) return undefined
  const reprocessedTokens = current.cacheWrite + current.input
  if (reprocessedTokens < MIN_CACHE_FOOTPRINT) return undefined
  return { reprocessedTokens }
}

export function referenceApplyCacheHealthEvent(
  state: ReferenceCacheHealthState,
  event: Event,
  lane: string,
): ReferenceCacheHealthState {
  if (event.type === 'session/start' && (event.data as { parent?: unknown } | null)?.parent)
    return referenceInitialCacheHealthState()
  if ((event.lane ?? 'main') !== lane) return state
  if (event.type === 'request/header') {
    const header = event.data as RequestHeader
    return { ...state, currentPromptPrefixHash: header.prompt_prefix_hash }
  }
  // Compaction's rewrite is the one assistant/message that carries surfaceOp:{op:'replace'}
  // (compaction.ts writes exactly this and nothing else touches surfaceOp this way). Seeing it
  // between two inference rows is how the next cold turn gets attributed to compaction rather than
  // falling through to the history-changed catch-all.
  if (
    event.type === 'assistant/message' &&
    typeof event.surfaceOp === 'object' &&
    event.surfaceOp.op === 'replace'
  )
    return { ...state, compactionSeen: true }
  if (event.type !== 'cost/ledger') return state
  const row = event.data as CostLedger
  if (row.purpose !== 'inference' || row.interrupted || row.adjustment) return state
  if (state.seenEffectIds.has(row.effectId)) return state
  const current = {
    input: row.tokens.input,
    cacheRead: row.tokens.cacheRead,
    cacheWrite: row.tokens.cacheWrite,
  }
  const invalidation = detectCacheInvalidation(state.prevUsage, current)
  const seenEffectIds = new Set(state.seenEffectIds)
  seenEffectIds.add(row.effectId)
  // Cause is read off the state *before* this turn's carry-forward below: currentPromptPrefixHash
  // was already updated by the most recent request/header event, while lastTurnPromptPrefixHash
  // still holds the snapshot from the turn before that -- so comparing the two old fields (not the
  // ones just carried forward) is what tells system-prefix drift apart from a stable prefix.
  const lastInvalidation: CacheInvalidationRecord | undefined = invalidation
    ? {
        seq: event.seq,
        reprocessedTokens: invalidation.reprocessedTokens,
        cause: state.compactionSeen
          ? 'compaction'
          : state.currentPromptPrefixHash !== state.lastTurnPromptPrefixHash
            ? 'system-changed'
            : 'history-changed',
      }
    : state.lastInvalidation
  return {
    seenEffectIds,
    // exactOptionalPropertyTypes rejects assigning `undefined` to an optional field directly --
    // these fields are carried forward via conditional spread so an unset hash stays an omitted
    // key rather than a key explicitly set to undefined, which is what the type actually promises.
    ...(state.currentPromptPrefixHash !== undefined
      ? { currentPromptPrefixHash: state.currentPromptPrefixHash }
      : {}),
    ...(state.currentPromptPrefixHash !== undefined
      ? { lastTurnPromptPrefixHash: state.currentPromptPrefixHash }
      : {}),
    compactionSeen: false,
    prevUsage: current,
    cumulativeCacheRead: state.cumulativeCacheRead + current.cacheRead,
    cumulativePromptTokens:
      state.cumulativePromptTokens + current.input + current.cacheRead + current.cacheWrite,
    ...(lastInvalidation ? { lastInvalidation } : {}),
  }
}

const KIND: Record<string, SurfaceNode['kind']> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool_result',
}

export function referenceApplyEvent(
  nodes: SurfaceNode[],
  e: Event,
  pins: Set<Seq>,
): { nodes: SurfaceNode[]; replaced: boolean } {
  const kind = KIND[e.type]
  if (!kind) return { nodes, replaced: false }
  if (typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace') {
    const { start, end } = e.surfaceOp
    const i = nodes.findIndex((n) => n.seq === start)
    const j = nodes.findIndex((n) => n.seq === end)
    // An unresolvable range is tolerated on a rebuild rather than fatal: the append path validated it
    // when it was written, so the fold's job here is to reproduce a history, not to re-adjudicate it.
    if (i === -1 || j === -1 || j < i) return { nodes, replaced: false }
    const summary: SurfaceNode = {
      seq: e.seq,
      kind: 'summary',
      event: e,
      pinned: false,
      masked: { start, end, sourceEventSeqs: e.sourceEventSeqs ?? [] },
    }
    // The summary takes the range's place, so an earlier summary caught inside the range is masked
    // along with everything else and the surface never carries two.
    return { nodes: [...nodes.slice(0, i), summary, ...nodes.slice(j + 1)], replaced: true }
  }
  return { nodes: [...nodes, { seq: e.seq, kind, event: e, pinned: pins.has(e.seq) }], replaced: false }
}

export function referenceComputeSurface(
  events: Iterable<Event>,
  opts: { lane?: string; upto?: Seq; pins?: Set<Seq> } = {},
): SurfaceNode[] {
  const lane = opts.lane ?? 'main'
  const pins = opts.pins ?? new Set<Seq>()
  let nodes: SurfaceNode[] = []
  for (const e of events) {
    if (opts.upto !== undefined && e.seq > opts.upto) break
    if ((e.lane ?? 'main') !== lane) continue
    nodes = referenceApplyEvent(nodes, e, pins).nodes
  }
  return nodes
}

/** A cache-health state as plain data, so two implementations can be compared row by row. */
export function plainCacheHealthState(state: CacheHealthState) {
  return {
    seenEffectIds: [...state.seenEffectIds],
    ...(state.currentPromptPrefixHash !== undefined
      ? { currentPromptPrefixHash: state.currentPromptPrefixHash }
      : {}),
    ...(state.lastTurnPromptPrefixHash !== undefined
      ? { lastTurnPromptPrefixHash: state.lastTurnPromptPrefixHash }
      : {}),
    compactionSeen: state.compactionSeen,
    ...(state.prevUsage ? { prevUsage: { ...state.prevUsage } } : {}),
    cumulativeCacheRead: state.cumulativeCacheRead,
    cumulativePromptTokens: state.cumulativePromptTokens,
    ...(state.lastInvalidation ? { lastInvalidation: { ...state.lastInvalidation } } : {}),
  }
}
