import { readPreset } from '@agnes/core'
import { actor, fakeProvider, fakeSeams, openSession, textTurn } from '@agnes/core/testkit'
import type { PlanItem } from '@agnes/extension-api'
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
      plan: { items: planItems(2) },
    }
    expect(await r.decide(view, pass)).toBe('repair')
    expect(await r.decide({ ...view, plan: { items: planItems(1) } }, pass)).toBe('complete') // < min_items 不启用
  })
})

const planItems = (n: number): PlanItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i),
    text: `requirement ${i}`,
    status: i === 0 ? 'done' : 'todo',
  }))

describe('completion gate through the real turn stop path', () => {
  const input = { actor, content: [{ type: 'text' as const, text: 'complete the request' }] }
  const run = (h: Awaited<ReturnType<typeof openSession>>) =>
    h.session.run({ until: 'turn-end', signal: new AbortController().signal })
  async function setup(n: number, enabled = true, clock?: () => number) {
    const doc = { completion_gate: { enabled } }
    const repair = await repairPolicy(fakeSeamInit({ preset: doc }))
    const provider = fakeProvider([textTurn('checked result'), textTurn('reviewed result')])
    const h = await openSession({
      provider,
      preset: readPreset(doc, 'trial'),
      seams: fakeSeams({ repair }),
      ...(clock ? { clock } : {}),
    })
    return {
      ...h,
      provider,
      seed: async () => {
        await h.session.acceptInput()
        if (n)
          await h.session.append([
            h.session.ev('plan.items', { items: planItems(n) }, { register: 'plan.items' }),
          ])
      },
    }
  }
  it.each([
    [0, true, 1],
    [2, true, 1],
    [3, false, 1],
    [3, true, 2],
    [5, true, 2],
  ] as const)(
    'plan=%i enabled=%s uses %i model rounds and completes despite a stale plan',
    async (n, enabled, rounds) => {
      const h = await setup(n, enabled)
      try {
        await h.session.enqueue('next-turn', input)
        await h.seed()
        expect((await run(h)).reason).toBe('completed')
        expect(h.provider.requests).toHaveLength(rounds)
        const decisions = await h.log.scan({ type: 'repair/decision', limit: 10 })
        expect(decisions.map((e) => (e.data as { decision: string }).decision)).toEqual(
          rounds === 2 ? ['repair', 'complete'] : [],
        )
        const audits = await h.log.scan({ type: 'x/core/verifier-recovery', limit: 10 })
        if (rounds === 2) {
          expect(audits.at(-1)?.data).toMatchObject({
            diagnostic: 'completion_gate_stale_plan',
            openItems: n - 1,
          })
          expect(JSON.stringify(h.provider.requests[1]?.messages)).toContain('Update the plan accurately')
        } else expect(audits).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )
  it.each(['aborted', 'max_steps', 'budget', 'timeout'] as const)(
    'keeps %s authoritative during review (time expiry is delivered by client cancellation)',
    async (reason) => {
      let now = 1_757_203_200_000
      const h = await setup(3, true, () => now)
      try {
        await h.session.enqueue('next-turn', { ...input, timeLimitMs: 100_000 })
        await h.seed()
        for (let i = 0; i < 20; i++) {
          await h.session.step()
          if ((await h.log.scan({ type: 'repair/decision', limit: 1 })).length) break
        }
        expect((await h.log.scan({ type: 'repair/decision', limit: 1 }))[0]?.data).toMatchObject({
          decision: 'repair',
        })
        if (reason === 'aborted') await h.session.abort()
        if (reason === 'max_steps') h.session.preset.budget.maxSteps = 1
        if (reason === 'budget') {
          h.session.preset.budget.perRequestCap = 0
          h.session.preset.budget.onExceed = 'deny'
        }
        if (reason === 'timeout') {
          now += 100_001
          await h.session.abort()
        }
        expect((await run(h)).reason).toBe(reason === 'timeout' ? 'aborted' : reason)
        expect(h.provider.requests).toHaveLength(1)
      } finally {
        await h.session.close()
      }
    },
  )
  it('completes an already finished plan without another review', async () => {
    const h = await setup(3)
    try {
      await h.session.enqueue('next-turn', input)
      await h.seed()
      await h.session.append([
        h.session.ev(
          'plan.items',
          { items: planItems(3).map((item) => ({ ...item, status: 'done' })) },
          { register: 'plan.items' },
        ),
      ])
      expect((await run(h)).reason).toBe('completed')
      expect(h.provider.requests).toHaveLength(1)
      expect(await h.log.scan({ type: 'repair/decision', limit: 1 })).toEqual([])
    } finally {
      await h.session.close()
    }
  })
})
