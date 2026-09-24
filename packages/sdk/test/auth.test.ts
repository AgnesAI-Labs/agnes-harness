import { META_KEY } from '@agnes/protocol'
import { afterEach, expect, it } from 'vitest'
import { jwtAuth, portalIdentityAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import type { TransportHandlers } from '../src/transport/types.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'
import { flakyEndpoint } from './helpers/flaky-endpoint.js'

const ctx = { clientId: 'c', initializeParams: {} }
it('fetches a new JWT on each build and passes portal tokens unchanged', async () => {
  let n = 0
  const provider = jwtAuth(async () => `synthetic-${++n}`)
  expect(await provider.build(ctx)).toEqual({ kind: 'jwt', token: 'synthetic-1' })
  expect(await provider.build(ctx)).toEqual({ kind: 'jwt', token: 'synthetic-2' })
  expect(await portalIdentityAuth('synthetic.portal').build(ctx)).toEqual({
    kind: 'portal-identity',
    token: 'synthetic.portal',
  })
})
it.each(['empty', 'wrong-type', 'throws'])(
  'rejects %s refresh without revealing the failure text',
  async (kind) => {
    const provider = jwtAuth(async () => {
      if (kind === 'throws') throw new Error('private credential marker')
      return kind === 'empty' ? '' : (12 as unknown as string)
    })
    await expect(provider.build(ctx)).rejects.toThrow(/^jwt credential unavailable$/)
  },
)
it('rejects an empty portal token', async () => {
  await expect(portalIdentityAuth('').build(ctx)).rejects.toThrow(/^portal credential unavailable$/)
})
it('uses the default JWT registration and refetches on an explicit new initialize after transport loss', async () => {
  let handlers!: TransportHandlers
  const sent: unknown[] = []
  let n = 0
  const f = fakeEndpoint({})
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    auth: { kind: 'jwt', token: async () => `synthetic-${++n}` },
    transportFactories: {
      inproc: () => async (h) => {
        handlers = h
        return {
          kind: 'inproc',
          async send(message) {
            if ('method' in message && message.method === 'initialize' && 'id' in message) {
              sent.push(
                (message.params as { _meta: Record<string, { auth: unknown }> })._meta[META_KEY]?.auth,
              )
              h.onMessage({
                jsonrpc: '2.0',
                id: message.id,
                result: { protocolVersion: 1, agentCapabilities: {} },
              })
            }
          },
          close: async () => {
            h.onClose({ reason: 'closed' })
          },
        }
      },
    },
  })
  try {
    await client.initialize()
    await client.initialize()
    expect(n).toBe(1)
    handlers.onClose({ reason: 'eof' })
    await client.initialize()
    expect(sent).toEqual([
      { kind: 'jwt', token: 'synthetic-1' },
      { kind: 'jwt', token: 'synthetic-2' },
    ])
  } finally {
    await client.close()
  }
})
it('default portal registration emits its token, and failed JWT refresh emits no handshake', async () => {
  const f = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
  const portal = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    auth: { kind: 'portal-identity', token: 'synthetic.portal' },
  })
  try {
    await portal.initialize()
    expect(f.calls[0]?.params).toMatchObject({
      _meta: { [META_KEY]: { auth: { kind: 'portal-identity', token: 'synthetic.portal' } } },
    })
  } finally {
    await portal.close()
  }
  const none = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
  const rejected = createClient({
    transport: { kind: 'inproc', endpoint: none.endpoint },
    auth: {
      kind: 'jwt',
      token: async () => {
        throw new Error('private credential marker')
      },
    },
  })
  try {
    await expect(rejected.initialize()).rejects.toThrow(/^jwt credential unavailable$/)
    expect(none.calls).toEqual([])
  } finally {
    await rejected.close()
  }
})

// Task 16's own note: "automatic reconnect re-fetch still depends on Task 15" - flakyEndpoint
// (Task 15) now exists, so this closes that gap. The real path under test is the automatic
// Reconnector loop (reattach.ts), not a caller manually calling initialize() again - client.ts's
// initialize() calls this.auth.build(...) fresh every time (verified by reading it), so the
// question this test actually answers is whether the *reconnect loop* reaches that same call,
// not whether a second manual initialize() would (a different, already-covered case above).
const clients: ReturnType<typeof createClient>[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
})
it('the automatic reconnect loop re-fetches the JWT, not just a caller-driven re-initialize', async () => {
  let n = 0
  const f = flakyEndpoint({ initialize: fakeEndpoint({}).initialize })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint },
    transportFactories: { inproc: () => f.factory },
    auth: { kind: 'jwt', token: async () => `refreshed-${++n}` },
    reconnect: { baseMs: 1, maxMs: 5, jitter: 0 },
  })
  clients.push(client)
  await client.initialize()
  expect(n).toBe(1)
  const reconnected = new Promise<void>((resolve) => client.on('reconnected', () => resolve()))
  f.drop()
  await reconnected
  expect(n).toBe(2)
  const authOf = (i: number) => {
    const params = f.calls[i]?.params as { _meta: Record<string, { auth: { token: string } }> }
    return params._meta[META_KEY]?.auth.token
  }
  expect(authOf(0)).toBe('refreshed-1')
  expect(authOf(1)).toBe('refreshed-2')
})
