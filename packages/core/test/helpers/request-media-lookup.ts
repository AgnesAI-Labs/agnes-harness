import type { RequestMediaToolCallLookup } from '../../src/orchestrator/request-media-surface.js'
import type { Event } from '../../src/types.js'

export type CountingToolCallLookup = RequestMediaToolCallLookup & {
  /** Every seq list the lookup was asked for, in call order. */
  readonly calls: number[][]
}

/**
 * Turns a fixed ledger array into the point-lookup port the first-send media path expects: only
 * `tool/call` rows at the requested seqs come back, exactly as the session's per-seq scan returns.
 */
export function toolCallLookup(events: readonly Event[]): CountingToolCallLookup {
  const calls: number[][] = []
  const lookup = async (seqs: readonly number[]) => {
    calls.push([...seqs])
    const wanted = new Set(seqs)
    return events.filter((event) => event.type === 'tool/call' && wanted.has(event.seq))
  }
  return Object.assign(lookup, { calls })
}
