import { describe, expect, it } from 'vitest'
import { type MetaState, stampMeta } from '../src/local/meta.js'

const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const ev = (seq: number, type: string, data: unknown) =>
  ({
    seq,
    ts: '2026-09-07T00:00:00Z',
    id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
    type,
    data,
    actor,
    origin: 'system',
    trust: 'trusted',
    lane: 'main',
  }) as never

describe('stampMeta', () => {
  it('derives promptTurnId from turn/start and phases from message / end', () => {
    let st: MetaState = { promptTurnId: null, generation: 3 }
    let r = stampMeta(ev(10, 'turn/start', { turn: 1, trigger: 'prompt' }), st)
    st = r.next
    expect(r.meta).toMatchObject({
      promptTurnId: '10',
      eventSequence: 10,
      generation: 3,
      lane: 'main',
      phase: 'event',
    })
    r = stampMeta(ev(11, 'assistant/message', { content: [], stopReason: 'end_turn' }), st)
    st = r.next
    expect(r.meta.phase).toBe('responseBoundary')
    r = stampMeta(ev(12, 'cost/ledger', { credits: 5, creditSource: 'estimated' }), st)
    st = r.next
    expect(r.meta.credits).toEqual({ used: 5, source: 'estimated' })
    r = stampMeta(ev(13, 'turn/end', { reason: 'completed', lastAssistantSeq: 11 }), st)
    expect(r.meta).toMatchObject({ phase: 'terminalQuiescence', turnEnd: { reason: 'completed' } })
  })

  it('marks parked turn/end as parked phase', () => {
    const r = stampMeta(ev(9, 'turn/end', { reason: 'parked', lastAssistantSeq: null }), {
      promptTurnId: '1',
      generation: 1,
    })
    expect(r.meta.phase).toBe('parked')
  })

  it('carries the last credits onto later events and reads the gateway source', () => {
    let st: MetaState = { promptTurnId: '1', generation: 1 }
    st = stampMeta(ev(2, 'cost/ledger', { credits: 7, creditSource: 'gateway' }), st).next
    const later = stampMeta(ev(3, 'step/start', { step: 1 }), st)
    expect(later.meta.credits).toEqual({ used: 7, source: 'gateway' })
    expect(later.meta.phase).toBe('event')
  })

  it('omits credits and turnEnd entirely until something sets them', () => {
    const r = stampMeta(ev(4, 'step/end', { step: 1 }), { promptTurnId: null, generation: 2 })
    expect('credits' in r.meta).toBe(false)
    expect('turnEnd' in r.meta).toBe(false)
    // No turn/start has been seen on this connection yet, so there is no turn to name.
    expect(r.meta.promptTurnId).toBe('0')
  })

  it('leaves the caller state untouched: stampMeta returns the next state rather than mutating', () => {
    const st: MetaState = { promptTurnId: null, generation: 1 }
    const r = stampMeta(ev(5, 'turn/start', { turn: 1, trigger: 'prompt' }), st)
    expect(st.promptTurnId).toBeNull()
    expect(r.next.promptTurnId).toBe('5')
  })

  it('a cost/ledger without a numeric credits field does not clear what was already known', () => {
    let st: MetaState = { promptTurnId: '1', generation: 1 }
    st = stampMeta(ev(6, 'cost/ledger', { credits: 2, creditSource: 'estimated' }), st).next
    const r = stampMeta(ev(7, 'cost/ledger', { creditSource: 'estimated' }), st)
    expect(r.meta.credits).toEqual({ used: 2, source: 'estimated' })
  })
})
