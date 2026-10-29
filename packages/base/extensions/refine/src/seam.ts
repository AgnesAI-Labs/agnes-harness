import type { HarnessSeam } from '@agnes/core'
import { KINDS, type RefineQueue } from './queue.js'

/** The bounded intake for self-modification proposals (prompt/memory/skill/subagent edits). */
export function createRefineHarness(q: RefineQueue, max: number): HarnessSeam {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new Error('harness.queue_max must be a non-negative integer')
  return {
    async propose(p) {
      const kinds = p.edits.map((e) => (e.op === 'upsert' ? e.entry.kind : e.kind))
      if (kinds.some((k) => !KINDS.has(k))) return 'rejected'
      if (q.queuedCount() >= max) return 'rejected'
      q.push(p)
      return 'queued'
    },
  }
}
