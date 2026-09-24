import { describe, expect, it } from 'vitest'
import { claimOAuthNonce, openOAuthState, sealOAuthState } from '../src/oauth-state.js'

describe('oauth-state', () => {
  const secret = 'test-secret-32-bytes-minimum-xxxxxxxxxxxx'
  const payload = {
    serverId: 'srv-1',
    redirectUri: 'http://127.0.0.1:4177/oauth/srv-1/callback',
    codeVerifier: 'verifier-abc',
    nonce: 'nonce-1',
    issuedAt: Date.now(),
  }

  it('round-trips a valid state', async () => {
    const sealed = await sealOAuthState(payload, { secret })
    const opened = await openOAuthState(sealed, { secret, maxAgeMs: 60_000 })
    expect(opened).toEqual(payload)
  })

  it('rejects a tampered state', async () => {
    const sealed = await sealOAuthState(payload, { secret })
    const tampered = `${sealed.slice(0, -1)}${sealed.at(-1) === 'a' ? 'b' : 'a'}`
    await expect(openOAuthState(tampered, { secret, maxAgeMs: 60_000 })).rejects.toThrow()
  })

  it('rejects an expired state', async () => {
    const old = { ...payload, issuedAt: Date.now() - 120_000 }
    const sealed = await sealOAuthState(old, { secret })
    await expect(openOAuthState(sealed, { secret, maxAgeMs: 60_000 })).rejects.toThrow()
  })

  it('rejects a replayed nonce on the second claim', async () => {
    const first = await claimOAuthNonce('nonce-x', Date.now() + 60_000)
    const second = await claimOAuthNonce('nonce-x', Date.now() + 60_000)
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  it('rejects a state signed with a different secret', async () => {
    const sealed = await sealOAuthState(payload, { secret })
    await expect(
      openOAuthState(sealed, { secret: 'a-completely-different-secret-value', maxAgeMs: 60_000 }),
    ).rejects.toThrow()
  })

  it('rejects malformed sealed input (no separator)', async () => {
    await expect(openOAuthState('not-a-sealed-state', { secret, maxAgeMs: 60_000 })).rejects.toThrow()
  })

  it('rejects a truncated signature with the same generic message, not a raw crypto error', async () => {
    // timingSafeEqual throws RangeError on mismatched buffer lengths rather than returning false;
    // a signature shortened by a few chars exercises that length-mismatch path directly and must
    // still surface as the one generic error, never Node's own "Input buffers must have the same
    // byte length" message.
    const sealed = await sealOAuthState(payload, { secret })
    const dot = sealed.lastIndexOf('.')
    const truncated = `${sealed.slice(0, dot + 1)}${sealed.slice(dot + 1, -4)}`
    await expect(openOAuthState(truncated, { secret, maxAgeMs: 60_000 })).rejects.toThrow(
      'invalid or expired oauth state',
    )
  })

  it('error message does not leak the secret or verification details', async () => {
    const sealed = await sealOAuthState(payload, { secret })
    const tampered = `${sealed.slice(0, -1)}${sealed.at(-1) === 'a' ? 'b' : 'a'}`
    try {
      await openOAuthState(tampered, { secret, maxAgeMs: 60_000 })
      throw new Error('expected openOAuthState to throw')
    } catch (err) {
      const message = (err as Error).message
      expect(message).toBe('invalid or expired oauth state')
      expect(message).not.toContain(secret)
    }
  })

  it('accepts a state comfortably within maxAgeMs and rejects one that has clearly exceeded it', async () => {
    const now = Date.now()
    // Margins (900ms clearance either side of the 60s cutoff) are deliberately wide, not exactly
    // on the millisecond edge: `Date.now() - issuedAt > maxAgeMs` compares against wall-clock time
    // taken *inside* openOAuthState, so a razor-thin margin (e.g. exactly 60_000) is inherently
    // racy under CI scheduling jitter. A wide margin still exercises both sides of the cutoff
    // deterministically without depending on sub-millisecond timing.
    const fresh = { ...payload, issuedAt: now - 59_100 }
    const sealedFresh = await sealOAuthState(fresh, { secret })
    await expect(openOAuthState(sealedFresh, { secret, maxAgeMs: 60_000 })).resolves.toEqual(fresh)

    const stale = { ...payload, issuedAt: now - 60_900 }
    const sealedStale = await sealOAuthState(stale, { secret })
    await expect(openOAuthState(sealedStale, { secret, maxAgeMs: 60_000 })).rejects.toThrow()
  })

  it('claimOAuthNonce treats distinct nonces independently', async () => {
    const a = await claimOAuthNonce('nonce-distinct-a', Date.now() + 60_000)
    const b = await claimOAuthNonce('nonce-distinct-b', Date.now() + 60_000)
    expect(a).toBe(true)
    expect(b).toBe(true)
  })
})
