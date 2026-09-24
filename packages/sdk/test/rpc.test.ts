import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonRpcError, RequestTimeout, TransportClosed } from '../src/errors.js'
import { RpcConnection } from '../src/rpc.js'
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  Transport,
  TransportFactory,
  TransportHandlers,
} from '../src/transport/types.js'

function fakeTransport(server: (msg: JsonRpcMessage, push: (m: JsonRpcMessage) => void) => void) {
  let handlers!: TransportHandlers
  const factory: TransportFactory = async (h) => {
    handlers = h
    const t: Transport = {
      kind: 'inproc',
      async send(msg) {
        server(msg, (m) => handlers.onMessage(m))
      },
      async close() {
        handlers.onClose({ reason: 'closed' })
      },
    }
    return t
  }
  return {
    factory,
    get handlers() {
      return handlers
    },
  }
}

// Records outbound messages and answers nothing: a test with two requests in flight has to
// pick the order and the timing of the replies itself.
function recording() {
  const sent: JsonRpcMessage[] = []
  const ft = fakeTransport((msg) => {
    sent.push(msg)
  })
  return {
    factory: ft.factory,
    sent,
    ids: () => sent.map((m) => (m as JsonRpcRequest).id),
    get handlers() {
      return ft.handlers
    },
  }
}

// Timeout and close paths run on fake timers: a real sleep makes these slow and flaky on a busy machine.
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('RpcConnection', () => {
  it('correlates responses by id and delivers notifications', async () => {
    const seen: string[] = []
    const ft = fakeTransport((msg, push) => {
      if ('id' in msg && 'method' in msg) push({ jsonrpc: '2.0', id: msg.id, result: { echo: msg.method } })
    })
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    c.onNotification((m) => seen.push(m))
    const p = c.request<{ echo: string }>('initialize', {})
    ft.handlers.onMessage({ jsonrpc: '2.0', method: 'session/update', params: {} })
    expect(await p).toEqual({ echo: 'initialize' })
    expect(seen).toEqual(['session/update'])
  })

  it('connect() is idempotent and builds the transport once', async () => {
    let built = 0
    const ft = fakeTransport(() => {})
    const counting: TransportFactory = async (h) => {
      built++
      return ft.factory(h)
    }
    const c = new RpcConnection(counting, { requestTimeoutMs: 1000 })
    await c.connect()
    await c.connect()
    expect(built).toBe(1)
    expect(c.connected).toBe(true)
  })

  it('turns error responses into JsonRpcError', async () => {
    const ft = fakeTransport((msg, push) => {
      if ('id' in msg)
        push({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32002, message: 'SESSION_BUSY', data: { code: 'SESSION_BUSY' } },
        })
    })
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    await expect(c.request('session/prompt', {})).rejects.toBeInstanceOf(JsonRpcError)
  })

  it('ignores responses whose id matches nothing pending', async () => {
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    expect(() => ft.handlers.onMessage({ jsonrpc: '2.0', id: 999, result: {} })).not.toThrow()
  })

  it('times out requests and honours null timeout', async () => {
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 20 })
    await c.connect()
    // Attach the catch before advancing the clock. A promise rejected inside a fake-timer tick
    // with no rejection handler yet is reported as an unhandled rejection, which fails the run
    // even though the assertion below would pass.
    const timed = c.request('x', {}).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(20)
    expect(await timed).toBeInstanceOf(RequestTimeout)

    // timeoutMs: null means no deadline at all. A dropped connection is what ends such a request,
    // not a timer.
    const never = c.request('session/prompt', {}, { timeoutMs: null })
    let settled = false
    never.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await vi.advanceTimersByTimeAsync(60_000)
    expect(settled).toBe(false)
    await c.close()
    await expect(never).rejects.toBeInstanceOf(TransportClosed)
  })

  it('rejects on an AbortSignal, before and after the request is issued', async () => {
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    const live = new AbortController()
    const p = c.request('x', {}, { signal: live.signal })
    live.abort()
    await expect(p).rejects.toThrow()
    const dead = AbortSignal.abort()
    await expect(c.request('x', {}, { signal: dead })).rejects.toThrow()
  })

  it('answers server requests through the registered handler and rejects unknown ones', async () => {
    const sent: JsonRpcMessage[] = []
    const ft = fakeTransport((msg) => {
      sent.push(msg)
    })
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    c.onServerRequest(async (method, params) =>
      method === 'session/request_permission'
        ? { outcome: { outcome: 'selected', optionId: 'reject_once' }, echoed: params }
        : Promise.reject(
            new JsonRpcError({
              code: -32601,
              message: 'METHOD_NOT_FOUND',
              data: { code: 'METHOD_NOT_FOUND' },
            }),
          ),
    )
    ft.handlers.onMessage({
      jsonrpc: '2.0',
      id: 'srv-1',
      method: 'session/request_permission',
      params: { q: 1 },
    })
    ft.handlers.onMessage({ jsonrpc: '2.0', id: 'srv-2', method: 'nope', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'srv-1',
        result: { outcome: { outcome: 'selected', optionId: 'reject_once' }, echoed: { q: 1 } },
      },
      {
        jsonrpc: '2.0',
        id: 'srv-2',
        error: { code: -32601, message: 'METHOD_NOT_FOUND', data: { code: 'METHOD_NOT_FOUND' } },
      },
    ])
  })

  it('answers METHOD_NOT_FOUND when no server-request handler is registered, and after the disposer runs', async () => {
    const sent: JsonRpcMessage[] = []
    const ft = fakeTransport((msg) => {
      sent.push(msg)
    })
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    ft.handlers.onMessage({ jsonrpc: '2.0', id: 'a', method: 'session/request_permission', params: {} })
    const dispose = c.onServerRequest(async () => ({ ok: true }))
    dispose()
    ft.handlers.onMessage({ jsonrpc: '2.0', id: 'b', method: 'session/request_permission', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.map((m) => (m as { error?: { code: number } }).error?.code)).toEqual([-32601, -32601])
  })

  it('wraps a non-JsonRpcError thrown by the server-request handler as INTERNAL_ERROR', async () => {
    const sent: JsonRpcMessage[] = []
    const ft = fakeTransport((msg) => {
      sent.push(msg)
    })
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    c.onServerRequest(async () => {
      throw new Error('boom')
    })
    ft.handlers.onMessage({ jsonrpc: '2.0', id: 'x', method: 'session/request_permission', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'x',
        error: { code: -32603, message: 'INTERNAL_ERROR', data: { code: 'INTERNAL_ERROR' } },
      },
    ])
  })

  it('drops notification handlers once their disposer runs', async () => {
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    const seen: string[] = []
    const dispose = c.onNotification((m) => seen.push(m))
    ft.handlers.onMessage({ jsonrpc: '2.0', method: 'a' })
    dispose()
    ft.handlers.onMessage({ jsonrpc: '2.0', method: 'b' })
    expect(seen).toEqual(['a'])
  })

  it('rejects all pending with TransportClosed when the transport drops', async () => {
    const closed: string[] = []
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, {
      requestTimeoutMs: 1000,
      onClose: (info) => closed.push(info.reason),
    })
    await c.connect()
    const p = c.request('x', {})
    ft.handlers.onClose({ reason: 'eof' })
    await expect(p).rejects.toBeInstanceOf(TransportClosed)
    expect(c.connected).toBe(false)
    expect(closed).toEqual(['eof'])
    // After the drop, a request or a notification fails immediately instead of being swallowed.
    await expect(c.request('x', {})).rejects.toBeInstanceOf(TransportClosed)
    await expect(c.notify('x', {})).rejects.toBeInstanceOf(TransportClosed)
  })

  // The tests below exist to pin the correlate-by-id invariant itself: replacing the per-request
  // id with a constant has to turn them red. That only works while two or more requests are in
  // flight at the same time — with at most one outstanding request, an id is never actually used.
  it('correlates two in-flight requests when the replies arrive out of order', async () => {
    const r = recording()
    const c = new RpcConnection(r.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    const a = c.request<string>('first', {})
    const b = c.request<string>('second', {})
    const [ia, ib] = r.ids()
    // Two in-flight requests must get different ids: a shared id makes the second one evict the
    // first from the pending table.
    expect(new Set(r.ids()).size).toBe(2)
    r.handlers.onMessage({ jsonrpc: '2.0', id: ib as JsonRpcId, result: 'B' })
    r.handlers.onMessage({ jsonrpc: '2.0', id: ia as JsonRpcId, result: 'A' })
    expect(await b).toBe('B')
    expect(await a).toBe('A')
  })

  it('drops a late reply for a timed-out id instead of settling a live request', async () => {
    const r = recording()
    const c = new RpcConnection(r.factory, { requestTimeoutMs: 20 })
    await c.connect()
    const first = c.request('slow', {}).catch((e: unknown) => e)
    const [stale] = r.ids()
    await vi.advanceTimersByTimeAsync(20)
    expect(await first).toBeInstanceOf(RequestTimeout)

    const second = c.request('next', {}, { timeoutMs: null })
    let settled: unknown = null
    void second.then(
      (v) => {
        settled = { v }
      },
      (e: unknown) => {
        settled = { e }
      },
    )
    // A timed-out id is not reused, so the late reply can neither revive the dead request nor be
    // inherited by the live one.
    expect(r.ids()[1]).not.toBe(stale)
    expect(() =>
      r.handlers.onMessage({ jsonrpc: '2.0', id: stale as JsonRpcId, result: 'late' }),
    ).not.toThrow()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(null)
    await c.close()
    await expect(second).rejects.toBeInstanceOf(TransportClosed)
  })

  it('answers a server request while a client request is still in flight', async () => {
    const r = recording()
    const c = new RpcConnection(r.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    c.onServerRequest(async (method) => ({ answered: method }))
    const p = c.request<string>('client-side', {}, { timeoutMs: null })
    const [mine] = r.ids()
    r.handlers.onMessage({ jsonrpc: '2.0', id: 'srv', method: 'session/request_permission', params: {} })
    await vi.advanceTimersByTimeAsync(0)
    // The two directions stay independent: the inbound request is answered under its own id while
    // the outbound request is still pending.
    expect(r.ids()).toEqual([mine, 'srv'])
    expect(mine).not.toBe('srv')
    r.handlers.onMessage({ jsonrpc: '2.0', id: mine as JsonRpcId, result: 'mine' })
    expect(await p).toBe('mine')
  })

  it('rejects every pending request when the transport closes, not just the last one', async () => {
    const r = recording()
    const c = new RpcConnection(r.factory, { requestTimeoutMs: 1000 })
    await c.connect()
    const a = c.request('a', {}).catch((e: unknown) => e)
    const b = c.request('b', {}).catch((e: unknown) => e)
    const d = c.request('d', {}).catch((e: unknown) => e)
    expect(new Set(r.ids()).size).toBe(3)
    r.handlers.onClose({ reason: 'eof' })
    expect(await a).toBeInstanceOf(TransportClosed)
    expect(await b).toBeInstanceOf(TransportClosed)
    expect(await d).toBeInstanceOf(TransportClosed)
  })

  it('connect() called twice concurrently builds the transport once', async () => {
    let built = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const ft = fakeTransport(() => {})
    // Both connect() calls park inside the factory, so neither has seen the connection open yet.
    // An idempotency test that awaits sequentially never opens this window.
    const slow: TransportFactory = async (h) => {
      built++
      await gate
      return ft.factory(h)
    }
    const c = new RpcConnection(slow, { requestTimeoutMs: 1000 })
    const first = c.connect()
    const second = c.connect()
    release()
    await Promise.all([first, second])
    expect(built).toBe(1)
    expect(c.connected).toBe(true)
  })

  it('settles pending and marks itself closed even when transport.close() throws', async () => {
    const closed: string[] = []
    const factory: TransportFactory = async () => {
      const t: Transport = {
        kind: 'inproc',
        async send() {},
        async close() {
          throw new Error('close failed')
        },
      }
      return t
    }
    const c = new RpcConnection(factory, {
      requestTimeoutMs: 1000,
      onClose: (info) => closed.push(info.reason),
    })
    await c.connect()
    const p = c.request('x', {}, { timeoutMs: null }).catch((e: unknown) => e)
    await expect(c.close()).rejects.toThrow('close failed')
    expect(await p).toBeInstanceOf(TransportClosed)
    expect(c.connected).toBe(false)
    expect(closed).toEqual(['closed'])
  })

  it('buffers messages that arrive before the factory returns the transport', async () => {
    const sent: JsonRpcMessage[] = []
    const seen: string[] = []
    let handlers!: TransportHandlers
    // A stdio read loop or a replayed buffer can hand the first messages over while the factory
    // is still awaiting, i.e. before there is a transport to answer on. Those messages have to be
    // held and then released in arrival order.
    const factory: TransportFactory = async (h) => {
      handlers = h
      h.onMessage({ jsonrpc: '2.0', method: 'first' })
      h.onMessage({ jsonrpc: '2.0', id: 'early', method: 'session/request_permission', params: {} })
      h.onMessage({ jsonrpc: '2.0', method: 'second' })
      const t: Transport = {
        kind: 'inproc',
        async send(msg) {
          sent.push(msg)
        },
        async close() {
          handlers.onClose({ reason: 'closed' })
        },
      }
      return t
    }
    const c = new RpcConnection(factory, { requestTimeoutMs: 1000 })
    c.onServerRequest(async () => ({ ok: true }))
    c.onNotification((method) => {
      seen.push(method)
      // Feeding a message back in from inside a dispatch is the reordering hazard: it must join the
      // tail of the queue being drained, not jump ahead of what is still buffered.
      if (method === 'first') handlers.onMessage({ jsonrpc: '2.0', method: 'reentrant' })
    })
    await c.connect()
    await vi.advanceTimersByTimeAsync(0)
    // Without buffering the reply is dropped on the floor, because there is no transport to send on.
    expect(sent).toEqual([{ jsonrpc: '2.0', id: 'early', result: { ok: true } }])
    expect(seen).toEqual(['first', 'second', 'reentrant'])
  })

  it('close() on a never-connected connection reports nothing', async () => {
    const closed: string[] = []
    const ft = fakeTransport(() => {})
    const c = new RpcConnection(ft.factory, {
      requestTimeoutMs: 1000,
      onClose: (info) => closed.push(info.reason),
    })
    await c.close()
    expect(closed).toEqual([])
  })

  it('closes the transport once however often close() is called', async () => {
    const closed: string[] = []
    let closes = 0
    const factory: TransportFactory = async (h) => ({
      kind: 'inproc',
      async send() {},
      async close() {
        closes++
        h.onClose({ reason: 'closed' })
      },
    })
    const c = new RpcConnection(factory, {
      requestTimeoutMs: 1000,
      onClose: (info) => closed.push(info.reason),
    })
    await c.connect()
    await c.close()
    await c.close()
    expect(closed).toEqual(['closed'])
    expect(closes).toBe(1)
  })

  // A closed connection is not a connection any more. Without the latch, connect() sees
  // `open === false`, builds a second transport, and the caller who closed this one is
  // talking to a process it believed it had killed.
  it('refuses to connect, request or notify after close(), and builds no second transport', async () => {
    let built = 0
    const ft = fakeTransport(() => {})
    const counting: TransportFactory = async (h) => {
      built++
      return ft.factory(h)
    }
    const c = new RpcConnection(counting, { requestTimeoutMs: 1000 })
    await c.connect()
    await c.close()

    await expect(c.connect()).rejects.toBeInstanceOf(TransportClosed)
    await expect(c.request('x', {})).rejects.toBeInstanceOf(TransportClosed)
    await expect(c.notify('x', {})).rejects.toBeInstanceOf(TransportClosed)
    expect(built).toBe(1)
    expect(c.connected).toBe(false)
  })

  // The transport reference outlives its own close report: whatever it was built on is
  // still open, and close() is the only thing left that can hand it back.
  it('closes the transport even when it already reported its own end', async () => {
    let closes = 0
    let handlers!: TransportHandlers
    const factory: TransportFactory = async (h) => {
      handlers = h
      return {
        kind: 'inproc',
        async send() {},
        async close() {
          closes++
        },
      }
    }
    const c = new RpcConnection(factory, { requestTimeoutMs: 1000 })
    await c.connect()
    handlers.onClose({ reason: 'eof' })
    expect(c.connected).toBe(false)

    await c.close()

    expect(closes).toBe(1)
  })
})
