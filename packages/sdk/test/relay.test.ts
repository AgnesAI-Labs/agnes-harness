import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type Credential, rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import type { Client } from '../src/client.js'
import { createClient } from '../src/client.js'
import { JsonRpcError } from '../src/errors.js'
import * as browserEntry from '../src/index.browser.js'
import * as nodeEntry from '../src/index.node.js'
import { memoryJournal } from '../src/journal.js'
import { createRelay, type RelayRoute, stripIdentity } from '../src/relay.node.js'
import { fakeEndpoint } from './helpers/fake-endpoint.js'

type StubSession = {
  events(): AsyncIterable<Record<string, unknown>>
  detach(): Promise<void>
}

function clientStub(
  options: { call?: (method: string, params: unknown) => unknown; session?: StubSession } = {},
): Client {
  return {
    call: async (method: string, params: unknown) => options.call?.(method, params) ?? { method, params },
    session: {
      attach: async () =>
        options.session ?? {
          events: async function* () {
            yield { seq: 1, type: 'user/message' }
          },
          async detach() {},
        },
    },
  } as unknown as Client
}

const credential: Credential = {
  kind: 'channel',
  channel: 'test',
  accountId: 'account',
  userId: 'alice',
  chatId: 'chat',
  chatType: 'dm',
}

const servers = new Set<ReturnType<typeof createServer>>()
afterEach(async () => {
  for (const server of servers) server.closeAllConnections()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
  servers.clear()
})

async function serve(client: Client, routes: RelayRoute[], principal: Credential | null = credential) {
  const relay = createRelay(client, routes, {
    principal: async () => principal,
    clientForPrincipal: () => client,
    heartbeatMs: 10,
  })
  const server = createServer((req, res) => void relay(req, res))
  servers.add(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}

describe('createRelay', () => {
  it('forwards only an allowlisted route, recursively removes asserted identity, and injects principal', async () => {
    const base = await serve(clientStub(), [
      {
        method: 'POST',
        path: '/api/join',
        rpc: '_agnes/v1/participant.join',
        principalParam: 'credential',
      },
    ])
    const response = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's',
        actor: { id: 'evil' },
        credential: { kind: 'local' },
        nested: { keep: true, _meta: { auth: 'evil' }, approverCredential: { kind: 'local' } },
      }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      method: '_agnes/v1/participant.join',
      params: { sessionId: 's', nested: { keep: true }, credential },
    })
    expect((await fetch(`${base}/api/not-allowed`)).status).toBe(404)
  })

  it('uses protocol-valid principal fields and leaves session.list params clean with a real Client', async () => {
    const endpoint = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/session.list': () => ({ items: [] }),
      '_agnes/v1/participant.join': () => ({ seq: 1 }),
      '_agnes/v1/approval.decide': () => ({ seq: 2 }),
    })
    const real = createClient({
      transport: { kind: 'inproc', endpoint: endpoint.endpoint },
      journal: memoryJournal(),
      authProviders: { local: () => localAuth() },
    })
    try {
      const base = await serve(real, [
        { method: 'GET', path: '/api/sessions', rpc: '_agnes/v1/session.list' },
        {
          method: 'POST',
          path: '/api/join',
          rpc: '_agnes/v1/participant.join',
          principalParam: 'credential',
        },
        {
          method: 'POST',
          path: '/api/approval',
          rpc: '_agnes/v1/approval.decide',
          principalParam: 'approverCredential',
        },
      ])
      expect((await fetch(`${base}/api/sessions`)).status).toBe(200)
      expect(
        (
          await fetch(`${base}/api/join`, {
            method: 'POST',
            body: JSON.stringify({ sessionId: 's', credential: { kind: 'local' } }),
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await fetch(`${base}/api/approval`, {
            method: 'POST',
            body: JSON.stringify({
              ticket: 't',
              verdict: 'allowed-once',
              approverCredential: { kind: 'local' },
            }),
          })
        ).status,
      ).toBe(200)
      expect(endpoint.calls.filter(({ method }) => method !== 'initialize')).toEqual([
        { method: '_agnes/v1/session.list', params: {} },
        { method: '_agnes/v1/participant.join', params: { sessionId: 's', credential } },
        {
          method: '_agnes/v1/approval.decide',
          params: { ticket: 't', verdict: 'allowed-once', approverCredential: credential },
        },
      ])
    } finally {
      await real.close()
    }
  })

  it('fails closed for missing principals, oversized/invalid bodies, and maps rpc errors', async () => {
    const route: RelayRoute = {
      method: 'POST',
      path: '/api/join',
      rpc: '_agnes/v1/participant.join',
      principalParam: 'credential',
    }
    const noPrincipal = await serve(clientStub(), [route], null)
    expect((await fetch(`${noPrincipal}/api/join`, { method: 'POST', body: '{}' })).status).toBe(401)

    const denied = await serve(
      clientStub({ call: () => Promise.reject(new JsonRpcError(rpcError('CAPABILITY_DENIED'))) }),
      [route],
    )
    expect((await fetch(`${denied}/api/join`, { method: 'POST', body: '{}' })).status).toBe(403)

    const relay = createRelay(clientStub(), [route], { principal: async () => credential, maxBodyBytes: 4 })
    const server = createServer((req, res) => void relay(req, res))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/join`, { method: 'POST', body: '12345' })).status).toBe(413)
    expect((await fetch(`${base}/api/join`, { method: 'POST', body: '{' })).status).toBe(400)
  })

  it('streams events and heartbeat over SSE, then releases the iterator when the response closes', async () => {
    let released = false
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          let first = true
          return {
            async next() {
              if (first) {
                first = false
                return { done: false as const, value: { seq: 1, type: 'user/message' } }
              }
              return new Promise<IteratorResult<Record<string, unknown>>>(() => {})
            },
            async return() {
              released = true
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {},
    }
    const base = await serve(clientStub({ session }), [{ method: 'GET', path: '/api/events', sse: 'events' }])
    const controller = new AbortController()
    const response = await fetch(`${base}/api/events?session=s`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('SSE response body missing')
    const decoder = new TextDecoder()
    let received = ''
    while (!received.includes(': ping')) received += decoder.decode((await reader.read()).value)
    expect(received).toContain('data: {"seq":1,"type":"user/message"}')
    controller.abort()
    await expect.poll(() => released).toBe(true)
  })

  it('serves a projectUI snapshot when an SSE client falls back to polling', async () => {
    const calls: Array<{ method: string; params: unknown }> = []
    const base = await serve(
      clientStub({
        call: (method, params) => {
          calls.push({ method, params })
          return { nodes: [], cursor: 7 }
        },
      }),
      [
        {
          method: 'GET',
          path: '/api/events',
          sse: 'events',
          map: (_body, url) => ({
            sessionId: url.searchParams.get('session') ?? '',
            upto: 7,
            surface: 'web',
          }),
        },
      ],
    )
    const response = await fetch(`${base}/api/events?session=s&transport=poll`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ nodes: [], cursor: 7 })
    expect(calls).toEqual([
      { method: '_agnes/v1/session.projectUI', params: { sessionId: 's', upto: 7, surface: 'web' } },
    ])
  })

  it('binds a stream client to one principal and refuses cross-user reuse', async () => {
    const shared = clientStub({ call: () => ({ nodes: [] }) })
    const relay = createRelay(shared, [{ method: 'GET', path: '/api/events', sse: 'events' }], {
      principal: async (req) => ({ ...credential, userId: String(req.headers['x-test-user']) }),
      clientForPrincipal: () => shared,
    })
    const server = createServer((req, res) => void relay(req, res))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect(
      (
        await fetch(`${base}/api/events?session=s&transport=poll`, {
          headers: { 'x-test-user': 'alice' },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await fetch(`${base}/api/events?session=s&transport=poll`, {
          headers: { 'x-test-user': 'bob' },
        })
      ).status,
    ).toBe(403)
  })

  it('binds the base RPC client to one principal when no resolver is provided', async () => {
    const shared = clientStub()
    const relay = createRelay(shared, [{ method: 'GET', path: '/api/read', rpc: '_agnes/v1/session.list' }], {
      principal: async (req) => ({ ...credential, userId: String(req.headers['x-test-user']) }),
    })
    const server = createServer((req, res) => void relay(req, res))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/read`, { headers: { 'x-test-user': 'alice' } })).status).toBe(200)
    expect((await fetch(`${base}/api/read`, { headers: { 'x-test-user': 'bob' } })).status).toBe(403)
  })

  it('refuses cross-principal client reuse across separate relay handlers', async () => {
    const shared = clientStub()
    const route: RelayRoute = { method: 'GET', path: '/api/read', rpc: '_agnes/v1/session.list' }
    const makeRelay = (userId: string) =>
      createRelay(shared, [route], {
        principal: async () => ({ ...credential, userId }),
      })
    const alice = makeRelay('alice')
    const bob = makeRelay('bob')

    const aliceServer = createServer((req, res) => void alice(req, res))
    const bobServer = createServer((req, res) => void bob(req, res))
    servers.add(aliceServer)
    servers.add(bobServer)
    await Promise.all([
      new Promise<void>((resolve) => aliceServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => bobServer.listen(0, '127.0.0.1', resolve)),
    ])
    const aliceBase = `http://127.0.0.1:${(aliceServer.address() as AddressInfo).port}`
    const bobBase = `http://127.0.0.1:${(bobServer.address() as AddressInfo).port}`

    expect((await fetch(`${aliceBase}/api/read`)).status).toBe(200)
    expect((await fetch(`${bobBase}/api/read`)).status).toBe(403)
  })

  it('reference-counts one session across separate relay handlers', async () => {
    let attached = 0
    let detached = 0
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {
        detached++
      },
    }
    const shared = clientStub()
    shared.session.attach = async () => {
      attached++
      return session as never
    }
    const route: RelayRoute = { method: 'GET', path: '/api/events', sse: 'events' }
    const makeRelay = () =>
      createRelay(shared, [route], {
        principal: async () => credential,
        clientForPrincipal: () => shared,
      })
    const firstServer = createServer((req, res) => void makeRelay()(req, res))
    const secondServer = createServer((req, res) => void makeRelay()(req, res))
    servers.add(firstServer)
    servers.add(secondServer)
    await Promise.all([
      new Promise<void>((resolve) => firstServer.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => secondServer.listen(0, '127.0.0.1', resolve)),
    ])
    const first = new AbortController()
    const second = new AbortController()
    const responses = await Promise.all([
      fetch(`http://127.0.0.1:${(firstServer.address() as AddressInfo).port}/api/events?session=s`, {
        signal: first.signal,
      }),
      fetch(`http://127.0.0.1:${(secondServer.address() as AddressInfo).port}/api/events?session=s`, {
        signal: second.signal,
      }),
    ])
    expect(attached).toBe(1)
    await responses[0]?.body?.cancel()
    first.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(detached).toBe(0)
    await responses[1]?.body?.cancel()
    second.abort()
    await expect.poll(() => detached).toBe(1)
  })

  it('reference-counts shared SSE attachments and detaches after the final response closes', async () => {
    let detached = 0
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {
        detached++
      },
    }
    const base = await serve(clientStub({ session }), [{ method: 'GET', path: '/api/events', sse: 'events' }])
    const first = new AbortController()
    const second = new AbortController()
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(`${base}/api/events?session=s`, { signal: first.signal }),
      fetch(`${base}/api/events?session=s`, { signal: second.signal }),
    ])
    await firstResponse.body?.cancel()
    first.abort()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(detached).toBe(0)
    await secondResponse.body?.cancel()
    second.abort()
    await expect.poll(() => detached).toBe(1)
  })

  it('fences a new SSE attach behind the final detach for the previous stream', async () => {
    const order: string[] = []
    let attachCount = 0
    let detachCount = 0
    let detachStarted!: () => void
    let finishDetach!: () => void
    const started = new Promise<void>((resolve) => {
      detachStarted = resolve
    })
    const detached = new Promise<void>((resolve) => {
      finishDetach = resolve
    })
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {
        detachCount++
        order.push(`detach-${detachCount}-start`)
        if (detachCount === 1) {
          detachStarted()
          await detached
        }
        order.push(`detach-${detachCount}-end`)
      },
    }
    const selected = clientStub({ session })
    selected.session.attach = async () => {
      attachCount++
      order.push(`attach-${attachCount}`)
      return session as never
    }
    const base = await serve(selected, [{ method: 'GET', path: '/api/events', sse: 'events' }])
    const first = new AbortController()
    const firstResponse = await fetch(`${base}/api/events?session=s`, { signal: first.signal })
    await firstResponse.body?.cancel()
    first.abort()
    await started

    const second = new AbortController()
    const secondResponse = fetch(`${base}/api/events?session=s`, { signal: second.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attachCount).toBe(1)
    finishDetach()
    const response = await secondResponse
    expect(response.status).toBe(200)
    expect(order.slice(0, 4)).toEqual(['attach-1', 'detach-1-start', 'detach-1-end', 'attach-2'])
    await response.body?.cancel()
    second.abort()
    await expect.poll(() => detachCount).toBe(2)
  })

  it('clears the stream tombstone when detach throws synchronously', async () => {
    let attachCount = 0
    let detachCount = 0
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      detach: (() => {
        detachCount++
        if (detachCount === 1) throw new Error('sync detach failure')
        return Promise.resolve()
      }) as StubSession['detach'],
    }
    const selected = clientStub({ session })
    selected.session.attach = async () => {
      attachCount++
      return session as never
    }
    const base = await serve(selected, [{ method: 'GET', path: '/api/events', sse: 'events' }])
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController()
      const response = await fetch(`${base}/api/events?session=s`, { signal: controller.signal })
      await response.body?.cancel()
      controller.abort()
      await expect.poll(() => detachCount).toBe(attempt + 1)
    }
    expect(attachCount).toBe(2)
  })

  it.each(['writeHead', 'flushHeaders'] as const)(
    'releases the attached stream when response.%s throws',
    async (stage) => {
      let detached = 0
      const session: StubSession = {
        events: async function* () {},
        async detach() {
          detached++
        },
      }
      const selected = clientStub({ session })
      const relay = createRelay(selected, [{ method: 'GET', path: '/api/events', sse: 'events' }], {
        principal: async () => credential,
        clientForPrincipal: () => selected,
      })
      let handled = false
      const server = createServer((req, res) => {
        if (stage === 'writeHead')
          res.writeHead = (() => {
            throw new Error('writeHead failed')
          }) as typeof res.writeHead
        else
          res.flushHeaders = () => {
            throw new Error('flushHeaders failed')
          }
        void relay(req, res).finally(() => {
          handled = true
        })
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      await fetch(`http://127.0.0.1:${port}/api/events?session=s`).catch(() => undefined)
      await expect.poll(() => detached).toBe(1)
      await expect.poll(() => handled).toBe(true)
    },
  )

  it('does not write JSON headers again when an SSE iterator fails after headers were sent', async () => {
    let detached = 0
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Record<string, unknown>>> {
              throw new Error('upstream stream failed')
            },
          }
        },
      }),
      async detach() {
        detached++
      },
    }
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      const base = await serve(clientStub({ session }), [
        { method: 'GET', path: '/api/events', sse: 'events' },
      ])
      await fetch(`${base}/api/events?session=s`).catch(() => undefined)
      await expect.poll(() => detached).toBe(1)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('contains iterator factory and return failures after SSE headers', async () => {
    const stages: Array<'factory' | 'return'> = ['factory', 'return']
    for (const stage of stages) {
      let detached = 0
      const session: StubSession = {
        events: () => ({
          [Symbol.asyncIterator]() {
            if (stage === 'factory') throw new Error('iterator factory failed')
            return {
              next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
              async return(): Promise<IteratorResult<Record<string, unknown>>> {
                throw new Error('iterator return failed')
              },
            }
          },
        }),
        async detach() {
          detached++
        },
      }
      const base = await serve(clientStub({ session }), [
        { method: 'GET', path: `/api/events-${stage}`, sse: 'events' },
      ])
      const controller = new AbortController()
      const response = await fetch(`${base}/api/events-${stage}?session=s`, {
        signal: controller.signal,
      }).catch(() => undefined)
      await response?.body?.cancel()
      controller.abort()
      await expect.poll(() => detached).toBe(1)
    }
  })

  it('bounds iterator return cleanup and observes a rejection that arrives after the timeout', async () => {
    const stages: Array<'never' | 'late-reject'> = ['never', 'late-reject']
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    try {
      for (const stage of stages) {
        let detached = 0
        let handled = false
        const session: StubSession = {
          events: () => ({
            [Symbol.asyncIterator]() {
              return {
                next: () => new Promise<IteratorResult<Record<string, unknown>>>(() => {}),
                return: () =>
                  stage === 'never'
                    ? new Promise<IteratorResult<Record<string, unknown>>>(() => {})
                    : new Promise<IteratorResult<Record<string, unknown>>>((_resolve, reject) =>
                        setTimeout(() => reject(new Error('late iterator failure')), 30),
                      ),
              }
            },
          }),
          async detach() {
            detached++
          },
        }
        const selected = clientStub({ session })
        const relay = createRelay(
          selected,
          [{ method: 'GET', path: `/api/events-${stage}`, sse: 'events' }],
          {
            principal: async () => credential,
            clientForPrincipal: () => selected,
            heartbeatMs: 1_000,
            iteratorReturnTimeoutMs: 5,
          },
        )
        const server = createServer((req, res) => {
          void relay(req, res).finally(() => {
            handled = true
          })
        })
        servers.add(server)
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as AddressInfo
        const controller = new AbortController()
        const response = await fetch(`http://127.0.0.1:${port}/api/events-${stage}?session=s`, {
          signal: controller.signal,
        })
        await response.body?.cancel()
        controller.abort()
        await expect.poll(() => detached).toBe(1)
        await expect.poll(() => handled).toBe(true)
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('waits for response drain before pulling the next SSE event', async () => {
    let index = 0
    let firstWriteAt = 0
    let secondNextAt = 0
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<Record<string, unknown>>> {
              index++
              if (index === 1) return { done: false, value: { seq: 1 } }
              if (index === 2) {
                secondNextAt = Date.now()
                return { done: false, value: { seq: 2 } }
              }
              return new Promise(() => {})
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {},
    }
    const selected = clientStub({ session })
    const relay = createRelay(selected, [{ method: 'GET', path: '/api/events', sse: 'events' }], {
      principal: async () => credential,
      clientForPrincipal: () => selected,
      heartbeatMs: 1_000,
    })
    const server = createServer((req, res) => {
      const write = res.write.bind(res)
      let blocked = false
      let throttled = false
      Object.defineProperty(res, 'writableNeedDrain', { configurable: true, get: () => blocked })
      res.write = ((chunk: string | Uint8Array) => {
        const accepted = write(chunk)
        if (!throttled && String(chunk).startsWith('data:')) {
          throttled = true
          blocked = true
          firstWriteAt = Date.now()
          setTimeout(() => {
            blocked = false
            res.emit('drain')
          }, 30)
          return false
        }
        return accepted
      }) as typeof res.write
      void relay(req, res)
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}/api/events?session=s`, {
      signal: controller.signal,
    })
    const reader = response.body?.getReader()
    if (!reader) throw new Error('SSE response body missing')
    let received = ''
    const decoder = new TextDecoder()
    while (!received.includes('"seq":2')) received += decoder.decode((await reader.read()).value)
    expect(secondNextAt - firstWriteAt).toBeGreaterThanOrEqual(20)
    await reader.cancel()
    controller.abort()
  })

  it('contains a response error while blocked on SSE backpressure and detaches', async () => {
    let detached = 0
    let handled = false
    const session: StubSession = {
      events: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: false as const, value: { seq: 1 } }
            },
            async return() {
              return { done: true as const, value: undefined }
            },
          }
        },
      }),
      async detach() {
        detached++
      },
    }
    const selected = clientStub({ session })
    const relay = createRelay(selected, [{ method: 'GET', path: '/api/events', sse: 'events' }], {
      principal: async () => credential,
      clientForPrincipal: () => selected,
      heartbeatMs: 1_000,
    })
    const server = createServer((req, res) => {
      let blocked = false
      Object.defineProperty(res, 'writableNeedDrain', { configurable: true, get: () => blocked })
      const write = res.write.bind(res)
      res.write = ((chunk: string | Uint8Array) => {
        const accepted = write(chunk)
        if (String(chunk).startsWith('data:')) {
          blocked = true
          setTimeout(() => res.emit('error', new Error('response failed')), 0)
          return false
        }
        return accepted
      }) as typeof res.write
      void relay(req, res).finally(() => {
        handled = true
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    await fetch(`http://127.0.0.1:${port}/api/events?session=s`).catch(() => undefined)
    await expect.poll(() => detached).toBe(1)
    await expect.poll(() => handled).toBe(true)
  })

  it('applies the body limit to GET and snapshots the allowlist at construction', async () => {
    const route: RelayRoute = { method: 'GET', path: '/api/read', rpc: '_agnes/v1/session.list' }
    const routes: RelayRoute[] = [route]
    const relay = createRelay(clientStub(), routes, {
      principal: async () => credential,
      maxBodyBytes: 4,
    })
    route.path = '/api/mutated'
    routes.push({ method: 'GET', path: '/api/added', rpc: '_agnes/v1/session.list' })
    const server = createServer((req, res) => void relay(req, res))
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const requestStatus = (path: string, body = '') =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path,
            ...(body ? { headers: { 'content-length': Buffer.byteLength(body) } } : {}),
          },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        req.end(body)
      })
    expect(await requestStatus('/api/read', '12345')).toBe(413)
    expect(await requestStatus('/api/read')).toBe(200)
    expect(await requestStatus('/api/mutated')).toBe(404)
    expect(await requestStatus('/api/added')).toBe(404)
  })

  it('explicitly releases chunked overflow and bodies rejected before parsing', async () => {
    const routes: RelayRoute[] = [
      {
        method: 'POST',
        path: '/api/join',
        rpc: '_agnes/v1/participant.join',
        principalParam: 'credential',
      },
    ]
    const relay = createRelay(clientStub(), routes, {
      principal: async (req) => (req.headers.authorization ? credential : null),
      maxBodyBytes: 4,
    })
    let resumes = 0
    const server = createServer((req, res) => {
      const resume = req.resume.bind(req)
      req.resume = () => {
        resumes++
        return resume()
      }
      void relay(req, res)
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const send = (path: string, authorized: boolean, chunks: string[]) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path,
            ...(authorized ? { headers: { authorization: 'test' } } : {}),
          },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode ?? 0))
          },
        )
        req.on('error', reject)
        for (const chunk of chunks) req.write(chunk)
        req.end()
      })
    expect(await send('/api/join', true, ['123', '45'])).toBe(413)
    expect(await send('/api/missing', true, ['large rejected body'])).toBe(404)
    expect(await send('/api/join', false, ['large rejected body'])).toBe(401)
    expect(resumes).toBeGreaterThanOrEqual(3)
  })

  it('rejects SSRF-shaped route configuration and absolute-form request targets', async () => {
    expect(() =>
      createRelay(
        clientStub(),
        [{ method: 'GET', path: 'http://169.254.169.254/latest/meta-data', rpc: '_agnes/v1/session.list' }],
        { principal: async () => credential },
      ),
    ).toThrow(/origin path/)
    expect(() =>
      createRelay(clientStub(), [{ method: 'GET', path: '/api/x', rpc: 'http://169.254.169.254/' }], {
        principal: async () => credential,
      }),
    ).toThrow(/_agnes\/v1/)

    const base = await serve(clientStub(), [{ method: 'GET', path: '/api/x', rpc: '_agnes/v1/session.list' }])
    const port = new URL(base).port
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'GET', path: 'http://169.254.169.254/api/x' },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
  })

  it('requires an identity-bound client resolver for SSE and poll routes', () => {
    expect(() =>
      createRelay(clientStub(), [{ method: 'GET', path: '/api/events', sse: 'events' }], {
        principal: async () => credential,
      }),
    ).toThrow(/clientForPrincipal/)
  })

  it('rejects principal parameters that do not match the target RPC schema', () => {
    expect(() =>
      createRelay(
        clientStub(),
        [
          {
            method: 'GET',
            path: '/api/sessions',
            rpc: '_agnes/v1/session.list',
            principalParam: 'credential',
          },
        ],
        { principal: async () => credential },
      ),
    ).toThrow(/does not accept/)
    expect(() =>
      createRelay(clientStub(), [{ method: 'POST', path: '/api/join', rpc: '_agnes/v1/participant.join' }], {
        principal: async () => credential,
      }),
    ).toThrow(/requires credential/)
    expect(() =>
      createRelay(
        clientStub(),
        [
          {
            method: 'POST',
            path: '/api/approval',
            rpc: '_agnes/v1/approval.decide',
            principalParam: 'credential',
          },
        ],
        { principal: async () => credential },
      ),
    ).toThrow(/requires approverCredential/)
  })
})

describe('stripIdentity', () => {
  it('handles arrays and cyclic trusted mapper output without recursion', () => {
    const value: Record<string, unknown> = { actor: 'evil', rows: [{ credential: 'evil', keep: 1 }] }
    value.self = value
    const clean = stripIdentity(value)
    expect(clean.actor).toBeUndefined()
    expect(clean.rows).toEqual([{ keep: 1 }])
    expect(clean.self).toBe(clean)
  })

  it('drops prototype-control keys instead of exposing inherited mapper inputs', () => {
    const value = JSON.parse(
      '{"__proto__":{"admin":true},"constructor":{"prototype":{"credential":"evil"}},"keep":1}',
    ) as Record<string, unknown>
    const clean = stripIdentity(value) as Record<string, unknown> & { admin?: boolean }
    expect(Object.getPrototypeOf(clean)).toBeNull()
    expect(clean.admin).toBeUndefined()
    expect(clean).toEqual({ keep: 1 })
  })
})

it('exports relay from Node without widening the browser surface', () => {
  expect(nodeEntry.createRelay).toBe(createRelay)
  expect('createRelay' in browserEntry).toBe(false)
  expect('stripIdentity' in browserEntry).toBe(false)
})
