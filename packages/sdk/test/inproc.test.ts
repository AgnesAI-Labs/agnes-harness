import { describe, expect, it } from 'vitest'
import { RpcConnection } from '../src/rpc.js'
import { inprocTransport, type RpcEndpoint } from '../src/transport/inproc.js'
import type { CloseInfo, JsonRpcMessage } from '../src/transport/types.js'

// Microtasks only, no timers: every wake-up path in the notification pump is a promise
// resolution, so draining microtasks is both sufficient and independent of the clock.
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function fakeEndpoint(opts: { handle?: (msg: JsonRpcMessage) => Promise<JsonRpcMessage | undefined> } = {}) {
  const queue: JsonRpcMessage[] = []
  let wake: (() => void) | null = null
  let closed = false
  const handled: JsonRpcMessage[] = []
  const ep: RpcEndpoint & { push(m: JsonRpcMessage): void; handled: JsonRpcMessage[]; finish(): void } = {
    handled,
    push(m) {
      queue.push(m)
      wake?.()
    },
    finish() {
      closed = true
      wake?.()
    },
    async handle(msg) {
      handled.push(msg)
      if (opts.handle) return opts.handle(msg)
      if ('id' in msg && 'method' in msg) return { jsonrpc: '2.0', id: msg.id, result: { ok: msg.method } }
      return undefined
    },
    notifications: (async function* () {
      while (!closed) {
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        await new Promise<void>((r) => {
          wake = r
        })
        wake = null
      }
    })(),
    async close() {
      closed = true
      wake?.()
    },
  }
  return ep
}

describe('inproc transport', () => {
  it('routes requests through endpoint.handle and notifications through the iterable', async () => {
    const ep = fakeEndpoint()
    const c = new RpcConnection(inprocTransport(ep), { requestTimeoutMs: 500 })
    await c.connect()
    const got: string[] = []
    c.onNotification((m) => got.push(m))
    expect(await c.request('initialize', {})).toEqual({ ok: 'initialize' })
    ep.push({ jsonrpc: '2.0', method: 'session/update', params: {} })
    await flush()
    expect(got).toEqual(['session/update'])
    await c.close()
    expect(c.connected).toBe(false)
  })

  it('sends client responses to server requests back through handle', async () => {
    const ep = fakeEndpoint()
    const c = new RpcConnection(inprocTransport(ep), { requestTimeoutMs: 500 })
    await c.connect()
    c.onServerRequest(async () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }))
    ep.push({ jsonrpc: '2.0', id: 'p1', method: 'session/request_permission', params: {} })
    await flush()
    expect(ep.handled.at(-1)).toMatchObject({ id: 'p1', result: { outcome: { optionId: 'reject_once' } } })
  })

  it('closes with reason eof when the notification iterable ends on its own', async () => {
    const ep = fakeEndpoint()
    const seen: CloseInfo[] = []
    const c = new RpcConnection(inprocTransport(ep), {
      requestTimeoutMs: 500,
      onClose: (info) => seen.push(info),
    })
    await c.connect()
    ep.finish()
    await flush()
    expect(seen).toEqual([{ reason: 'eof' }])
    expect(c.connected).toBe(false)
  })

  it('closes with reason error when the notification iterable throws', async () => {
    const ep = fakeEndpoint()
    const boom = new Error('pump died')
    ep.notifications = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(boom) }),
    }
    const seen: CloseInfo[] = []
    const c = new RpcConnection(inprocTransport(ep), {
      requestTimeoutMs: 500,
      onClose: (info) => seen.push(info),
    })
    await c.connect()
    await flush()
    expect(seen).toEqual([{ reason: 'error', error: boom }])
  })

  // The daemon side ending the stream first is the normal shutdown order. An endpoint
  // left open then holds everything it was built on for the rest of the run.
  it('closes the endpoint even when the pump ended before close() was called', async () => {
    let closes = 0
    const ep: RpcEndpoint = {
      async handle() {
        return undefined
      },
      notifications: {
        async *[Symbol.asyncIterator]() {},
      },
      async close() {
        closes++
      },
    }
    const seen: CloseInfo[] = []
    const c = new RpcConnection(inprocTransport(ep), {
      requestTimeoutMs: 500,
      onClose: (info) => seen.push(info),
    })
    await c.connect()
    await flush()
    expect(seen).toEqual([{ reason: 'eof' }])

    await c.close()

    expect(closes).toBe(1)
  })

  // The reply travels on a microtask of its own rather than inside the send() frame, so
  // a caller that registers its pending request around send() always gets its own
  // bookkeeping in first, whatever the endpoint does. The marker below is enqueued after
  // send() was called: it stands in for that bookkeeping and has to run first.
  it('delivers the reply on a microtask instead of re-entering the sender', async () => {
    const order: string[] = []
    const ep: RpcEndpoint = {
      async handle(msg) {
        return { jsonrpc: '2.0', id: (msg as { id: number }).id, result: {} }
      },
      notifications: {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {})
        },
      },
      async close() {},
    }
    const transport = await inprocTransport(ep)({
      onMessage: () => order.push('reply'),
      onClose: () => {},
    })

    const sent = transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    void Promise.resolve().then(() => order.push('caller bookkeeping'))
    await sent
    await flush()

    expect(order).toEqual(['caller bookkeeping', 'reply'])
  })

  it('surfaces a rejecting endpoint.handle as a rejected request and closes only once', async () => {
    const ep = fakeEndpoint({ handle: async () => Promise.reject(new Error('nope')) })
    const seen: CloseInfo[] = []
    const c = new RpcConnection(inprocTransport(ep), {
      requestTimeoutMs: 500,
      onClose: (info) => seen.push(info),
    })
    await c.connect()
    await expect(c.request('initialize', {})).rejects.toThrow('nope')
    await c.close()
    await c.close()
    await flush()
    expect(seen).toEqual([{ reason: 'closed' }])
  })
})
