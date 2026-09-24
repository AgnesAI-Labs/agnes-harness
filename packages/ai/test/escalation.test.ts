import { describe, expect, it } from 'vitest'
import { Escalation } from '../src/index.js'

const base = {
  consecutiveToolErrors: 0,
  verifierVerdict: 'unknown' as const,
  creditsRemaining: 1000,
  currentSlot: 'primary' as const,
  escalationCostPerStep: 50,
}

describe('Escalation.decide', () => {
  it.each([
    [{}, 'stay'],
    [{ consecutiveToolErrors: 1 }, 'stay'],
    [{ consecutiveToolErrors: 2 }, 'escalate'],
    [{ verifierVerdict: 'needs_revision' }, 'escalate'],
    [{ verifierVerdict: 'needs_revision', creditsRemaining: 10 }, 'stay'],
    [{ consecutiveToolErrors: 3, creditsRemaining: null }, 'escalate'],
    [{ consecutiveToolErrors: 3, currentSlot: 'escalation' }, 'stay'],
  ] as const)('%o → %s', (over, want) => {
    expect(Escalation.decide({ ...base, ...over })).toBe(want)
  })
})
