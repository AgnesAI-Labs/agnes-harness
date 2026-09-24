import { describe, expect, it } from 'vitest'
import { FoldCache } from '../src/project/cache.js'
import { foldEvents } from '../src/reduce/reducer.js'
import type { Event } from '../src/types.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const event = (seq: number): Event =>
  ({
    seq,
    ts: '2026-09-07T00:00:00Z',
    id: `01K4A0000000000000000${String(seq).padStart(5, '0')}`,
    type: 'user/message',
    data: { content: [{ type: 'text', text: `q${seq}` }] },
    actor,
    origin: 'principal',
    trust: 'trusted',
    lane: 'main',
    v: 1,
  }) as Event

describe('FoldCache', () => {
  it('requests a write on either the event-count or elapsed-time boundary', () => {
    let now = 1_000
    const cache = new FoldCache({ clock: () => now })
    expect(cache.shouldWrite(199)).toBe(false)
    expect(cache.shouldWrite(200)).toBe(true)

    const state = foldEvents([event(200)])
    cache.set(200, state)
    expect(cache.shouldWrite(399)).toBe(false)
    now += 4_999
    expect(cache.shouldWrite(399)).toBe(false)
    now += 1
    expect(cache.shouldWrite(399)).toBe(true)
  })

  it('uses caller-provided throttles and resets both boundaries after set', () => {
    let now = 0
    const cache = new FoldCache({ writeEvery: 3, writeAfterMs: 10, clock: () => now })
    cache.set(8, foldEvents([event(8)]))
    expect(cache.shouldWrite(10)).toBe(false)
    expect(cache.shouldWrite(11)).toBe(true)
    cache.set(11, foldEvents([event(11)]))
    now = 9
    expect(cache.shouldWrite(13)).toBe(false)
    now = 10
    expect(cache.shouldWrite(13)).toBe(true)
  })

  it('refuses a cache line whose cursor and folded state disagree', () => {
    const cache = new FoldCache({ clock: () => 0 })
    expect(() => cache.set(9, foldEvents([event(8)]))).toThrow('fold cache seq does not match state')
  })
})
