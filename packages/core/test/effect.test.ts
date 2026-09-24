import { describe, expect, it } from 'vitest'
import { EffectRuntime, effectOutcome } from '../src/effects/effect.js'
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
})
