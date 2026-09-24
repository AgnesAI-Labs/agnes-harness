import type { CostLedger, RequestHeader } from '@agnes/protocol'
import { ChunkedSet } from '../reduce/chunked-map.js'
import type { Event, Seq } from '../types.js'

/**
 * Below this many prompt tokens, a provider's cache-read gap is noise rather than signal: trivial
 * exchanges routinely report zero cache activity in both directions, and treating that as either a
 * hit-rate data point or an invalidation would swamp real numbers with tiny-context churn. Tuned
 * for a comparable token scale; validation across real sessions (e.g., DeepSeek) confirms this
 * threshold's effectiveness in filtering noise while preserving signal.
 */
const MIN_CACHE_FOOTPRINT = 2048

export type CacheInvalidationCause = 'compaction' | 'system-changed' | 'history-changed'

export type CacheInvalidationRecord = {
  seq: Seq
  reprocessedTokens: number
  cause: CacheInvalidationCause
}

export type CacheHealthState = {
  seenEffectIds: ChunkedSet<string>
  currentPromptPrefixHash?: string
  lastTurnPromptPrefixHash?: string
  compactionSeen: boolean
  prevUsage?: { input: number; cacheRead: number; cacheWrite: number }
  cumulativeCacheRead: number
  cumulativePromptTokens: number
  lastInvalidation?: CacheInvalidationRecord
}

export function initialCacheHealthState(): CacheHealthState {
  return {
    seenEffectIds: ChunkedSet.empty(),
    compactionSeen: false,
    cumulativeCacheRead: 0,
    cumulativePromptTokens: 0,
  }
}

export type CacheHealthView = { hitRate?: number; lastInvalidation?: CacheInvalidationRecord }

export function cacheHealthView(state: CacheHealthState): CacheHealthView {
  return {
    ...(state.cumulativePromptTokens > 0
      ? { hitRate: state.cumulativeCacheRead / state.cumulativePromptTokens }
      : {}),
    ...(state.lastInvalidation ? { lastInvalidation: state.lastInvalidation } : {}),
  }
}

/**
 * Detects cache invalidation by comparing token usage across turns. Implicit-cache providers
 * (DeepSeek, Qwen) never report cache writes, so we don't require cacheWrite > 0 like
 * explicit-breakpoint providers (Anthropic/Bedrock) do. This allows the detector to fire for
 * all providers. We rely instead on compaction/system-prefix cause signals computed around
 * this call to filter false positives and maintain signal integrity.
 */
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

/** Self-contained: handles its own lane filter and session/start fork-boundary reset, exactly like
 * the totals accumulation it sits beside in `projectUsage` and `UIProjectionCell`. */
export function applyCacheHealthEvent(state: CacheHealthState, event: Event, lane: string): CacheHealthState {
  if (event.type === 'session/start' && (event.data as { parent?: unknown } | null)?.parent)
    return initialCacheHealthState()
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
  // The set only grows for the life of the session, so adding copies one chunk, not every id seen.
  const seenEffectIds = state.seenEffectIds.add(row.effectId)
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
