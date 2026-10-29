import { describe, expect, it } from 'vitest'
import { renderTimeContext, timeProjection } from '../src/index.js'

describe('default time context', () => {
  it('renders the configured zone and preceding-turn elapsed, including first turn and backward clocks', () => {
    expect(renderTimeContext(1700000000000, 'Asia/Shanghai', 1699999940000)).toContain('60 seconds')
    expect(renderTimeContext(1700000000000, 'Asia/Shanghai', null)).toContain('first turn')
    expect(renderTimeContext(1700000000000, 'UTC', 1700000000001)).toContain('0 seconds')
    expect(renderTimeContext(1700000000000, 'Asia/Shanghai', null)).toContain('Time zone: Asia/Shanghai')
  })
  it('reconstructs the reading and elapsed anchor from durable events', () => {
    const apply = (state: ReturnType<typeof timeProjection.init>, type: string, ts: string, data: object) =>
      timeProjection.apply(state, { type, ts, data } as unknown as Parameters<typeof timeProjection.apply>[1])
    const first = apply(timeProjection.init(), 'turn/start', '2023-11-14T22:13:20.000Z', { turn: 1 })
    expect(first).toMatchObject({ sampledAt: 1700000000000, precedingTurnAt: null })
    const parked = apply(first, 'turn/end', '2023-11-14T22:14:00.000Z', { reason: 'parked' })
    expect(parked).toEqual(first)
    const continued = apply(parked, 'turn/start', '2023-11-14T22:14:05.000Z', {
      turn: 2,
      continues: { turn: 1 },
    })
    expect(continued).toEqual({ ...first, turn: 2 })
    const ended = apply(continued, 'turn/end', '2023-11-14T22:14:20.000Z', { reason: 'completed' })
    expect(ended.endedAt).toBe(1700000060000)
    expect(apply(ended, 'turn/start', '2023-11-14T22:15:20.000Z', { turn: 3 })).toMatchObject({
      sampledAt: 1700000120000,
      precedingTurnAt: 1700000060000,
    })
  })
})
