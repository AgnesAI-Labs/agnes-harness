import { createHash, createHmac } from 'node:crypto'
import { META_KEY } from '@agnes/protocol'
import { createClient as createNodeClient } from '@agnes/sdk'
import { describe, expect, it, vi } from 'vitest'
import { jcs } from '../src/jcs.js'
import {
  signSourceAuth,
  sourceAuthCanonical,
  sourceAuthProvider,
  surfaceAuthProvider,
} from '../src/sign.node.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

const params = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  _meta: { 'ai.agnes.harness': { clientId: 'c1', auth: { kind: 'jwt', token: 'should-be-stripped' } } },
}

describe('source-auth', () => {
  it('builds canonical from clientId + sha256(JCS(params sans _meta.auth))', () => {
    const stripped = { ...params, _meta: { 'ai.agnes.harness': { clientId: 'c1' } } }
    const expected = `initialize\nc1\n${createHash('sha256').update(jcs(stripped)).digest('hex')}`
    expect(sourceAuthCanonical('c1', params)).toBe(expected)
  })

  it('signs v0=HMAC(secret, "v0:" + ts + ":" + nonce + ":" + canonical) with a 16-byte hex nonce', () => {
    const sig = signSourceAuth('c1', params, 'shh', {
      now: () => 1_700_000_000_000,
      nonce: () => '00'.repeat(16),
    })
    const canonical = sourceAuthCanonical('c1', params)
    const nonce = '00'.repeat(16)
    expect(sig).toEqual({
      kind: 'source-auth',
      timestamp: 1_700_000_000,
      nonce,
      signature: `v0=${createHmac('sha256', 'shh').update(`v0:1700000000:${nonce}:${canonical}`).digest('hex')}`,
    })
    expect(signSourceAuth('c1', params, 'shh').nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it('a captured signature does not verify under a substituted nonce (2026-09-10 security ruling)', () => {
    const nonceA = '00'.repeat(16)
    const nonceB = '11'.repeat(16)
    const sig = signSourceAuth('c1', params, 'shh', { now: () => 1_700_000_000_000, nonce: () => nonceA })
    const canonical = sourceAuthCanonical('c1', params)
    const replayed = `v0=${createHmac('sha256', 'shh').update(`v0:1700000000:${nonceB}:${canonical}`).digest('hex')}`
    expect(sig.signature).not.toBe(replayed)
    // The property that actually distinguishes the fix from the pre-2026-09-10 vulnerability:
    // re-signing the identical (clientId, params, secret, timestamp) under a different nonce must
    // produce a different signature. Under the old formula (nonce excluded from the HMAC input) this
    // would be equal -- a captured (timestamp, canonical, signature) triple could be relabelled with
    // any nonce and would still be exactly what the signer would have produced for that nonce, so
    // nonce-based replay rejection was defeated. See reverse-verification in the task 17 report.
    const sigB = signSourceAuth('c1', params, 'shh', { now: () => 1_700_000_000_000, nonce: () => nonceB })
    expect(sig.signature).not.toBe(sigB.signature)
  })

  it('provider signs the live initialize params and refuses to run without a secret outside development', async () => {
    const p = sourceAuthProvider('shh')
    const auth = await p.build({ clientId: 'c1', initializeParams: params })
    expect(auth).toMatchObject({ kind: 'source-auth' })
    expect(() => sourceAuthProvider(undefined, { nodeEnv: 'production' })).toThrow(/secret required/)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dev = sourceAuthProvider(undefined, { nodeEnv: 'development' })
    expect(await dev.build({ clientId: 'c1', initializeParams: params })).toEqual({ kind: 'local' })
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('the Node package entry registers source-auth for a real initialize handshake', async () => {
    const endpoint = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const client = createNodeClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      auth: { kind: 'source-auth', secret: 'deployment-secret' },
    })
    try {
      await client.initialize()
      expect(endpoint.calls[0]?.params).toMatchObject({
        _meta: {
          [META_KEY]: {
            auth: {
              kind: 'source-auth',
              timestamp: expect.any(Number),
              nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
              signature: expect.stringMatching(/^v0=[0-9a-f]{64}$/),
            },
          },
        },
      })
    } finally {
      await client.close()
    }
  })

  it('builds one Surface credential from source proof and a refreshable subject', async () => {
    let subject = 0
    const provider = surfaceAuthProvider({
      kind: 'surface',
      sourceId: 'reports',
      secret: 'deployment-secret',
      subject: { kind: 'jwt', token: async () => `subject-${++subject}` },
    })
    await expect(provider.build({ clientId: 'c1', initializeParams: params })).resolves.toMatchObject({
      kind: 'surface',
      sourceId: 'reports',
      source: {
        kind: 'source-auth',
        timestamp: expect.any(Number),
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        signature: expect.stringMatching(/^v0=[0-9a-f]{64}$/),
      },
      subject: { kind: 'jwt', token: 'subject-1' },
    })
    expect(() =>
      surfaceAuthProvider({
        kind: 'surface',
        sourceId: '../reports',
        secret: 'deployment-secret',
        subject: { kind: 'portal-identity', token: 'portal' },
      }),
    ).toThrow(/sourceId/)
    expect(() =>
      surfaceAuthProvider({
        kind: 'surface',
        sourceId: 'reports',
        secret: '',
        subject: { kind: 'portal-identity', token: 'portal' },
      }),
    ).toThrow(/secret required/)
  })

  it('the Node client registers composite Surface auth for the initialize handshake', async () => {
    const endpoint = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const client = createNodeClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      auth: {
        kind: 'surface',
        sourceId: 'reports',
        secret: 'deployment-secret',
        subject: { kind: 'portal-identity', token: 'signed.portal.identity' },
      },
    })
    try {
      await client.initialize()
      expect(endpoint.calls[0]?.params).toMatchObject({
        _meta: {
          [META_KEY]: {
            auth: {
              kind: 'surface',
              sourceId: 'reports',
              source: { kind: 'source-auth' },
              subject: { kind: 'portal-identity', token: 'signed.portal.identity' },
            },
          },
        },
      })
    } finally {
      await client.close()
    }
  })
})
