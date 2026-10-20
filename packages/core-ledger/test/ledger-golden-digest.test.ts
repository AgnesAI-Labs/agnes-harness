// Ledger digests pinned to the values the pure-JS digest and the whole-string serializer produced
// before `node:crypto` and the chunked serializer; computed once with that build and written here.
// The portable re-run imports this file too, so both implementations must reproduce them.

import type { Event, SessionKey } from '@agnes/core-common/types'
import { describe, expect, it } from 'vitest'
import { type IntegrityState, prepareIntegrity, verifyIntegrityRows } from '../src/log/integrity.js'

const key = 'golden-session' as SessionKey
const events = [
  { seq: 1, type: 'user/message', data: { text: 'hello, ledger "quoted" \\ back\nslash\t\u0001' } },
  { seq: 2, type: 'assistant/message', data: { text: '你好，世界。账本摘要必须逐字节相同。' } },
  { seq: 3, type: 'user/message', data: { text: '😀𝄞🀄 astral', keys: { '😀': 1, a: 2, \ufb33: 3 } } },
  {
    seq: 4,
    type: 'user/message',
    data: { content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD'.repeat(17_500) }] },
  },
] as unknown as Event[]

const GOLDEN = [
  'a05da70f6638db0975dc2465cf16b42aae15ceab2bd8b33339b6fa81cab526f3',
  '9b0aa609f749f0d4148429eb5d081361ebbc5e58d2760cfa51f02ef36d5b05b8',
  '3755867f0f1f4ac7fd9c05265ae73928382e96d2660847a3b2d2bd3c8d7db337',
  '377b13f25de035ae7796bf4542a70bb3171b2159ea6d576eb129b8b8be68fb0a',
]
/** Events 3 and 4 renumbered 8 and 9 behind seven legacy rows: the anchor commits to that boundary. */
const GOLDEN_AFTER_LEGACY = [
  '1a02852cca5130bc5c5972cf58b4c9e162398b45058d320f5f0f3b2e5ee6182f',
  '85e4d5616d917434865dcde00e97225e58b899ff2dfaba1f7bedd8b3b0a1e2ca',
]

const stamped = (list: readonly Event[], digests: readonly string[]) =>
  list.map((event, i) => ({
    sessionKey: key,
    event,
    integrity: {
      mode: i === 0 ? ('anchor' as const) : ('chain' as const),
      previousDigest: i === 0 ? null : (digests[i - 1] as string),
      digest: digests[i] as string,
    },
  }))

describe('pinned ledger digests', () => {
  it('reproduces the anchor and chain digests for ASCII, CJK, astral and 70,000-character events', () => {
    const initial: IntegrityState = { lastSeq: 0, legacyThroughSeq: 0, headDigest: null }
    const prepared = prepareIntegrity(key, events, initial)
    expect(prepared.entries.map((entry) => [entry.mode, entry.digest])).toEqual(
      GOLDEN.map((digest, i) => [i === 0 ? 'anchor' : 'chain', digest]),
    )
    expect(prepared.canonicalBytes).toBe(71_006)
    expect(verifyIntegrityRows(stamped(events, GOLDEN), initial).headDigest).toBe(GOLDEN[3])
  })

  it('reproduces an anchor that follows legacy rows', () => {
    const initial: IntegrityState = { lastSeq: 7, legacyThroughSeq: 7, headDigest: null }
    const later = events.slice(2).map((event, i) => ({ ...event, seq: 8 + i }))
    const prepared = prepareIntegrity(key, later, initial)
    expect(prepared.entries.map((entry) => entry.digest)).toEqual(GOLDEN_AFTER_LEGACY)
    expect(prepared.canonicalBytes).toBe(70_470)
    expect(verifyIntegrityRows(stamped(later, GOLDEN_AFTER_LEGACY), initial).lastSeq).toBe(9)
  })

  it('rejects a pinned row whose event changed by one character', () => {
    const tampered = events.map((event, i) =>
      i === 1
        ? ({ ...event, data: { text: '你好，世界。账本摘要必须逐字节相同！' } } as unknown as Event)
        : event,
    )
    expect(() => verifyIntegrityRows(stamped(tampered, GOLDEN))).toThrow('ledger digest mismatch')
  })
})
