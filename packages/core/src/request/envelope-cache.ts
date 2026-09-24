import type { SurfaceNode } from '../project/surface.js'
import type { Seq } from '../types.js'

/**
 * Wrapped envelope text, one entry per untrusted surface node, keyed by the node's own seq. A
 * node's underlying content is immutable once appended, so once this cache holds an entry the
 * exact bytes a provider saw for that node never change again — which is the whole of what keeps
 * history byte identical from one turn's derivation to the next, regardless of which turn's nonce
 * is live when the derivation runs.
 *
 * Each value is the ordered list of wrapped strings `toMessage` produced for that node's untrusted
 * blocks, in the order it visited them — not one string, because a user message can carry more
 * than one wrapped block and each gets its own id (see `wrapUntrusted`'s `block` parameter).
 */
export type EnvelopeCache = Map<Seq, readonly string[]>

export function createEnvelopeCache(): EnvelopeCache {
  return new Map()
}

/**
 * Drops entries for seqs no longer on the given surface. Callers must only pass a `turn`-kind
 * derivation's surface here, never a `summary`-kind one: a summary derivation's surface is a
 * sub-range of the session's history, and pruning against it would evict cached wrappings for
 * history outside that range that the very next ordinary turn still needs.
 */
export function pruneEnvelopeCache(cache: EnvelopeCache, surface: readonly SurfaceNode[]): void {
  const live = new Set(surface.map((n) => n.seq))
  for (const seq of cache.keys()) if (!live.has(seq)) cache.delete(seq)
}
