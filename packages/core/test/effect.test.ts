import { describe, expect, it } from 'vitest'
import { EffectRuntime, effectOutcome } from '../src/effects/effect.js'
import { defaultIds } from '../src/ids.js'
import { prepareEvents } from '../src/log/validate.js'
import type { EventInput } from '../src/types.js'

describe('effect outcomes', () => {
  it('uses the safety precedence unknown, aborted, error, ok', () => {
    expect(effectOutcome({ unknown: true, aborted: true, failed: true })).toBe('unknown')
    expect(effectOutcome({ aborted: true, failed: true })).toBe('aborted')
    expect(effectOutcome({ failed: true })).toBe('error')
    expect(effectOutcome({})).toBe('ok')
  })

  it('records unknown as a first-class settlement outcome', () => {
    let now = 10
    const runtime = new EffectRuntime({
      clock: () => now,
      effectId: () => 'effect-1',
      ev: (type, data) => ({
        type,
        data: data as EventInput['data'],
        actor: { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} },
        origin: 'system',
        trust: 'trusted',
      }),
    })

    const effect = runtime.start({ kind: 'tool' })
    now = 17

    expect(effect.settle('unknown')).toMatchObject({
      type: 'effect/settled',
      data: { effectId: 'effect-1', outcome: 'unknown', durationMs: 7 },
    })
  })

  const actor = { id: 'system', org: 'local', role: 'system', deptPath: [], attrs: {} }
  const settle = (start: number, end: number) => {
    let now = start
    const runtime = new EffectRuntime({
      clock: () => now,
      effectId: () => 'effect-1',
      ev: (type, data) => ({
        type,
        data: data as EventInput['data'],
        actor,
        origin: 'system',
        trust: 'trusted',
      }),
    })
    const effect = runtime.start({ kind: 'inference' })
    now = end
    return effect.settle('ok')
  }

  it.each([
    ['moves forward', 1_000, 1_450, 450],
    ['does not move', 1_000, 1_000, 0],
    ['steps back by a few seconds', 1_760_000_005_173, 1_760_000_000_000, 0],
    ['steps back by a single millisecond', 1_000, 999, 0],
    ['moves forward by a fraction', 1_000, 1_000.6, 1],
    ['steps back by a fraction', 1_000, 999.4, 0],
  ])('records a whole, non-negative duration when the clock %s', (_name, start, end, expected) => {
    const row = settle(start, end)
    expect((row.data as { durationMs: number }).durationMs).toBe(expected)
    expect(Number.isInteger((row.data as { durationMs: number }).durationMs)).toBe(true)
  })

  it('stays valid as a ledger row when the clock stepped back, so the batch is not rejected', () => {
    const at = Date.parse('2026-10-09T06:37:00.000Z')
    const row = settle(at + 5_173, at - 6_300)
    const ctx = { ids: defaultIds(() => at), clock: () => at, refineCaller: false }
    const [prepared] = prepareEvents([row], ctx)
    expect(prepared).toMatchObject({ type: 'effect/settled', data: { effectId: 'effect-1', durationMs: 0 } })
  })
})
