import { describe, expect, it } from 'vitest'
import { fakeSeamInit } from '../../../testkit/seam-init.js'
import { repairPolicy } from '../src/repair.js'

const pass = { verdict: 'pass' as const, reasons: [] }
const revise = { verdict: 'needs_revision' as const, reasons: ['no_progress:4'] }
describe('repair policy', () => {
  it('follows the round ladder: repair → escalate → park', async () => {
    const r = await repairPolicy(fakeSeamInit())
    expect(await r.decide({ turn: 1, round: 1, history: [] }, revise)).toBe('repair')
    expect(await r.decide({ turn: 1, round: 3, history: [] }, revise)).toBe('escalate')
    expect(await r.decide({ turn: 1, round: 5, history: [] }, revise)).toBe('park')
  })
  it('completes on pass unless the plan has open items (completion gate)', async () => {
    const r = await repairPolicy(
      fakeSeamInit({ preset: { completion_gate: { enabled: true, min_items: 2 } } }),
    )
    expect(await r.decide({ turn: 1, round: 1, history: [] }, pass)).toBe('complete')
    const view = {
      turn: 1,
      round: 1,
      history: [],
      plan: { items: [{ status: 'done' }, { status: 'pending' }] },
    }
    expect(await r.decide(view as never, pass)).toBe('repair')
    expect(await r.decide({ ...view, plan: { items: [{ status: 'pending' }] } } as never, pass)).toBe(
      'complete',
    ) // < min_items 不启用
  })
})
