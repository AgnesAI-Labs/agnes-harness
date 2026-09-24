import { META_KEY, METHODS } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localAuth } from '../src/auth.js'
import { createClient } from '../src/client.js'
import { Emitter } from '../src/events.js'
import { memoryJournal } from '../src/journal.js'
import type { RpcEndpoint } from '../src/transport/inproc.js'
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  TransportFactory,
  TransportHandlers,
} from '../src/transport/types.js'
import { fakeEndpoint, flush } from './helpers/fake-endpoint.js'

const providers = { local: () => localAuth() }

// A transport the test drives itself: it answers the handshake, counts how many times it
// was built, and can drop the connection the way a daemon exiting would.
function scriptedTransport() {
  const sent: JsonRpcMessage[] = []
  let handlers!: TransportHandlers
  let built = 0
  const factory: TransportFactory = async (h) => {
    handlers = h
    built++
    return {
      kind: 'inproc',
      async send(msg) {
        sent.push(msg)
        const req = msg as JsonRpcRequest
        if ('id' in req && req.method === 'initialize')
          h.onMessage({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: {},
              _meta: { agnes: { agnesVersion: '0.0.0-test' } },
            },
          })
      },
      async close() {
        h.onClose({ reason: 'closed' })
      },
    }
  }
  return {
    factory,
    built: () => built,
    methods: () => sent.map((m) => (m as JsonRpcRequest).method),
    drop: () => handlers.onClose({ reason: 'eof' }),
  }
}

const apisResult = {
  profile: {
    name: 'local-dev',
    resolvedProfileHash: null,
    presets: { default: 'standard', allowed: ['standard'] },
  },
  families: [],
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createClient', () => {
  it('returns to idle after a failed first handshake and can initialize again', async () => {
    let attempts = 0
    const f = fakeEndpoint({
      initialize: (params, context) => {
        attempts++
        if (attempts === 1)
          throw Object.assign(new Error('temporary'), {
            code: -32603,
            data: { code: 'INTERNAL_ERROR' },
          })
        return fakeEndpoint({}).initialize(params, context)
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const states: unknown[] = []
    c.on('connectionStateChanged', (state) => states.push(state))
    await expect(c.initialize()).rejects.toBeDefined()
    expect(c.connectionState).toBe('idle')
    await c.initialize()
    expect(c.connectionState).toBe('connected')
    expect(states).toEqual(['connecting', 'idle', 'connecting', 'connected'])
    await c.close()
  })

  it('initializes lazily once, with clientCapabilities.fs false and _meta auth/clientId', async () => {
    let initParams: unknown
    const f = fakeEndpoint({
      initialize: (p, ctx) => {
        initParams = p
        return fakeEndpoint({}).initialize(p, ctx)
      },
      '_agnes/v1/apis.list': () => apisResult,
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid-1'),
      authProviders: providers,
    })

    const apis = await c.apis()

    expect(apis.profile.name).toBe('local-dev')
    expect(f.calls.map((x) => x.method)).toEqual(['initialize', '_agnes/v1/apis.list'])
    expect(initParams).toEqual({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        _meta: { [META_KEY]: { capabilities: { permission: true } } },
      },
      _meta: { [META_KEY]: { auth: { kind: 'local' }, clientId: 'cid-1' } },
    })
    expect(await c.initialize()).toEqual({ agnesVersion: '0.0.0-test', capabilities: {} })
    expect(f.calls.filter((x) => x.method === 'initialize')).toHaveLength(1)
  })

  it('reads agnesVersion and agentCapabilities out of the initialize response', async () => {
    const f = fakeEndpoint({
      initialize: () => ({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
        _meta: { agnes: { agnesVersion: '9.9.9' } },
      }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    expect(await c.initialize()).toEqual({ agnesVersion: '9.9.9', capabilities: { loadSession: true } })
  })

  it('rejects an unsupported negotiated protocol before sending business requests', async () => {
    const f = fakeEndpoint({ initialize: () => ({ protocolVersion: 2 }) })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    try {
      await expect(c.apis()).rejects.toMatchObject({ kind: 'protocol-violation' })
      expect(f.calls.map((call) => call.method)).toEqual(['initialize'])
    } finally {
      await c.close()
    }
  })

  it('falls back to an unknown version when the server sends no agnes meta', async () => {
    const f = fakeEndpoint({ initialize: () => ({ protocolVersion: 1 }) })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    expect(await c.initialize()).toEqual({ agnesVersion: 'unknown', capabilities: {} })
  })

  // Three callers race for the handshake. A per-call initialize would put three
  // `initialize` frames on the wire and hand the server three different clientIds.
  it('performs exactly one handshake when several callers race the first call', async () => {
    let started = 0
    const f = fakeEndpoint({
      initialize: async (p, ctx) => {
        started++
        await new Promise((r) => setTimeout(r, 5))
        return fakeEndpoint({}).initialize(p, ctx)
      },
      '_agnes/v1/apis.list': () => apisResult,
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    const [a, b, info] = await Promise.all([c.apis(), c.apis(), c.initialize()])

    expect(started).toBe(1)
    expect(a).toEqual(apisResult)
    expect(b).toEqual(apisResult)
    expect(info.agnesVersion).toBe('0.0.0-test')
    expect(f.calls.filter((x) => x.method === 'initialize')).toHaveLength(1)
  })

  it('retries the handshake after a failed one instead of caching the rejection', async () => {
    let attempt = 0
    const f = fakeEndpoint({
      initialize: (p, ctx) => {
        attempt++
        if (attempt === 1) throw new Error('boom')
        return fakeEndpoint({}).initialize(p, ctx)
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    await expect(c.initialize()).rejects.toThrow('boom')
    expect((await c.initialize()).agnesVersion).toBe('0.0.0-test')
    expect(attempt).toBe(2)
  })

  it('times the handshake out on the initialize budget, not the request budget', async () => {
    vi.useFakeTimers()
    const f = fakeEndpoint({ initialize: () => new Promise(() => {}) })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
      timeouts: { initialize: 1_000, request: 90_000 },
    })

    const pending = c.initialize()
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'request-timeout', method: 'initialize' })
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('validates params and results against protocol schemas', async () => {
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/apis.list': () => ({ bogus: true }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await expect(c.apis()).rejects.toMatchObject({ kind: 'protocol-violation' })
  })

  it('rejects bad params before anything reaches the wire', async () => {
    const f = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await expect(c.call('_agnes/v1/session.attach', { sessionId: 42 })).rejects.toMatchObject({
      kind: 'protocol-violation',
    })
    expect(f.calls.map((x) => x.method)).toEqual(['initialize'])
  })

  // These four used to be exempt: the client sends or receives them and the I1 table did
  // not list them, so call() let them through unvalidated. The case asserting their
  // absence was written to go red the day protocol landed them, and protocol Task 6b did.
  // So the assertion is inverted, and it now walks call()'s validation path for real.
  it('validates the methods that used to be exempt from the table', async () => {
    for (const m of [
      'session/load',
      '_agnes/v1/session.detach',
      '_agnes/v1/session.event',
      '_agnes/v1/daemon.notice',
    ])
      expect(Object.hasOwn(METHODS, m), m).toBe(true)

    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/session.detach': () => ({}),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    expect(await c.call('_agnes/v1/session.detach', { sessionId: 's1' })).toEqual({})
    // Bad params are now caught before anything reaches the wire, which is the point of
    // landing them: `whatever` is an undeclared key on a closed object.
    await expect(c.call('_agnes/v1/session.detach', { whatever: true })).rejects.toMatchObject({
      kind: 'protocol-violation',
    })
    // A result the table calls empty and the server fills anyway is caught on the way back,
    // so the caller never sees a shape the protocol does not describe.
    const g = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/session.detach': () => ({ anything: 1 }),
    })
    const c2 = createClient({
      transport: { kind: 'inproc', endpoint: g.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await expect(c2.call('_agnes/v1/session.detach', { sessionId: 's1' })).rejects.toMatchObject({
      kind: 'protocol-violation',
    })
    // The rejected call still left, so only the second detach is missing from the log.
    expect(f.calls.map((x) => x.method)).toEqual(['initialize', '_agnes/v1/session.detach'])
  })

  // 2026-09-10: the exemption this case was written to describe has ended for `session.fork` -
  // daemon Task 10's four methods (`fork`/`list`/`setPreset`/`setModel`) landed in protocol's
  // `MethodName`/`METHODS` (commit 67348f1), so `session.fork` now has a real generated shape and
  // checkParams validates against it like any other listed method (see the case below). The
  // The I6 protocol pass has now registered daemon Task 11's remaining families too. The unlisted
  // path itself has not gone away: Channels' later `surface.note` method is still planned but has no
  // generated shape, so neither its params nor its result are checked. Naming a real future method,
  // rather than a made-up one, keeps this case going red when the table next grows into it.
  it('passes a method the table still does not list through unvalidated', async () => {
    expect(Object.hasOwn(METHODS, '_agnes/v1/surface.note')).toBe(false)
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/surface.note': () => ({ anything: 1 }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    expect(await c.call('_agnes/v1/surface.note', { whatever: true })).toEqual({ anything: 1 })
    expect(f.calls.map((x) => x.method)).toEqual(['initialize', '_agnes/v1/surface.note'])
  })

  // The positive half of the same boundary: now that `_agnes/v1/session.fork` is a real entry in
  // `METHODS`, checkParams validates its params against the generated schema (`sessionId` + `at`,
  // both required, no extra properties) before the frame ever reaches the transport - the opposite
  // of the case above, and the reason `session.fork` could not keep standing in for "unlisted".
  it("validates a now-listed method's params against its real schema instead of passing them through", async () => {
    expect(Object.hasOwn(METHODS, '_agnes/v1/session.fork')).toBe(true)
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/session.fork': () => ({ sessionId: 's2' }),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await expect(c.call('_agnes/v1/session.fork', { whatever: true })).rejects.toMatchObject({
      kind: 'protocol-violation',
    })
    // Rejected before the frame left: initialize is the only call the fake transport ever saw.
    expect(f.calls.map((x) => x.method)).toEqual(['initialize'])
    expect(await c.call('_agnes/v1/session.fork', { sessionId: 's1', at: 1 })).toEqual({ sessionId: 's2' })
    expect(f.calls.map((x) => x.method)).toEqual(['initialize', '_agnes/v1/session.fork'])
  })

  it('runs the handshake before the first notification leaves', async () => {
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      'session/cancel': () => undefined,
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    await c.notify('session/cancel', { sessionId: 's1' })

    expect(f.calls.map((x) => x.method)).toEqual(['initialize', 'session/cancel'])
  })

  it('emits closed and is idempotent on close', async () => {
    const f = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const seen: unknown[] = []
    const states: unknown[] = []
    c.on('closed', (p) => seen.push(p))
    c.on('connectionStateChanged', (state) => states.push(state))
    expect(c.connectionState).toBe('idle')
    await c.initialize()
    expect(c.connectionState).toBe('connected')
    await c.close()
    await c.close()
    await flush()
    expect(seen).toEqual([{ reason: 'closed' }])
    expect(states).toEqual(['connecting', 'connected', 'closed'])
  })

  it('still emits closed once for a client that never connected', async () => {
    const f = fakeEndpoint({})
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const seen: unknown[] = []
    c.on('closed', (p) => seen.push(p))
    await c.close()
    await c.close()
    expect(seen).toEqual([{ reason: 'closed' }])
    expect(c.connectionState).toBe('closed')
  })

  // Closing has to be the end of the client. Otherwise the next call re-runs the
  // handshake, which reconnects, which for a stdio transport respawns the child process
  // the caller believed it had killed - and the close latch then swallows its death.
  it('refuses calls and notifications after close, and rebuilds no transport', async () => {
    const t = scriptedTransport()
    const c = createClient({
      transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint },
      transportFactories: { inproc: () => t.factory },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    await c.initialize()

    await c.close()

    await expect(c.session.new({ cwd: '/w' })).rejects.toMatchObject({ kind: 'transport-closed' })
    await expect(c.notify('session/cancel', { sessionId: 's1' })).rejects.toMatchObject({
      kind: 'transport-closed',
    })
    expect(t.methods()).toEqual(['initialize'])
    expect(t.built()).toBe(1)
  })

  // The memo is dropped when the transport goes away, so the next caller re-handshakes
  // instead of being handed the capabilities of a connection that no longer exists.
  it('runs a fresh handshake after the transport dropped on its own', async () => {
    const t = scriptedTransport()
    const c = createClient({
      transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint },
      transportFactories: { inproc: () => t.factory },
      journal: memoryJournal('cid'),
      authProviders: providers,
    })
    // An unexpected drop now also starts the reconnect loop (Task 15) in the background;
    // close() stops it so it does not go on retrying past the end of this test.
    try {
      await c.initialize()

      t.drop()
      await c.initialize()

      expect(t.methods().filter((m) => m === 'initialize')).toHaveLength(2)
      expect(t.built()).toBe(2)
    } finally {
      await c.close()
    }
  })

  // A signal handler that closes while another close is still tearing the transport down
  // must not be told the teardown is finished.
  it('makes a second close wait for the first instead of reporting done', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const f = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const endpoint: RpcEndpoint = { ...f.endpoint, close: () => gate }
    const c = createClient({
      transport: { kind: 'inproc', endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    await c.initialize()

    let firstDone = false
    let secondDone = false
    const first = c.close().then(() => {
      firstDone = true
    })
    const second = c.close().then(() => {
      secondDone = true
    })
    await flush()
    expect([firstDone, secondDone]).toEqual([false, false])

    release()
    await Promise.all([first, second])

    expect([firstDone, secondDone]).toEqual([true, true])
  })

  // The connection's own default is covered next door; this is the one that says the
  // client hands it over. Without it every call is deadline-free and a lost answer hangs
  // the process instead of failing it.
  it('applies the default request deadline to an ordinary call', async () => {
    vi.useFakeTimers()
    const f = fakeEndpoint({
      initialize: fakeEndpoint({}).initialize,
      '_agnes/v1/apis.list': () => new Promise(() => {}),
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })

    const pending = c.apis()
    const assertion = expect(pending).rejects.toMatchObject({
      kind: 'request-timeout',
      method: '_agnes/v1/apis.list',
      timeoutMs: 30_000,
    })
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('stops calling a handler once its disposer runs', async () => {
    const f = fakeEndpoint({ initialize: fakeEndpoint({}).initialize })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal(),
      authProviders: providers,
    })
    const seen: unknown[] = []
    const off = c.on('closed', (p) => seen.push(p))
    off()
    await c.close()
    expect(seen).toEqual([])
  })

  // Typed rather than a bare Error: a caller switching on `kind` has one branch for every
  // way a client can refuse to be built.
  it('rejects an auth kind the entry did not register', () => {
    expect(() =>
      createClient({
        transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint },
        auth: { kind: 'source-auth', secret: 'synthetic' },
        journal: memoryJournal(),
        authProviders: providers,
      }),
    ).toThrow(expect.objectContaining({ kind: 'unsupported', what: 'auth kind source-auth' }))
  })

  it('rejects a transport kind the entry did not register', () => {
    expect(() =>
      createClient({
        transport: { kind: 'ws', url: 'wss://example.invalid' },
        journal: memoryJournal(),
        authProviders: providers,
      }),
    ).toThrow(expect.objectContaining({ kind: 'unsupported', what: 'transport ws' }))
  })

  it('lets an injected auth provider see the clientId and shape the credential', async () => {
    let seenClientId: string | null = null
    let seenParams: Record<string, unknown> | null = null
    let initParams: unknown
    const f = fakeEndpoint({
      initialize: (p, ctx) => {
        initParams = p
        return fakeEndpoint({}).initialize(p, ctx)
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      auth: { kind: 'jwt', token: 'tok-1' },
      journal: memoryJournal('cid-9'),
      authProviders: {
        ...providers,
        jwt: (opt) => ({
          kind: 'jwt',
          async build(ctx) {
            seenClientId = ctx.clientId
            seenParams = ctx.initializeParams
            return { kind: 'jwt', token: (opt as { token: string }).token }
          },
        }),
      },
    })

    await c.initialize()

    expect(seenClientId).toBe('cid-9')
    const wire = structuredClone(initParams) as { _meta: Record<string, Record<string, unknown>> }
    const wireMeta = wire._meta[META_KEY]
    if (!wireMeta) throw new Error('missing wire metadata')
    delete wireMeta.auth
    expect(seenParams).toEqual(wire)
    expect(initParams).toMatchObject({
      _meta: { [META_KEY]: { auth: { kind: 'jwt', token: 'tok-1' }, clientId: 'cid-9' } },
    })
  })

  it('omits auth entirely when the provider declines to build one', async () => {
    let initParams: unknown
    const f = fakeEndpoint({
      initialize: (p, ctx) => {
        initParams = p
        return fakeEndpoint({}).initialize(p, ctx)
      },
    })
    const c = createClient({
      transport: { kind: 'inproc', endpoint: f.endpoint },
      journal: memoryJournal('cid-0'),
      authProviders: { local: () => ({ kind: 'local', build: async () => undefined }) },
    })

    await c.initialize()

    expect((initParams as { _meta: Record<string, unknown> })._meta).toEqual({
      [META_KEY]: { clientId: 'cid-0' },
    })
  })
})

describe('memoryJournal', () => {
  it('hands out monotonic per-session command ids under a stable clientId', async () => {
    const j = memoryJournal('cid')
    const ids = await Promise.all([j.nextCommandId('a'), j.nextCommandId('a'), j.nextCommandId('b')])
    expect(ids).toEqual(['cid:a:1', 'cid:a:2', 'cid:b:1'])
    expect(await j.clientId()).toBe('cid')
  })

  it('generates a distinct clientId per store when none is given', async () => {
    const a = await memoryJournal().clientId()
    const b = await memoryJournal().clientId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })

  it('keeps cursors and pending commands separate per session', async () => {
    const j = memoryJournal('cid')
    expect(await j.cursor('a')).toBeNull()
    await j.setCursor('a', { fromSeq: 7, generation: 2 })
    expect(await j.cursor('a')).toEqual({ fromSeq: 7, generation: 2 })
    expect(await j.cursor('b')).toBeNull()

    await j.markPending('a', { commandId: 'c1', method: 'm', params: {} })
    await j.markPending('a', { commandId: 'c2', method: 'm', params: {} })
    await j.markPending('b', { commandId: 'c1', method: 'm', params: {} })
    await j.clearPending('a', 'c1')
    expect((await j.pending('a')).map((c) => c.commandId)).toEqual(['c2'])
    expect((await j.pending('b')).map((c) => c.commandId)).toEqual(['c1'])
  })

  it('returns a copy of pending so callers cannot mutate the store', async () => {
    const j = memoryJournal('cid')
    await j.markPending('a', { commandId: 'c1', method: 'm', params: {} })
    const got = await j.pending('a')
    got.length = 0
    expect(await j.pending('a')).toHaveLength(1)
  })
})

describe('Emitter', () => {
  it('delivers only to handlers of the event that was emitted', () => {
    const e = new Emitter<'a' | 'b'>()
    const a: unknown[] = []
    const b: unknown[] = []
    e.on('a', (p) => a.push(p))
    e.on('b', (p) => b.push(p))
    e.emit('a', 1)
    expect(a).toEqual([1])
    expect(b).toEqual([])
  })

  it('does not deliver the in-flight event to a handler subscribed during that emit', () => {
    const e = new Emitter<'a'>()
    const late: unknown[] = []
    e.on('a', () => {
      e.on('a', (p) => late.push(p))
    })
    e.emit('a', 1)
    expect(late).toEqual([])
    e.emit('a', 2)
    expect(late).toEqual([2])
  })

  it('gives each subscription its own disposer', () => {
    const e = new Emitter<'a'>()
    const first: unknown[] = []
    const second: unknown[] = []
    const off = e.on('a', (p) => first.push(p))
    e.on('a', (p) => second.push(p))
    off()
    e.emit('a', 1)
    expect(first).toEqual([])
    expect(second).toEqual([1])
  })
})

it('gives auth.build an isolated snapshot of the completed handshake fields', async () => {
  let wire: unknown
  const f = fakeEndpoint({
    initialize: (p, ctx) => {
      wire = p
      return fakeEndpoint({}).initialize(p, ctx)
    },
  })
  const client = createClient({
    transport: { kind: 'inproc', endpoint: f.endpoint },
    journal: memoryJournal('snapshot-client'),
    authProviders: {
      local: () => ({
        kind: 'local',
        async build({ initializeParams }) {
          initializeParams.protocolVersion = 999
          initializeParams.clientCapabilities = { fs: { readTextFile: true, writeTextFile: true } }
          initializeParams._meta = { [META_KEY]: { clientId: 'forged' } }
          return { kind: 'local' }
        },
      }),
    },
  })
  try {
    await client.initialize()
    expect(wire).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      _meta: { [META_KEY]: { clientId: 'snapshot-client', auth: { kind: 'local' } } },
    })
  } finally {
    await client.close()
  }
})
