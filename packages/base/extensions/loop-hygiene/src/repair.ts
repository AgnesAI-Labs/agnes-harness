import type { RepairSeam } from '@agnes/core'
import type { SeamFactory } from '../../../src/seam-init.js'

/**
 * The round ladder plus a completion gate. The ladder alone would let a verifier's `pass` end a
 * turn with an open plan sitting underneath it; the gate is what keeps a pass from completing while
 * items remain, tracked separately from the ladder so a `needs_revision`/`fail` history never has to
 * carry plan state through rounds that never look at it.
 */
export const repairPolicy: SeamFactory<RepairSeam> = async (ctx) => {
  const rp = (ctx.profile.preset.repair ?? {}) as { max_rounds?: number; escalate_after?: number }
  const gate = (ctx.profile.preset.completion_gate ?? {}) as { enabled?: boolean; min_items?: number }
  const maxRounds = rp.max_rounds ?? 5
  const escalateAfter = rp.escalate_after ?? 3
  return {
    async decide(view, verdict) {
      if (view.round >= maxRounds) return 'park'
      if (verdict.verdict === 'pass') {
        const plan = (view as { plan?: { items: Array<{ status: string }> } }).plan
        const open = plan?.items.some((i) => i.status !== 'done') ?? false
        // min_items guards against a gate that fires on a plan too small to say anything: a
        // one-item plan pending is not the same signal as a five-item plan half-open.
        if ((gate.enabled ?? true) && plan && plan.items.length >= (gate.min_items ?? 3) && open)
          return 'repair'
        return 'complete'
      }
      return view.round >= escalateAfter ? 'escalate' : 'repair'
    },
  }
}
