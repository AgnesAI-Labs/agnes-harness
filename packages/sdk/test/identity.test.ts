import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createClient, mintPortalIdentity, verifyPortalIdentity } from '../src/index.node.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

const nowMs = 1_700_000_000_000

function signed(payload: string, secret = 'portal'): string {
  return `${Buffer.from(payload).toString('base64url')}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

describe('portal identity', () => {
  it('is attached to clients created through the Node entry point', async () => {
    const client = createClient({ transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint } })

    expect(client.identity).toEqual({ mint: mintPortalIdentity, verify: verifyPortalIdentity })
    const token = client.identity?.mint({ sub: 'u9', exp: 1_700_000_030 }, 'portal')
    expect(client.identity?.verify(token ?? '', 'portal', nowMs)).toEqual({
      sub: 'u9',
      exp: 1_700_000_030,
    })
    await client.close()
  })

  it('mints the daemon dialect over the exact decoded JSON bytes', () => {
    const claims = { sub: 'u9', exp: 1_700_000_030, attrs: { dept: 'sales' } }
    const payload = JSON.stringify(claims)
    const token = mintPortalIdentity(claims, 'portal')

    expect(token).toBe(signed(payload))
    expect(token.split('.')).toHaveLength(2)
    expect(token.split('.')[1]).toMatch(/^[0-9a-f]{64}$/)
    expect(verifyPortalIdentity(token, 'portal', nowMs)).toEqual(claims)
  })

  it('rejects tampering, the wrong secret, and the exact expiry boundary', () => {
    const token = mintPortalIdentity({ sub: 'u9', exp: 1_700_000_001 }, 'portal')

    expect(verifyPortalIdentity(token, 'wrong', nowMs)).toBeNull()
    expect(verifyPortalIdentity(`${token.slice(0, -1)}0`, 'portal', nowMs)).toBeNull()
    expect(verifyPortalIdentity(token, 'portal', 1_700_000_000_999)).not.toBeNull()
    expect(verifyPortalIdentity(token, 'portal', 1_700_000_001_000)).toBeNull()
  })

  it.each([
    [{ sub: '', exp: 1_700_000_030 }, 'sub'],
    [{ sub: 'u9', exp: Number.NaN }, 'exp'],
    [{ sub: 'u9', exp: Number.POSITIVE_INFINITY }, 'exp'],
    [{ sub: 'u9', exp: 1_700_000_030.5 }, 'exp'],
    [{ sub: 'u9', exp: 0 }, 'exp'],
    [{ sub: 'u9', exp: 1_700_000_030, attrs: [] }, 'attrs'],
    [{ sub: 'u9', exp: 1_700_000_030, attrs: { rank: 3 } }, 'attrs'],
    [{ sub: 'u9', exp: 1_700_000_030, extra: true }, 'claims'],
  ])('refuses to mint invalid claims %#', (claims, field) => {
    expect(() => mintPortalIdentity(claims as never, 'portal')).toThrow(field)
  })

  it('requires a non-empty secret and a valid millisecond clock', () => {
    const claims = { sub: 'u9', exp: 1_700_000_030 }
    const token = mintPortalIdentity(claims, 'portal')

    expect(() => mintPortalIdentity(claims, '')).toThrow(/secret/)
    expect(() => verifyPortalIdentity(token, '', nowMs)).toThrow(/secret/)
    expect(() => verifyPortalIdentity(token, 'portal', Number.NaN)).toThrow(/nowMs/)
    expect(() => verifyPortalIdentity(token, 'portal', -1)).toThrow(/nowMs/)
    expect(() => mintPortalIdentity({ ...claims, attrs: { large: 'x'.repeat(8_192) } }, 'portal')).toThrow(
      /protocol limit/,
    )
  })

  it.each([
    'garbage',
    '.deadbeef',
    'e30.deadbeef.extra',
    '%%%%.deadbeef',
    `${Buffer.from('{}').toString('base64url')}=.${'0'.repeat(64)}`,
    `${Buffer.from('{}').toString('base64url')}.${'A'.repeat(64)}`,
    `${Buffer.from('{}').toString('base64url')}.${'g'.repeat(64)}`,
    'a'.repeat(8_193),
  ])('rejects a malformed or non-canonical token %#', (token) => {
    expect(verifyPortalIdentity(token, 'portal', nowMs)).toBeNull()
  })

  it('rejects signed malformed claims and the obsolete p/n/imp dialect', () => {
    expect(verifyPortalIdentity(signed('{'), 'portal', nowMs)).toBeNull()
    const obsoletePayload = Buffer.from(
      JSON.stringify({ p: 'u9', n: 'Alice', exp: nowMs + 30_000 }),
    ).toString('base64url')
    const obsoleteToken = `${obsoletePayload}.${createHmac('sha256', 'portal')
      .update(obsoletePayload)
      .digest('base64url')}`
    expect(verifyPortalIdentity(obsoleteToken, 'portal', nowMs)).toBeNull()
    expect(
      verifyPortalIdentity(
        signed(JSON.stringify({ p: 'u9', n: 'Alice', exp: nowMs + 30_000 })),
        'portal',
        nowMs,
      ),
    ).toBeNull()
    expect(
      verifyPortalIdentity(
        signed(JSON.stringify({ sub: 'u9', exp: 1_700_000_030, attrs: { rank: 3 } })),
        'portal',
        nowMs,
      ),
    ).toBeNull()
    expect(
      verifyPortalIdentity(
        signed(JSON.stringify({ sub: 'u9', exp: 1_700_000_030, extra: true })),
        'portal',
        nowMs,
      ),
    ).toBeNull()
  })
})
