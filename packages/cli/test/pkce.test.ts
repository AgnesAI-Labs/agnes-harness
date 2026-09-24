import { describe, expect, it, vi } from 'vitest'
import {
  AGNES_AUTHORIZATION_ORIGIN,
  openAgnesAuthorizationUrl,
  openAuthorizationUrl,
} from '../src/onboarding/browser.js'
import { createPkcePair, derivePkceChallenge, generateAuthorizationState } from '../src/onboarding/pkce.js'

describe('PKCE S256', () => {
  it('matches the fixed RFC 7636 Appendix B vector', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(derivePkceChallenge(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('creates independent CSPRNG-shaped verifier and state values', () => {
    const pairs = Array.from({ length: 16 }, () => createPkcePair())
    const states = Array.from({ length: 16 }, () => generateAuthorizationState())

    for (const pair of pairs) {
      expect(pair.method).toBe('S256')
      expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(pair.challenge).toBe(derivePkceChallenge(pair.verifier))
    }
    for (const state of states) expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new Set(pairs.map(({ verifier }) => verifier))).toHaveLength(pairs.length)
    expect(new Set(states)).toHaveLength(states.length)
  })

  it('requests 32 random bytes and does not silently accept a weak source result', () => {
    const source = vi.fn((size: number) => new Uint8Array(size).fill(0xa5))
    expect(createPkcePair(source).verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generateAuthorizationState(source)).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(source.mock.calls).toEqual([[32], [32]])

    expect(() => generateAuthorizationState(() => new Uint8Array(31))).toThrow(/random source/i)
  })

  it('rejects verifier values outside the RFC 7636 grammar', () => {
    expect(() => derivePkceChallenge('short')).toThrow(/verifier/i)
    expect(() => derivePkceChallenge(`${'a'.repeat(42)}!`)).toThrow(/verifier/i)
    expect(() => derivePkceChallenge('a'.repeat(129))).toThrow(/verifier/i)
  })
})

describe('authorization browser origin', () => {
  it('opens only the exact HTTPS Agnes origin in the production entry point', async () => {
    const open = vi.fn(async (_url: string) => undefined)
    const adapter = { open }
    const valid = `${AGNES_AUTHORIZATION_ORIGIN}/login?request=opaque`

    await openAgnesAuthorizationUrl(valid, adapter)
    expect(open).toHaveBeenCalledWith(valid)

    for (const invalid of [
      'http://platform.agnes-ai.com/login',
      'https://platform.agnes-ai.com.evil.example/login',
      'https://user@platform.agnes-ai.com/login',
      'https://platform.agnes-ai.com/login#access_token=secret',
      'not a URL',
    ]) {
      await expect(openAgnesAuthorizationUrl(invalid, adapter)).rejects.toThrow(/authorization URL/i)
    }
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('permits a test URL only through an explicit trusted-origin injection', async () => {
    const open = vi.fn(async (_url: string) => undefined)
    const testUrl = 'http://127.0.0.1:43123/fake-authorize?request=opaque'

    await expect(openAgnesAuthorizationUrl(testUrl, { open })).rejects.toThrow(/authorization URL/i)
    await openAuthorizationUrl(testUrl, { open }, 'http://127.0.0.1:43123')
    expect(open).toHaveBeenCalledWith(testUrl)
  })

  it('does not leak an authorization URL through adapter failures', async () => {
    const marker = 'request-secret-marker'
    await expect(
      openAgnesAuthorizationUrl(`${AGNES_AUTHORIZATION_ORIGIN}/login?request=${marker}`, {
        open: async () => {
          throw new Error(`could not open ${marker}`)
        },
      }),
    ).rejects.not.toThrow(marker)
  })
})
