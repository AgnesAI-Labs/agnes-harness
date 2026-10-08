import { createHmac } from 'node:crypto'
import { mintPortalIdentity } from '@agnes/sdk'
import { describe, expect, it } from 'vitest'
import { verifyAuth } from '../src/local/auth.js'

const now = 1_700_000_000_000
const nonces = { consume: () => true }
const params = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
}

function verify(token: string, secret = 'portal', at = now) {
  return verifyAuth({
    auth: { kind: 'portal-identity', token },
    clientId: 'client-1',
    params,
    config: { transport: 'ws', portalSecret: secret },
    now: at,
    nonces,
  })
}

function signedPayload(payload: string, secret = 'portal'): string {
  return `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

describe('SDK portal identity to daemon auth interoperability', () => {
  it('accepts a token minted by the real SDK and relays its public identity', () => {
    const token = mintPortalIdentity(
      { sub: 'user-9', exp: now / 1_000 + 30, attrs: { dept: 'sales', locale: 'zh-CN' } },
      'portal',
    )

    expect(verify(token)).toEqual({
      ok: true,
      authKind: 'portal-identity',
      credential: {
        kind: 'sso',
        userId: 'user-9',
        raw: { dept: 'sales', locale: 'zh-CN' },
      },
    })
  })

  it('rejects a tampered SDK token and a verifier with the wrong secret', () => {
    const token = mintPortalIdentity({ sub: 'user-9', exp: now / 1_000 + 30 }, 'portal')
    const [payload, mac] = token.split('.') as [string, string]
    const tampered = `${payload}.${mac[0] === '0' ? '1' : '0'}${mac.slice(1)}`

    expect(verify(tampered)).toMatchObject({ ok: false, reason: 'signature' })
    expect(verify(token, 'wrong')).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('rejects expired tokens, including the exact expiry boundary', () => {
    const expired = mintPortalIdentity({ sub: 'user-9', exp: now / 1_000 - 1 }, 'portal')
    const exact = mintPortalIdentity({ sub: 'user-9', exp: now / 1_000 }, 'portal')

    expect(verify(expired)).toMatchObject({ ok: false, reason: 'exp' })
    expect(verify(exact)).toMatchObject({ ok: false, reason: 'exp' })
  })

  it('fails closed without throwing for malformed serialization or claims', () => {
    const valid = mintPortalIdentity({ sub: 'user-9', exp: now / 1_000 + 30 }, 'portal')
    const malformed = [
      'garbage',
      `${valid}.extra`,
      signedPayload('{'),
      signedPayload(JSON.stringify({ sub: '', exp: now / 1_000 + 30 })),
      signedPayload(JSON.stringify({ sub: 'user-9', exp: 'later' })),
      signedPayload(JSON.stringify({ sub: 'user-9', exp: now / 1_000 + 30, attrs: { rank: 3 } })),
    ]

    for (const token of malformed) {
      expect(() => verify(token)).not.toThrow()
      expect(verify(token)).toMatchObject({ ok: false })
    }
  })

  it('rejects the obsolete p/n/imp millisecond dialect even when correctly HMAC-signed', () => {
    const legacy = signedPayload(JSON.stringify({ p: 'user-9', n: 'Alice', imp: 'admin', exp: now + 30_000 }))

    expect(verify(legacy)).toMatchObject({ ok: false })
  })
})
