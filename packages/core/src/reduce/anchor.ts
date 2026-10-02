import type { Event, Seq } from '../types.js'
import type { CostLedger } from './shapes.js'

/** A measured (or, after a compaction, estimated) context size and where in the ledger it was taken. */
export type ContextAnchor = { seq: Seq; total: number; cacheRead: number; input: number }

/**
 * The row, if any, that fixes the context size the next request starts from. Only a main inference
 * request reports that: a title, guardian, media or compaction request carries a different
 * conversation, and a compaction that fails writes an all-zero row. What a compaction leaves behind
 * is anchored instead by its own end row, as an estimate with a cold cache. Kept in one place so the
 * ledger fold, the UI projection and the bounded usage projection cannot drift apart.
 */
export function contextAnchorOf(event: Pick<Event, 'seq' | 'type' | 'data'>): ContextAnchor | undefined {
  if (event.type === 'x/core/compaction-end') {
    const after = (event.data as { tokensAfter?: unknown } | null)?.tokensAfter
    return typeof after === 'number' && Number.isSafeInteger(after) && after >= 0
      ? { seq: event.seq, total: after, cacheRead: 0, input: after }
      : undefined
  }
  if (event.type !== 'cost/ledger') return undefined
  const row = event.data as CostLedger
  if (row.purpose !== 'inference' || row.interrupted || row.adjustment) return undefined
  const { input, output, cacheRead, cacheWrite } = row.tokens
  return { seq: event.seq, total: input + output + cacheRead + cacheWrite, cacheRead, input }
}
