import { createHmac, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authGate, signSourceAuth, sourceAuthCanonical, verifyAuth } from '../src/local/auth.js'
import { LocalEndpoint } from '../src/local/endpoint.js'

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const hs256 = (payload: object, secret: string) => {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const p = b64u(JSON.stringify(payload))
  return `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
}
const nonces = { consume: () => true }
const params = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
}
const portal = (sub: string, exp: number, secret: string) => {
  const payload = JSON.stringify({ sub, exp })
  return `${b64u(payload)}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

describe('verifyAuth', () => {
  it('local only on unix; ws refuses missing/local auth', () => {
    expect(
      verifyAuth({ auth: undefined, clientId: 'c', params, config: { transport: 'unix' }, now: 0, nonces }),
    ).toMatchObject({ ok: true, authKind: 'local', credential: { kind: 'local' } })
    expect(
      verifyAuth({ auth: undefined, clientId: 'c', params, config: { transport: 'ws' }, now: 0, nonces }),
    ).toMatchObject({ ok: false })
    expect(
      verifyAuth({
        auth: { kind: 'local' },
        clientId: 'c',
        params,
        config: { transport: 'ws' },
        now: 0,
        nonces,
      }),
    ).toMatchObject({ ok: false })
  })

  it('keeps the legacy sourceAuthSecrets configuration usable with a non-client identity', () => {
    const now = 1_700_000_000_000
    const clientId = 'legacy-adapter'
    const nonce = '0123456789abcdef0123456789abcdef'
    const unsigned = {
      ...params,
      _meta: { 'ai.agnes.harness': { clientId } },
    }
    const auth = {
      kind: 'source-auth' as const,
      timestamp: now / 1000,
      nonce,
      signature: signSourceAuth('legacy-secret', now / 1000, nonce, sourceAuthCanonical(clientId, unsigned)),
    }
    const signed = {
      ...unsigned,
      _meta: { 'ai.agnes.harness': { clientId, auth } },
    }
    expect(
      verifyAuth({
        auth,
        clientId,
        params: signed,
        config: { transport: 'ws', sourceAuthSecrets: ['legacy-secret'] },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: true, authKind: 'source-auth', sourceAuthKeyId: 'legacy:0' })
  })

  it('validates HS256 and RS256 jwt with exp and iss', () => {
    const now = 1_700_000_000_000
    const good = hs256({ iss: 'agnes', sub: 'u1', exp: now / 1000 + 60 }, 's3')
    expect(
      verifyAuth({
        auth: { kind: 'jwt', token: good },
        clientId: 'c',
        params,
        config: { transport: 'ws', jwt: { issuer: 'agnes', secret: 's3' } },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: true, authKind: 'jwt', credential: { kind: 'jwt' } })
    const expired = hs256({ iss: 'agnes', sub: 'u1', exp: now / 1000 - 1 }, 's3')
    expect(
      verifyAuth({
        auth: { kind: 'jwt', token: expired },
        clientId: 'c',
        params,
        config: { transport: 'ws', jwt: { issuer: 'agnes', secret: 's3' } },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: false, reason: 'exp' })
    const tooEarly = hs256({ iss: 'agnes', sub: 'u1', exp: now / 1000 + 3600, nbf: now / 1000 + 60 }, 's3')
    expect(
      verifyAuth({
        auth: { kind: 'jwt', token: tooEarly },
        clientId: 'c',
        params,
        config: { transport: 'ws', jwt: { issuer: 'agnes', secret: 's3' } },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: false, reason: 'nbf' })
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
    const p = b64u(JSON.stringify({ iss: 'agnes', sub: 'u2', exp: now / 1000 + 60 }))
    const rs = `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`
    const jwk = publicKey.export({ format: 'jwk' }) as { kty: 'RSA' } & Record<string, unknown>
    expect(
      verifyAuth({
        auth: { kind: 'jwt', token: rs },
        clientId: 'c',
        params,
        config: { transport: 'ws', jwt: { issuer: 'agnes', jwks: [{ kid: 'k1', ...jwk }] } },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: true, authKind: 'jwt' })
  })

  it('validates portal-identity HMAC and exp', () => {
    const now = 1_700_000_000_000
    const payload = JSON.stringify({ sub: 'u9', exp: now / 1000 + 30, attrs: { dept: 'sales' } })
    const token = `${b64u(payload)}.${createHmac('sha256', 'portal').update(payload).digest('hex')}`
    expect(
      verifyAuth({
        auth: { kind: 'portal-identity', token },
        clientId: 'c',
        params,
        config: { transport: 'ws', portalSecret: 'portal' },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: true, authKind: 'portal-identity', credential: { kind: 'sso', userId: 'u9' } })
    expect(
      verifyAuth({
        auth: { kind: 'portal-identity', token: `${token}x` },
        clientId: 'c',
        params,
        config: { transport: 'ws', portalSecret: 'portal' },
        now,
        nonces,
      }),
    ).toMatchObject({ ok: false })
  })

  it('requires a configured Surface source proof and an independently verified subject', () => {
    const now = 1_700_000_000_000
    const clientId = 'reports-bff'
    const nonce = '44444444444444444444444444444444'
    const unsigned = {
      ...params,
      _meta: { 'ai.agnes.harness': { clientId } },
    }
    const auth = {
      kind: 'surface' as const,
      sourceId: 'reports',
      source: {
        kind: 'source-auth' as const,
        timestamp: now / 1000,
        nonce,
        signature: signSourceAuth(
          'surface-secret',
          now / 1000,
          nonce,
          sourceAuthCanonical(clientId, unsigned),
        ),
      },
      subject: {
        kind: 'portal-identity' as const,
        token: portal('alice', now / 1000 + 60, 'portal-secret'),
      },
    }
    const signed = {
      ...unsigned,
      _meta: { 'ai.agnes.harness': { clientId, auth } },
    }
    const config = {
      transport: 'ws' as const,
      portalSecret: 'portal-secret',
      surfaceSources: () => [
        {
          sourceId: 'reports',
          keys: [{ secret: 'surface-secret', keyId: 'reports-key' }],
          grants: [{ extension: 'agnes/reports', name: 'sales.list', range: '^1.0.0' }],
        },
      ],
    }
    expect(verifyAuth({ auth, clientId, params: signed, config, now, nonces })).toMatchObject({
      ok: true,
      authKind: 'surface',
      credential: { kind: 'sso', userId: 'alice' },
      surface: {
        sourceId: 'reports',
        sourceAuthKeyId: 'reports-key',
        grants: [{ extension: 'agnes/reports', name: 'sales.list', range: '^1.0.0' }],
      },
    })
    expect(
      verifyAuth({ auth: { ...auth, sourceId: 'unknown' }, clientId, params: signed, config, now, nonces }),
    ).toMatchObject({ ok: false, reason: 'surface source unavailable' })
    expect(
      verifyAuth({
        auth: { ...auth, subject: { kind: 'portal-identity', token: `${auth.subject.token}x` } },
        clientId,
        params: signed,
        config,
        now,
        nonces,
      }),
    ).toMatchObject({ ok: false })
  })
})

describe('authGate identity', () => {
  it('replaces the transport placeholder with distinct server-verified JWT subjects', async () => {
    const now = 1_700_000_000_000
    const connect = async (sub: string) => {
      const ep = new LocalEndpoint({ clock: () => now, principalId: 'local' })
      ep.register(
        'initialize',
        authGate(
          ep,
          { config: { transport: 'ws', jwt: { issuer: 'agnes', secret: 's3' } }, nonces, clock: () => now },
          async (_params, cx) => {
            cx.conn.initialized = true
            return { protocolVersion: 1 }
          },
        ),
      )
      await ep.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          ...params,
          _meta: {
            'ai.agnes.harness': {
              clientId: 'same-client-label',
              auth: {
                kind: 'jwt',
                token: hs256({ iss: 'agnes', sub, exp: now / 1000 + 60 }, 's3'),
              },
            },
          },
        },
      })
      return ep
    }

    const alice = await connect('alice')
    const bob = await connect('bob')
    expect(alice.conn.clientId).toBe(bob.conn.clientId)
    expect(alice.conn.principalId).toBe('jwt:alice')
    expect(bob.conn.principalId).toBe('jwt:bob')
    expect(alice.conn.principalId).not.toBe(bob.conn.principalId)
    await alice.close()
    await bob.close()
  })

  it('derives source-auth and portal principals only after their credentials verify', async () => {
    const now = 1_700_000_000_000
    const connect = async (
      config: Parameters<typeof authGate>[1]['config'],
      clientId: string,
      credential: (unsigned: Record<string, unknown>) => Record<string, unknown>,
    ) => {
      const ep = new LocalEndpoint({ clock: () => now, principalId: 'local' })
      ep.register(
        'initialize',
        authGate(ep, { config, nonces, clock: () => now }, async (_params, cx) => {
          cx.conn.initialized = true
          return { protocolVersion: 1 }
        }),
      )
      const unsigned: Record<string, unknown> = {
        ...params,
        _meta: { 'ai.agnes.harness': { clientId } },
      }
      ;(
        (unsigned._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness'] as Record<
          string,
          unknown
        >
      ).auth = credential(unsigned)
      await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: unsigned })
      return ep
    }

    const timestamp = now / 1000
    const source = await connect(
      { transport: 'ws', sourceAuthKeys: () => [{ secret: 'source-secret', keyId: 'source-key' }] },
      'adapter-a',
      (unsigned) => ({
        kind: 'source-auth',
        timestamp,
        nonce: '0123456789abcdef0123456789abcdef',
        signature: signSourceAuth(
          'source-secret',
          timestamp,
          '0123456789abcdef0123456789abcdef',
          sourceAuthCanonical('adapter-a', unsigned),
        ),
      }),
    )
    const renamedSource = await connect(
      { transport: 'ws', sourceAuthKeys: () => [{ secret: 'source-secret', keyId: 'source-key' }] },
      'adapter-renamed',
      (unsigned) => ({
        kind: 'source-auth',
        timestamp: now / 1000,
        nonce: '11111111111111111111111111111111',
        signature: signSourceAuth(
          'source-secret',
          now / 1000,
          '11111111111111111111111111111111',
          sourceAuthCanonical('adapter-renamed', unsigned),
        ),
      }),
    )
    const portalPayload = JSON.stringify({ sub: 'alice', exp: timestamp + 60 })
    const portal = await connect({ transport: 'ws', portalSecret: 'portal-secret' }, 'adapter-a', () => ({
      kind: 'portal-identity',
      token: `${b64u(portalPayload)}.${createHmac('sha256', 'portal-secret').update(portalPayload).digest('hex')}`,
    }))

    expect(source.conn.principalId).toBe('source-auth:source-key')
    expect(portal.conn.principalId).toBe('portal:alice')
    expect(source.conn.principalId).not.toBe(portal.conn.principalId)
    expect(renamedSource.conn.principalId).toBe(source.conn.principalId)
    await source.close()
    await renamedSource.close()
    await portal.close()
  })

  it('rejects repeated initialize before verifying or consuming another nonce', async () => {
    const now = 1_700_000_000_000
    const consume = vi.fn(() => true)
    const ep = new LocalEndpoint({ clock: () => now, principalId: 'local' })
    ep.register(
      'initialize',
      authGate(
        ep,
        {
          config: { transport: 'ws', sourceAuthKeys: () => [{ secret: 's', keyId: 'source-key' }] },
          nonces: { consume },
          clock: () => now,
        },
        async (_params, cx) => {
          cx.conn.initialized = true
          return { protocolVersion: 1 }
        },
      ),
    )
    const request = (id: number, nonce: string) => {
      const unsigned: Record<string, unknown> = {
        ...params,
        _meta: { 'ai.agnes.harness': { clientId: 'adapter' } },
      }
      const pocket = (unsigned._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness']
      if (!pocket) throw new Error('missing metadata')
      pocket.auth = {
        kind: 'source-auth',
        timestamp: now / 1000,
        nonce,
        signature: signSourceAuth('s', now / 1000, nonce, sourceAuthCanonical('adapter', unsigned)),
      }
      return { jsonrpc: '2.0' as const, id, method: 'initialize' as const, params: unsigned }
    }
    await expect(ep.handle(request(1, '22222222222222222222222222222222'))).resolves.toMatchObject({
      result: { protocolVersion: 1 },
    })
    await expect(ep.handle(request(2, '33333333333333333333333333333333'))).resolves.toMatchObject({
      error: { code: -32600, data: { code: 'ALREADY_INITIALIZED' } },
    })
    expect(consume).toHaveBeenCalledTimes(2)
    await ep.close()
  })

  it('binds a Surface source and verified subject into one immutable connection identity', async () => {
    const now = 1_700_000_000_000
    const ep = new LocalEndpoint({ clock: () => now, principalId: 'transport-placeholder' })
    ep.register(
      'initialize',
      authGate(
        ep,
        {
          config: {
            transport: 'ws',
            portalSecret: 'portal-secret',
            surfaceSources: () => [
              {
                sourceId: 'reports',
                keys: [{ secret: 'surface-secret', keyId: 'reports-key' }],
                grants: [{ extension: 'agnes/reports', name: 'sales.list', range: '^1.0.0' }],
              },
            ],
          },
          nonces,
          clock: () => now,
        },
        async (_params, cx) => {
          cx.conn.initialized = true
          return { protocolVersion: 1 }
        },
      ),
    )
    const clientId = 'reports-bff'
    const unsigned: Record<string, unknown> = {
      ...params,
      _meta: { 'ai.agnes.harness': { clientId } },
    }
    const nonce = '55555555555555555555555555555555'
    const auth = {
      kind: 'surface',
      sourceId: 'reports',
      source: {
        kind: 'source-auth',
        timestamp: now / 1000,
        nonce,
        signature: signSourceAuth(
          'surface-secret',
          now / 1000,
          nonce,
          sourceAuthCanonical(clientId, unsigned),
        ),
      },
      subject: { kind: 'portal-identity', token: portal('alice', now / 1000 + 60, 'portal-secret') },
    }
    ;(
      (unsigned._meta as Record<string, Record<string, unknown>>)['ai.agnes.harness'] as Record<
        string,
        unknown
      >
    ).auth = auth
    await expect(
      ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: unsigned }),
    ).resolves.toMatchObject({ result: { protocolVersion: 1 } })
    expect(ep.conn).toMatchObject({
      principalId: 'surface:reports:portal:alice',
      authKind: 'surface',
      credentialKind: 'sso',
      surface: { sourceId: 'reports', sourceAuthKeyId: 'reports-key' },
    })
    expect(Object.isFrozen(ep.conn.surface)).toBe(true)
    expect(Object.isFrozen(ep.conn.surface?.grants)).toBe(true)
    await ep.close()
  })
})
