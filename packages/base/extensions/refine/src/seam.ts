import type { HarnessSeam } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'
import { KINDS, RefineQueue } from './queue.js'

/**
 * `harness` seam: the bounded intake for self-modification proposals (prompt/memory/skill/subagent
 * edits). `p` is typed through the real, imported `HarnessSeam['propose']` parameter
 * (`RefineProposal`, core/src/effects/seams.ts:137-148) rather than restated locally, so this
 * function accepts every real trigger value - including 'rollback' - without any narrowing.
 */
export const refineHarness: SeamFactory<HarnessSeam> = async (ctx) => {
  const max = (ctx.profile.preset.harness as { queue_max?: number } | undefined)?.queue_max ?? 20
  const q = new RefineQueue(ctx.adapters.storage.table('refine_queue'))
  return createRefineHarness(q, max)
}

/** Shared intake used by both the fitted seam and the trusted ecosystem tool assembly. */
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
