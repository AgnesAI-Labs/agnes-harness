import { ULID_PATTERN } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'

describe('ids', () => {
  it('mints ULIDs that match protocol pattern and are monotonic within a ms', () => {
    let now = Date.parse('2026-09-07T00:00:00.000Z')
    const ids = defaultIds(() => now)
    const a = ids.ulid()
    const b = ids.ulid()
    expect(a).toMatch(ULID_PATTERN)
    expect(b).toMatch(ULID_PATTERN)
    expect(b > a).toBe(true)
    now += 1
    expect(ids.ulid() > b).toBe(true)
  })
  it('mints tool use ids as ordinal + uuid-like suffix', () => {
    const ids = defaultIds()
    expect(ids.toolUseId(3)).toMatch(/^t3-[0-9a-f]{32}$/)
    expect(ids.effectId()).toMatch(/^e-[0-9a-f]{32}$/)
    expect(ids.requestId()).toMatch(/^r-[0-9a-f]{32}$/)
    // 32 hex characters, because NONCE_PATTERN in request/derive.ts admits 32 to 64 and rejects
    // anything shorter at the point it is stamped into an envelope.
    expect(ids.nonce()).toMatch(/^[0-9a-f]{32}$/)
  })
})
