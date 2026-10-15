import type { Event } from '@agnes/core-common/types'
import type { SurfaceNode } from '@agnes/core-ledger/project/surface'
import { describe, expect, it } from 'vitest'
import { toMessage } from '../src/request/derive.js'
import { createEnvelopeCache } from '../src/request/envelope-cache.js'

const NONCE = '0123456789abcdef0123456789abcdef'
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

const node = (seq: number, text: string): SurfaceNode => ({
  seq,
  kind: 'user',
  pinned: false,
  event: {
    seq,
    ts: '2026-09-08T00:00:00.000Z',
    id: `node-${seq}`,
    type: 'user/message',
    data: { content: [{ type: 'text', text }] },
    actor,
    origin: 'principal',
    trust: 'untrusted',
    lane: 'main',
    v: 1,
  } as Event,
})

describe('envelope wrapping memo', () => {
  it('keeps different nonces for one node in separate entries', () => {
    const memo = createEnvelopeCache()
    memo.set('12\0first', ['first wrapping'])
    memo.set('12\0second', ['second wrapping'])
    expect(memo.get('12\0first')).toEqual(['first wrapping'])
    expect(memo.get('12\0second')).toEqual(['second wrapping'])
  })

  it('renders a loop-supplied node (non-positive seq) from its own text every time', () => {
    const memo = createEnvelopeCache()
    const first = toMessage(node(-1, 'state at step zero'), NONCE, memo)
    const second = toMessage(node(-1, 'state at step two'), NONCE, memo)
    expect(JSON.stringify(first)).toContain('state at step zero')
    expect(JSON.stringify(second)).toContain('state at step two')
    expect(JSON.stringify(second)).not.toContain('state at step zero')
    expect(memo.size).toBe(0)
  })

  it('treats seq 0 as synthetic too', () => {
    const memo = createEnvelopeCache()
    toMessage(node(0, 'first'), NONCE, memo)
    expect(JSON.stringify(toMessage(node(0, 'second'), NONCE, memo))).toContain('second')
    expect(memo.size).toBe(0)
  })

  it('still memoizes ledger nodes and reuses the first wrapping byte for byte', () => {
    const memo = createEnvelopeCache()
    const first = toMessage(node(12, 'ledger text'), NONCE, memo)
    expect(memo.size).toBe(1)
    const again = toMessage(node(12, 'ledger text'), NONCE, memo)
    expect(again).toEqual(first)
    expect(memo.size).toBe(1)
  })
})
