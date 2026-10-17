import { describe, expect, it } from 'vitest'
import { emptyCounters } from '../src/state.js'
import { emitEvent, STEP_EVENT_BUDGET } from '../src/telemetry.js'

describe('telemetry', () => {
  it('caps per-step events at 150 per turn and always tries metrics', async () => {
    const sent: string[] = []
    const counters = emptyCounters()
    const events = { emit: async (name: string) => void sent.push(name) }
    for (let i = 0; i < STEP_EVENT_BUDGET + 5; i++) await emitEvent(events, counters, 'jev.step', { step: i })
    await emitEvent(events, counters, 'jev.metrics', {})
    expect(sent.filter((n) => n === 'jev.step')).toHaveLength(150)
    expect(sent.at(-1)).toBe('jev.metrics')
    expect(counters.droppedEvents).toBe(5)
  })
  it('swallows emit failures as dropped events', async () => {
    const counters = emptyCounters()
    await emitEvent(
      {
        emit: async () => {
          throw Object.assign(new Error('quota'), { code: 'E_ENVELOPE' })
        },
      },
      counters,
      'jev.decide',
      {},
    )
    expect(counters.droppedEvents).toBe(1)
    expect(counters.emitted).toBe(0)
  })
})
