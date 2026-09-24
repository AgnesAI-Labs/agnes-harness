import { METHODS, type MethodName, rpcError } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { LocalEndpoint } from '../src/local/endpoint.js'
import type { JsonRpcMessage } from '../src/rpc.js'

async function next<T>(it: AsyncIterator<T>): Promise<T> {
  const r = await it.next()
  if (r.done) throw new Error('done')
  return r.value
}

/** A permission request its own schema accepts: outbound frames are validated on the way out, so a
 *  half-built one here would be refused for its shape and the case would stop being about ids and
 *  timers. */
const permReq = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 's',
  toolCall: { toolCallId: 't1' },
  options: [],
  ...o,
})

const INIT_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
}

async function initialized(): Promise<LocalEndpoint> {
  const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
  ep.register('initialize', async (_p, cx) => {
    cx.conn.initialized = true
    return { protocolVersion: 1, agentCapabilities: {} }
  })
  await ep.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: INIT_PARAMS })
  return ep
}

describe('LocalEndpoint', () => {
  it('correlates unexpected failures without exposing secrets and tolerates a failed audit sink', async () => {
    for (const broken of [false, true]) {
      const records: unknown[] = []
      const ep = new LocalEndpoint({
        clock: () => 0,
        principalId: 'local',
        audit: (record) => {
          records.push(record)
          if (broken) throw new Error('audit unavailable')
        },
      })
      ep.register('initialize', async () => {
        throw Object.assign(new Error('private-message-and-token'), { code: 'EACCES' })
      })
      const result = await ep.handle({
        jsonrpc: '2.0',
        id: 'user-secret-id',
        method: 'initialize',
        params: INIT_PARAMS,
      })
      expect(result).toMatchObject({
        error: {
          code: -32603,
          data: {
            code: 'INTERNAL',
            ...(broken ? { diagnosticUnavailable: true } : { diagnosticId: expect.any(String) }),
          },
        },
      })
      if (broken) expect(JSON.stringify(result)).not.toContain('diagnosticId')
      expect(records).toEqual([
        {
          kind: 'daemon.request_failed',
          detail: { method: 'initialize', errorCode: 'EACCES', diagnosticId: expect.any(String) },
        },
      ])
      expect(JSON.stringify(records)).not.toContain('private-message-and-token')
      expect(JSON.stringify(records)).not.toContain('user-secret-id')
      await ep.close()
    }
  })
  it('refuses new calls after intake stops while preserving outbound shutdown notices', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.register('initialize', async (_params, cx) => {
      cx.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {} }
    })
    const notifications = ep.notifications[Symbol.asyncIterator]()
    ep.stopIntake()
    ep.push({
      jsonrpc: '2.0',
      method: '_agnes/v1/daemon.notice',
      params: { kind: 'shutting_down', detail: {}, at: '1970-01-01T00:00:00.000Z' },
    })
    expect((await notifications.next()).value).toMatchObject({
      method: '_agnes/v1/daemon.notice',
      params: { kind: 'shutting_down' },
    })
    await expect(
      ep.handle({ jsonrpc: '2.0', id: 'late', method: 'initialize', params: INIT_PARAMS }),
    ).resolves.toMatchObject({
      id: 'late',
      error: { code: -32600, data: { code: 'SHUTTING_DOWN' } },
    })
    await ep.close()
  })

  it('rejects methods before initialize and unknown methods', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.register('_agnes/v1/apis.list', async () => ({ families: [] }))
    const r1 = await ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/apis.list', params: {} })
    expect(r1).toMatchObject({ id: 1, error: { code: -32600, data: { code: 'NOT_INITIALIZED' } } })
    ep.register('initialize', async (_p, cx) => {
      cx.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {} }
    })
    await ep.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: INIT_PARAMS })
    const r3 = await ep.handle({ jsonrpc: '2.0', id: 3, method: 'nope/x', params: {} })
    expect(r3).toMatchObject({
      id: 3,
      error: { code: -32601, data: { code: 'METHOD_NOT_FOUND', method: 'nope/x' } },
    })
  })

  it('validates params and maps handler RpcError', async () => {
    const ep = await initialized()
    ep.register('_agnes/v1/session.attach', async () => {
      throw rpcError('SESSION_NOT_FOUND', {})
    })
    const bad = await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: '_agnes/v1/session.attach',
      params: { sessionId: 's', seams: {} },
    })
    expect(bad).toMatchObject({ id: 2, error: { code: -32602, data: { code: 'UNKNOWN_KEY', key: 'seams' } } })
    const nf = await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/session.attach',
      params: { sessionId: 's' },
    })
    expect(nf).toMatchObject({ id: 3, error: { code: -32003, data: { code: 'SESSION_NOT_FOUND' } } })
  })

  // The gate is METHODS membership and the direction recorded beside it, so the methods protocol
  // adds arrive without this file changing. A count or a written-out list here would have to be
  // edited on that day; this does not.
  it('the method gate is METHODS itself, not a list restated here', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const names = Object.keys(METHODS) as MethodName[]
    expect(names.length).toBeGreaterThan(0)
    for (const name of names)
      ep.register(name, async (_p, cx) => {
        cx.conn.initialized = true
        return {}
      })
    await ep.handle({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: INIT_PARAMS })
    const gated: string[] = []
    for (const name of names) {
      const r = (await ep.handle({ jsonrpc: '2.0', id: name, method: name, params: {} })) as
        | { error?: { code: number } }
        | undefined
      if (r?.error?.code === -32601) gated.push(name)
    }
    // Exactly the names the server addresses to the client are refused, and which ones those are is
    // read off the table rather than written down here.
    expect(gated).toEqual(names.filter((n) => METHODS[n].direction === 's2c'))
    // A name that can never become a method. Probing with a real one would restate the table's
    // contents in the one test whose job is to prove that nothing here does.
    const unknown = await ep.handle({ jsonrpc: '2.0', id: 'u', method: 'nope/x', params: {} })
    expect(unknown).toMatchObject({ error: { code: -32601, data: { code: 'METHOD_NOT_FOUND' } } })

    // A name added to the table is accepted without this file changing. A gate holding its own copy
    // of the eleven names present today would refuse it, and every assertion above would still pass.
    const table = METHODS as unknown as Record<string, unknown>
    const added = '_agnes/v1/probe.added' as MethodName
    // The probe spec carries no `result`: this case is about the gate, and a spec that declared one
    // would make the assertion below fail on the shape of the probe's answer instead.
    const { result: _unused, ...gateOnly } = METHODS['_agnes/v1/apis.list']
    table[added] = gateOnly
    try {
      ep.register(added, async () => ({ added: true }))
      expect(await ep.handle({ jsonrpc: '2.0', id: 'a', method: added, params: {} })).toMatchObject({
        result: { added: true },
      })
    } finally {
      delete table[added]
    }
    expect(await ep.handle({ jsonrpc: '2.0', id: 'b', method: added, params: {} })).toMatchObject({
      error: { code: -32601, data: { code: 'METHOD_NOT_FOUND' } },
    })
  })

  // Direction lives in the same table entry as the schemas, so a name the server addresses to the
  // client is refused on that record and not on whether something registered a handler for it.
  it('refuses a client call on a server-to-client method, reading direction off the live table', async () => {
    const ep = await initialized()
    const table = METHODS as unknown as Record<string, unknown>
    // No `result` on the probe spec, for the same reason as the case above: this one is about
    // direction, and the answer's shape must not be what decides it.
    const { result: _unused, ...spec } = METHODS['_agnes/v1/apis.list']
    const added = '_agnes/v1/probe.direction' as MethodName
    let ran = 0
    table[added] = { ...spec, direction: 's2c' }
    try {
      ep.register(added, async () => {
        ran++
        return { ran: true }
      })
      expect(await ep.handle({ jsonrpc: '2.0', id: 1, method: added, params: {} })).toMatchObject({
        error: { code: -32601, data: { code: 'WRONG_DIRECTION', method: added } },
      })
      expect(ran).toBe(0)
      // The same registered handler under the same name, with only the recorded direction flipped,
      // is reached. So it is the table's direction that refused the first call, not the name.
      table[added] = { ...spec, direction: 'c2s' }
      expect(await ep.handle({ jsonrpc: '2.0', id: 2, method: added, params: {} })).toMatchObject({
        result: { ran: true },
      })
      expect(ran).toBe(1)
    } finally {
      delete table[added]
    }
  })

  it('a second handler for a method is refused rather than replacing the first', async () => {
    const ep = await initialized()
    let ran = 0
    ep.register('_agnes/v1/apis.list', async () => {
      ran++
      return { families: [] }
    })
    expect(() => ep.register('_agnes/v1/apis.list', async () => ({}))).toThrow(/duplicate handler/)
    await ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/apis.list', params: {} })
    expect(ran).toBe(1)
  })

  it('a known method with no handler is refused as NOT_REGISTERED, not as unknown', async () => {
    const ep = await initialized()
    const r = await ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/apis.list', params: {} })
    expect(r).toMatchObject({
      error: { code: -32601, data: { code: 'NOT_REGISTERED', method: '_agnes/v1/apis.list' } },
    })
  })

  it.each([
    new Error('PRIVATE-CREDENTIAL'),
    'PRIVATE-CREDENTIAL',
    {
      toString() {
        throw new Error('PRIVATE-CREDENTIAL')
      },
    },
  ])('unexpected handler failures return a fixed INTERNAL response', async (failure) => {
    const ep = await initialized()
    ep.register('_agnes/v1/apis.list', async () => {
      throw failure
    })
    const r = await ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/apis.list', params: {} })
    expect(r).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32603, message: 'INTERNAL_ERROR', data: { code: 'INTERNAL' } },
    })
    expect(JSON.stringify(r)).not.toContain('PRIVATE-CREDENTIAL')
    await ep.close()
  })

  it('a notification never gets a response, whichever check fires', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let ran = 0
    // Not initialized yet.
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }),
    ).toBeUndefined()
    ep.register('initialize', async (_p, cx) => {
      cx.conn.initialized = true
      return {}
    })
    await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS })
    // Unknown method.
    expect(await ep.handle({ jsonrpc: '2.0', method: 'nope/x', params: {} })).toBeUndefined()
    // Invalid params.
    let mode: 'ok' | 'throw' = 'ok'
    ep.register('session/cancel', async () => {
      ran++
      if (mode === 'throw') throw new Error('boom')
      return { acknowledged: true }
    })
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { bogus: 1 } }),
    ).toBeUndefined()
    expect(ran).toBe(0)
    // Handler ran and returned a value: there is still nowhere to put it.
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }),
    ).toBeUndefined()
    expect(ran).toBe(1)
    // Handler ran and threw.
    mode = 'throw'
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }),
    ).toBeUndefined()
    expect(ran).toBe(2)
  })

  it('a message that is neither a request, a notification nor a response is dropped', async () => {
    const ep = await initialized()
    let ran = 0
    ep.register('_agnes/v1/apis.list', async () => {
      ran++
      return { families: [] }
    })
    expect(await ep.handle({ jsonrpc: '2.0' } as never)).toBeUndefined()
    // Undefined is also what an unhandled notification returns, so the drop is separated from the
    // fall-through by the handler staying untouched and nothing being written out.
    expect(ran).toBe(0)
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
  })

  it('correlates a server-to-client request with its response', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = ep.request('session/request_permission', permReq())
    const sent = (await next(it)) as { id: string; method: string }
    expect(sent.method).toBe('session/request_permission')
    await ep.handle({
      jsonrpc: '2.0',
      id: sent.id,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    })
    await expect(p).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } })
    expect(ep.pendingRequests()).toBe(0)
  })

  it('an error response rejects the waiting request, and an unknown id is ignored', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = ep.request('session/request_permission', permReq())
    const sent = (await next(it)) as { id: string }
    expect(await ep.handle({ jsonrpc: '2.0', id: 'not-mine', result: {} })).toBeUndefined()
    expect(ep.pendingRequests()).toBe(1)
    await ep.handle({ jsonrpc: '2.0', id: sent.id, error: rpcError('SESSION_BUSY', {}) })
    await expect(p).rejects.toMatchObject({ code: -32002 })
  })

  it('push delivers notifications in order and close ends the stream', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    ep.push({ jsonrpc: '2.0', method: 'a', params: 1 })
    ep.push({ jsonrpc: '2.0', method: 'b', params: 2 })
    expect(ep.pending().events).toBe(2)
    expect(ep.pending().bytes).toBeGreaterThan(0)
    expect(((await next(it)) as { method: string }).method).toBe('a')
    expect(((await next(it)) as { method: string }).method).toBe('b')
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
    expect((await it.next()).done).toBe(true)
  })

  // The backlog is what a bounded feed measures, so it must count values in and out rather than let
  // a push that finds a waiting consumer bypass the accounting.
  it('a consumer that was already waiting still receives pushes once, in order', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const first = it.next()
    ep.push({ jsonrpc: '2.0', method: 'a', params: 1 })
    ep.push({ jsonrpc: '2.0', method: 'b', params: 2 })
    expect(((await first).value as { method: string }).method).toBe('a')
    expect(((await next(it)) as { method: string }).method).toBe('b')
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    // The second push found no waiter, so it was counted in and then counted back out.
    ep.push({ jsonrpc: '2.0', method: 'c', params: 3 })
    expect(ep.pending().events).toBe(1)
    const queued = { jsonrpc: '2.0', method: 'c', params: 3 }
    expect(ep.pending().bytes).toBe(Buffer.byteLength(JSON.stringify(queued), 'utf8'))
    await next(it)
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
  })

  it('counts pending bytes as utf8, not javascript string length', () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const msg = { jsonrpc: '2.0' as const, method: 'cjk', params: '你' }
    ep.push(msg)
    const utf8 = Buffer.byteLength(JSON.stringify(msg), 'utf8')
    expect(ep.pending().bytes).toBe(utf8)
    expect(utf8).toBeGreaterThan(JSON.stringify(msg).length)
  })

  it('is terminal after close: a request gets -32600 CLOSED instead of reaching a handler', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    let calls = 0
    ep.register('initialize', async (_p, cx) => {
      calls++
      cx.conn.initialized = true
      return { protocolVersion: 1, agentCapabilities: {} }
    })
    await ep.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INIT_PARAMS })
    await ep.close()
    const after = await ep.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: INIT_PARAMS })
    expect(after).toMatchObject({ id: 2, error: { code: -32600, data: { code: 'CLOSED' } } })
    expect(calls).toBe(1)
    expect(
      await ep.handle({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } }),
    ).toBeUndefined()
  })

  it('close rejects what was in flight, drops later pushes, and a second close is a no-op', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = ep.request('session/request_permission', permReq())
    await next(it)
    await ep.close()
    await expect(p).rejects.toMatchObject({ code: -32603, data: { code: 'CLOSED' } })
    expect(ep.pendingRequests()).toBe(0)
    ep.push({ jsonrpc: '2.0', method: 'late', params: {} })
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    await ep.close()
    expect((await it.next()).done).toBe(true)
  })

  // Without this the caller waits on a promise nothing can ever settle: the queue its request was
  // written to is closed, so no client will ever see it and no response can arrive.
  it('a server-to-client request raised after close is refused rather than left hanging', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    await ep.close()
    await expect(ep.request('session/request_permission', {})).rejects.toMatchObject({
      code: -32603,
      data: { code: 'CLOSED' },
    })
    expect(ep.pendingRequests()).toBe(0)
    expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
  })

  it('clears the timeout timer when the answer arrives, so a settled request keeps no timer alive', async () => {
    vi.useFakeTimers()
    try {
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = ep.request('session/request_permission', permReq(), { timeoutMs: 20 })
      const sent = (await next(it)) as { id: string }
      expect(vi.getTimerCount()).toBe(1)
      await ep.handle({ jsonrpc: '2.0', id: sent.id, result: { outcome: { outcome: 'cancelled' } } })
      await expect(p).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
      expect(vi.getTimerCount()).toBe(0)
      expect(ep.pendingRequests()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops the abort listener when the answer arrives', async () => {
    const ac = new AbortController()
    // The listener that was registered is captured, so the removal is checked against that exact
    // function rather than against any function at all.
    const registered: unknown[] = []
    const add = ac.signal.addEventListener.bind(ac.signal)
    vi.spyOn(ac.signal, 'addEventListener').mockImplementation(((t: string, f: never, o: never) => {
      registered.push(f)
      add(t, f, o)
    }) as never)
    const remove = vi.spyOn(ac.signal, 'removeEventListener')
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const p = ep.request('session/request_permission', permReq(), { signal: ac.signal })
    const sent = (await next(it)) as { id: string }
    await ep.handle({ jsonrpc: '2.0', id: sent.id, result: { ok: true } })
    await expect(p).resolves.toEqual({ ok: true })
    expect(registered).toHaveLength(1)
    expect(remove).toHaveBeenCalledWith('abort', registered[0])
  })

  it('a timeout and a late answer cannot both settle the same request', async () => {
    vi.useFakeTimers()
    try {
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = ep.request('session/request_permission', permReq(), { timeoutMs: 10 })
      const sent = (await next(it)) as { id: string }
      const settled = p.catch((e: unknown) => e as { data: { code: string } })
      await vi.advanceTimersByTimeAsync(20)
      expect(await settled).toMatchObject({ code: -32603, data: { code: 'TIMEOUT' } })
      expect(ep.pendingRequests()).toBe(0)
      expect(await ep.handle({ jsonrpc: '2.0', id: sent.id, result: { late: true } })).toBeUndefined()
      expect(await settled).toMatchObject({ data: { code: 'TIMEOUT' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('an abort rejects the request and stops the timer', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
      const it = ep.notifications[Symbol.asyncIterator]()
      const p = ep.request('session/request_permission', permReq(), { timeoutMs: 1000, signal: ac.signal })
      await next(it)
      ac.abort()
      await expect(p).rejects.toMatchObject({ code: -32603, data: { code: 'ABORTED' } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  // principalId is the server's word about the connection; clientId is a label the client wrote.
  // Anything that must be one bucket per identity keys on the first, so the first must not be
  // writable by anything a handler can reach.
  it('separates the server-set principal from the client-written label, and the principal cannot be reassigned', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.register('initialize', async (p, cx) => {
      cx.conn.initialized = true
      cx.conn.clientId = (p as { clientId: string }).clientId
      return {}
    })
    await ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { ...INIT_PARAMS, clientId: 'whatever-i-like' } as never,
    })
    expect(ep.conn.clientId).toBe('whatever-i-like')
    expect(ep.conn.principalId).toBe('local')
    expect(() => {
      ;(ep.conn as { principalId: string }).principalId = 'root'
    }).toThrow(TypeError)
    expect(ep.conn.principalId).toBe('local')
  })

  // A client that stops reading for a moment and then finds the stream closed still needs the last
  // notifications of the session - a final turn/end among them - so closing ends the stream without
  // throwing away what is already in it.
  it('close lets everything already queued be read before the stream ends', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    ep.push({ jsonrpc: '2.0', method: 'a', params: 1 })
    ep.push({ jsonrpc: '2.0', method: 'b', params: 2 })
    await ep.close()
    const it = ep.notifications[Symbol.asyncIterator]()
    expect(((await next(it)) as { method: string }).method).toBe('a')
    expect(((await next(it)) as { method: string }).method).toBe('b')
    expect((await it.next()).done).toBe(true)
  })

  it('a consumer waiting when close arrives is handed the backlog, then done', async () => {
    const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
    const it = ep.notifications[Symbol.asyncIterator]()
    const first = it.next()
    ep.push({ jsonrpc: '2.0', method: 'a', params: 1 })
    ep.push({ jsonrpc: '2.0', method: 'b', params: 2 })
    await ep.close()
    expect(((await first).value as { method: string }).method).toBe('a')
    expect(((await next(it)) as { method: string }).method).toBe('b')
    expect((await it.next()).done).toBe(true)
  })

  // A listener added to a signal that has already fired never runs, so without the up-front check
  // this request would sit unsettled forever with a live timer behind it.
  it('a request raised on an already-aborted signal is refused rather than left hanging', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      ac.abort()
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
      await expect(
        ep.request('session/request_permission', {}, { timeoutMs: 1000, signal: ac.signal }),
      ).rejects.toMatchObject({ code: -32603, data: { code: 'ABORTED' } })
      expect(ep.pendingRequests()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('params that cannot be serialised leave no entry, no timer and no listener behind', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const add = vi.spyOn(ac.signal, 'addEventListener')
      const ep = new LocalEndpoint({ clock: () => 0, principalId: 'local' })
      const circular: Record<string, unknown> = {}
      circular.self = circular
      await expect(
        ep.request(
          'session/request_permission',
          permReq({ toolCall: { toolCallId: 't1', rawInput: circular } }),
          {
            timeoutMs: 1000,
            signal: ac.signal,
          },
        ),
      ).rejects.toBeInstanceOf(TypeError)
      expect(ep.pendingRequests()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(add).not.toHaveBeenCalled()
      expect(ep.pending()).toEqual({ events: 0, bytes: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a response is never confused with a request that carries the same id', async () => {
    const ep = await initialized()
    let ran = 0
    // A result its own schema accepts: results are validated on the way out, so a stub returning `{}`
    // here would be refused for its shape and the case would stop being about ids.
    const result = {
      profile: { name: 'p', resolvedProfileHash: null, presets: { default: 'd', allowed: ['d'] } },
      families: [],
    }
    ep.register('_agnes/v1/apis.list', async () => {
      ran++
      return result
    })
    const r = (await ep.handle({
      jsonrpc: '2.0',
      id: 'x',
      method: '_agnes/v1/apis.list',
      params: {},
    })) as JsonRpcMessage
    expect(r).toMatchObject({ id: 'x', result })
    expect(ran).toBe(1)
  })
})
