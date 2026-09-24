import type { SlotName } from '@agnes/protocol'

export type EscalationSignals = {
  consecutiveToolErrors: number
  verifierVerdict: 'pass' | 'needs_revision' | 'unknown'
  creditsRemaining: number | null
  currentSlot: SlotName
  escalationCostPerStep: number
}

/**
 * Pure rule (ai spec §8), one turn's worth of validity. Escalating means switching model slots,
 * which is a billing decision - core's Budget segment is what actually calls this, acts on the
 * verdict, and records it in op.state; this function only ever answers the question, never spends.
 */
export const Escalation = {
  decide(s: EscalationSignals): 'stay' | 'escalate' {
    if (s.currentSlot === 'escalation') return 'stay'
    const triggered = s.consecutiveToolErrors >= 2 || s.verifierVerdict === 'needs_revision'
    const affordable = s.creditsRemaining === null || s.creditsRemaining >= s.escalationCostPerStep
    return triggered && affordable ? 'escalate' : 'stay'
  },
}
