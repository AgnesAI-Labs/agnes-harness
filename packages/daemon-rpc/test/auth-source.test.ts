import { describe, expect, it } from 'vitest'
import { jcs, signSourceAuth, sourceAuthCanonical, verifySourceAuth } from '../src/local/auth.js'

const params = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  _meta: {
    'ai.agnes.harness': {
      clientId: 'c1',
      auth: { kind: 'source-auth', timestamp: 1, signature: 'x', nonce: 'y' },
    },
  },
}

describe('source-auth', () => {
  it('jcs sorts keys and is whitespace-free', () => {
    expect(jcs({ b: [1, { z: 'é', a: null }], a: 'x' })).toBe('{"a":"x","b":[1,{"a":null,"z":"é"}]}')
  })

  it('verifies a signature made with either of two secrets, refuses skew, replay and tamper', () => {
    const canonical = sourceAuthCanonical('c1', params)
    expect(canonical.startsWith('initialize\nc1\n')).toBe(true)
    const now = 1_700_000_000_000
    const ts = Math.floor(now / 1000)
    const nonce = 'a'.repeat(32)
    const sig = signSourceAuth('old-secret', ts, nonce, canonical)
    const consumed = new Set<string>()
    const nonces = {
      consume: (c: string, n: string) => {
        const k = `${c}:${n}`
        if (consumed.has(k)) return false
        consumed.add(k)
        return true
      },
    }
    const auth = { timestamp: ts, signature: sig, nonce }
    expect(
      verifySourceAuth({ auth, clientId: 'c1', params, secrets: ['new-secret', 'old-secret'], now, nonces }),
    ).toEqual({ ok: true, secretIndex: 1 })
    expect(
      verifySourceAuth({ auth, clientId: 'c1', params, secrets: ['new-secret', 'old-secret'], now, nonces }),
    ).toEqual({ ok: false, reason: 'nonce' })
    // A bad signature never reaches the nonce table - its nonce is still fresh and can verify for real after.
    const badSig = { timestamp: ts, signature: sig, nonce: 'b'.repeat(32) }
    expect(
      verifySourceAuth({ auth: badSig, clientId: 'c1', params, secrets: ['new-secret'], now, nonces }),
    ).toEqual({ ok: false, reason: 'signature' })
    const realSig = {
      timestamp: ts,
      signature: signSourceAuth('new-secret', ts, 'b'.repeat(32), canonical),
      nonce: 'b'.repeat(32),
    }
    expect(
      verifySourceAuth({ auth: realSig, clientId: 'c1', params, secrets: ['new-secret'], now, nonces }),
    ).toEqual({ ok: true, secretIndex: 0 })
    const staleSig = {
      timestamp: ts,
      signature: signSourceAuth('old-secret', ts, 'c'.repeat(32), canonical),
      nonce: 'c'.repeat(32),
    }
    expect(
      verifySourceAuth({
        auth: staleSig,
        clientId: 'c1',
        params,
        secrets: ['old-secret'],
        now: now + 301_000,
        nonces,
      }),
    ).toEqual({ ok: false, reason: 'skew' })
    expect(
      verifySourceAuth({
        auth: { ...auth, nonce: 'zz' },
        clientId: 'c1',
        params,
        secrets: ['old-secret'],
        now,
        nonces,
      }),
    ).toEqual({ ok: false, reason: 'shape' })
  })

  it('a captured (timestamp, canonical, signature) does not verify under a substituted nonce', () => {
    const now = 1_700_000_000_000
    const ts = Math.floor(now / 1000)
    const canonical = sourceAuthCanonical('c1', params)
    const sig = signSourceAuth('shh', ts, 'a'.repeat(32), canonical)
    const nonces = { consume: () => true }
    expect(
      verifySourceAuth({
        auth: { timestamp: ts, signature: sig, nonce: 'b'.repeat(32) },
        clientId: 'c1',
        params,
        secrets: ['shh'],
        now,
        nonces,
      }),
    ).toEqual({ ok: false, reason: 'signature' })
  })
})
