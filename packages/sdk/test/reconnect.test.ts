// Task 15: the reconnect loop (Reconnector, in reattach.ts) and the Session/Client seams
// it drives - resend-before-attach ordering, -32004/-32005 recovery, backoff (including the
// OVERLOADED override), an in-flight prompt() settling off a post-reconnect notification, and
// the shutting_down latch that turns the next drop into a real close instead of a retry.
import { META_KEY, rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { localAuth } from '../src/auth.js'
import { type CreateClientOptions, createClient } from '../src/client.js'
import { memoryJournal } from '../src/journal.js'
import { fakeEndpoint, flush } from './helpers/fake-endpoint.js'
import { flakyEndpoint } from './helpers/flaky-endpoint.js'

const providers = { local: () => localAuth() }
const actor = { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} }

// A real ledger row, for the one test that exercises events() itself.
const ev = (seq: number, gen = 1) => ({
  jsonrpc: '2.0' as const,
  method: '_agnes/v1/session.event',
  params: {
    sessionId: 's',
    event: {
      seq,
      ts: '2026-01-01T00:00:00.000Z',
      id: '01J6ZM2Q3R4S5T6V7W8X9Y0ZAB',
      type: 'assistant/message' as const,
      data: { content: [], stopReason: 'end_turn' as const },
      actor,
      origin: 'model' as const,
      trust: 'trusted' as const,
    },
    _meta: {
      [META_KEY]: {
        promptTurnId: '1',
        eventSequence: seq,
        generation: gen,
        lane: 'main',
        phase: 'event' as const,
      },
    },
  },
})

// A side-channel notification carrying only harness meta - for tests that care what
// Session does with `_meta` and nothing else (mirrors session.test.ts's own meta/update
// helpers, which use the same ACP `session/update` shape for exactly this reason).
const notice = (extra: Record<string, unknown>) => ({
  jsonrpc: '2.0' as const,
  method: 'session/update',
  params: {
    sessionId: 's',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    _meta: {
      [META_KEY]: {
        promptTurnId: '1',
        eventSequence: 1,
        generation: 1,
        lane: 'main',
        phase: 'event',
        ...extra,
      },
    },
  },
})

// Backoff shrunk to near-zero: these five tests only care about ordering and outcome, not
// about how many milliseconds retrying actually takes.
const fast = { baseMs: 1, maxMs: 5, jitter: 0 }
const stockInit = fakeEndpoint({}).initialize
const stockInitResult = {
  protocolVersion: 1,
  agentCapabilities: {},
  _meta: { agnes: { agnesVersion: '0.0.0-test' } },
}

const clients: ReturnType<typeof createClient>[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close()
})

function client(f: ReturnType<typeof flakyEndpoint>, opts: Partial<CreateClientOptions> = {}) {
  const c = createClient({
    transport: { kind: 'inproc', endpoint: fakeEndpoint({}).endpoint },
    transportFactories: { inproc: () => f.factory },
    journal: memoryJournal('cid'),
    authProviders: providers,
    reconnect: fast,
    ...opts,
  })
  clients.push(c)
  return c
}

describe('reconnect', () => {
  it('resends pending before re-attaching, from lastApplied verbatim, and emits reconnected', async () => {
    const attaches: unknown[] = []
    let submitCalls = 0
    const f = flakyEndpoint({
      initialize: stockInit,
      '_agnes/v1/session.attach': (p) => {
        attaches.push(p)
        return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
      },
      '_agnes/v1/submit': () => {
        submitCalls++
        // The first call is the one that was in flight when the transport dropped: it
        // never gets an answer over the dead connection, only over the resend.
        return submitCalls === 1 ? new Promise(() => {}) : { seq: 50, replayed: true }
      },
    })
    const journal = memoryJournal('cid')
    const c = client(f, { journal })
    expect(c.connectionState).toBe('idle')
    const s = await c.session.attach('s')
    expect(c.connectionState).toBe('connected')
    const it = s.events()[Symbol.asyncIterator]()
    const p1 = it.next()
    f.notify(ev(1))
    await p1
    const p2 = it.next()
    f.notify(ev(2))
    await p2
    // lastApplied is now 2 (both rows taken by the iterator above).
    s.steer('go').catch(() => undefined)
    await flush()
    expect(await journal.pending('s')).toHaveLength(1)

    const connectionStates: string[] = []
    c.on('connectionStateChanged', (state) => connectionStates.push(String(state)))
    c.on('reconnecting', () => connectionStates.push('reconnecting'))
    const reconnected = new Promise((r) =>
      c.on('reconnected', (value) => {
        connectionStates.push('reconnected')
        r(value)
      }),
    )
    f.drop()
    expect(c.connectionState).toBe('reconnecting')
    expect(connectionStates).toEqual(['reconnecting', 'reconnecting'])
    await reconnected
    expect(c.connectionState).toBe('connected')
    expect(connectionStates).toEqual(['reconnecting', 'reconnecting', 'connected', 'reconnected'])

    const order = f.calls.map((x) => x.method)
    const iSubmit = order.lastIndexOf('_agnes/v1/submit')
    const iAttach = order.lastIndexOf('_agnes/v1/session.attach')
    expect(iSubmit).toBeGreaterThan(-1)
    expect(iSubmit).toBeLessThan(iAttach)
    expect(attaches.at(-1)).toMatchObject({ cursor: { fromSeq: 2, generation: 1 } })
    expect(await journal.pending('s')).toEqual([])

    // Resumed exactly where it left off: row 2 is not replayed, row 3 is not lost.
    const p3 = it.next()
    f.notify(ev(2))
    f.notify(ev(3))
    expect((await p3).value.seq).toBe(3)
    await it.return?.()
  })

  it('re-attaches under the new generation on GENERATION_STALE, fromSeq unchanged', async () => {
    const attaches: Array<{ cursor?: { fromSeq: number; generation: number } }> = []
    let serverGen = 1
    const f = flakyEndpoint({
      initialize: stockInit,
      '_agnes/v1/session.attach': (p) => {
        const q = p as { cursor?: { fromSeq: number; generation: number } }
        attaches.push(q)
        if (q.cursor && q.cursor.generation !== serverGen)
          throw Object.assign(new Error('GENERATION_STALE'), {
            code: -32004,
            data: { code: 'GENERATION_STALE', generation: serverGen },
          })
        return { generation: serverGen, lastSeq: 0, resolvedProfileHash: null }
      },
    })
    const c = client(f)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()
    const p = it.next()
    f.notify(ev(1))
    await p
    // lastApplied is now 1.

    const changed = new Promise((r) => c.on('generationChanged', r))
    // `generationChanged` fires synchronously as soon as the stale response is caught,
    // before the retry attach it precedes has round-tripped - wait for the whole
    // reconnect to settle before reading `attaches`, or the retry has not landed yet.
    const reconnected = new Promise((r) => c.on('reconnected', r))
    serverGen = 2
    f.drop()
    await reconnected
    expect(await changed).toEqual({ sessionId: 's', generation: 2 })
    expect(attaches.at(-1)).toMatchObject({ cursor: { fromSeq: 1, generation: 2 } })
    await it.return?.()
  })

  it('re-attaches from earliestSeq - 1 and emits gap on CURSOR_OUT_OF_RANGE', async () => {
    const attaches: unknown[] = []
    let failNext = false
    const f = flakyEndpoint({
      initialize: stockInit,
      '_agnes/v1/session.attach': (p) => {
        attaches.push(p)
        const q = p as { cursor?: { fromSeq: number } }
        if (failNext && q.cursor?.fromSeq === 1) {
          failNext = false
          throw Object.assign(new Error('CURSOR_OUT_OF_RANGE'), {
            code: -32005,
            data: { code: 'CURSOR_OUT_OF_RANGE', earliestSeq: 40 },
          })
        }
        return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
      },
    })
    const c = client(f)
    const s = await c.session.attach('s')
    const it = s.events()[Symbol.asyncIterator]()
    const p = it.next()
    f.notify(ev(1))
    await p
    // lastApplied is now 1, so the recovery attach sends fromSeq: 1 and hits the trap.
    failNext = true

    const gap = new Promise((r) => c.on('gap', r))
    // Same reasoning as the GENERATION_STALE case: `gap` fires before the retry attach
    // it precedes has round-tripped.
    const reconnected = new Promise((r) => c.on('reconnected', r))
    f.drop()
    await reconnected
    expect(await gap).toEqual({ sessionId: 's', earliestSeq: 40 })
    // Exclusive convention: fromSeq 39 is what resumes exactly at row 40.
    expect(attaches.at(-1)).toMatchObject({ cursor: { fromSeq: 39, generation: 1 } })
    await it.return?.()
  })

  it('settles an in-flight prompt via terminalQuiescence after reconnect, matched by promptTurnId', async () => {
    const f = flakyEndpoint({
      initialize: stockInit,
      '_agnes/v1/session.attach': () => ({ generation: 1, lastSeq: 0, resolvedProfileHash: null }),
      'session/prompt': () => new Promise(() => {}),
    })
    const c = client(f)
    const s = await c.session.attach('s')
    const result = s.prompt('hi')
    await flush()
    // Pins which turn this prompt() belongs to before the drop, the way a real response
    // boundary would have arrived while the request was still in flight.
    f.notify(notice({ phase: 'event', promptTurnId: '1' }))
    await flush()

    const reconnected = new Promise((r) => c.on('reconnected', r))
    f.drop()
    await reconnected

    // A terminalQuiescence for a *different* turn must not settle this one - if it did,
    // the assertion below would see lastSeq: 8, not 9.
    f.notify(
      notice({
        phase: 'terminalQuiescence',
        promptTurnId: 'other',
        turnEnd: { reason: 'completed' },
        eventSequence: 8,
      }),
    )
    await flush()
    f.notify(
      notice({
        phase: 'terminalQuiescence',
        promptTurnId: '1',
        turnEnd: { reason: 'completed' },
        eventSequence: 9,
      }),
    )

    expect(await result).toEqual({ stopReason: 'end_turn', reason: 'completed', lastSeq: 9 })
  })

  describe('a session the daemon refuses for good', () => {
    const idOf = (p: unknown) => (p as { sessionId: string }).sessionId
    /** Resolves with the next `reconnected`, or rejects if none arrives in time. */
    const nextReconnected = (c: ReturnType<typeof client>) =>
      Promise.race([
        new Promise((resolve) => c.on('reconnected', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no reconnected')), 2_000)),
      ])

    it.each(['E_LEDGER_INTEGRITY', 'LEGACY_LEDGER_FORMAT', 'NEWER_LEDGER_FORMAT'])(
      'is loaded once on reconnect when it answers %s, and the others still reconnect',
      async (code) => {
        let dropped = false
        const loads: string[] = []
        const attaches: string[] = []
        const f = flakyEndpoint({
          initialize: stockInit,
          'session/load': (p) => {
            if (dropped) loads.push(idOf(p))
            // Reclaimed while the client was gone; reopening it verifies its history, which fails.
            if (dropped && idOf(p) === 'bad') throw rpcError('SEMANTIC_REJECTED', { code })
            return {}
          },
          '_agnes/v1/session.attach': (p) => {
            if (dropped) attaches.push(idOf(p))
            if (dropped && idOf(p) === 'bad') throw rpcError('SESSION_NOT_FOUND', { sessionId: idOf(p) })
            return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
          },
        })
        const c = client(f)
        const notices: unknown[] = []
        c.on('notice', (n) => notices.push(n))
        // The refused session comes first: before the fix its failure skipped every session after it.
        const bad = await c.session.load('bad', { cwd: '/w' })
        await bad.attach()
        const good = await c.session.load('good', { cwd: '/w' })
        await good.attach()
        const reading = bad.events()[Symbol.asyncIterator]().next()

        const reconnected = nextReconnected(c)
        dropped = true
        f.drop()
        await reconnected
        expect(loads).toEqual(['bad'])
        expect(attaches).toEqual(['bad', 'good'])
        expect(bad.attached).toBe(false)
        expect(bad.refused).toBe(code)
        expect(good.attached).toBe(true)
        expect(notices).toContainEqual({ kind: 'session-refused', sessionId: 'bad', code })
        // A reader of the refused session is not left waiting on a stream that will not come back.
        expect(await reading).toEqual({ done: true, value: undefined })

        // Nor is it tried again on the next drop.
        const again = nextReconnected(c)
        f.drop()
        await again
        expect(loads).toEqual(['bad'])
        expect(attaches).toEqual(['bad', 'good', 'good'])
      },
    )

    it('is attached once on reconnect when the attach itself is refused, and the others still reconnect', async () => {
      // A daemon that still holds the session answers the attach with the refusal; nothing reopens.
      let dropped = false
      const attaches: string[] = []
      const f = flakyEndpoint({
        initialize: stockInit,
        '_agnes/v1/session.attach': (p) => {
          if (dropped) attaches.push(idOf(p))
          if (dropped && idOf(p) === 'bad')
            throw rpcError('SEMANTIC_REJECTED', { code: 'E_LEDGER_INTEGRITY', reason: 'ledger-integrity' })
          return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
        },
      })
      const c = client(f)
      const bad = await c.session.attach('bad')
      const good = await c.session.attach('good')
      const reconnected = nextReconnected(c)
      dropped = true
      f.drop()
      await reconnected
      expect(attaches).toEqual(['bad', 'good'])
      expect(bad.refused).toBe('E_LEDGER_INTEGRITY')
      expect(good.attached).toBe(true)
      expect(f.calls.filter((call) => call.method === 'session/load')).toEqual([])
    })

    it('stops following a session the daemon reports failed its integrity check', async () => {
      const attaches: string[] = []
      const f = flakyEndpoint({
        initialize: stockInit,
        '_agnes/v1/session.attach': (p) => {
          attaches.push(idOf(p))
          return { generation: 1, lastSeq: 0, resolvedProfileHash: null }
        },
      })
      const c = client(f)
      const notices: unknown[] = []
      c.on('notice', (n) => notices.push(n))
      const s = await c.session.attach('s')
      const reading = s.events()[Symbol.asyncIterator]().next()
      const failed = {
        kind: 'integrity_failed',
        sessionId: 's',
        detail: { code: 'E_LEDGER_INTEGRITY' },
        at: 't',
      }
      f.notify({ jsonrpc: '2.0', method: '_agnes/v1/daemon.notice', params: failed })
      await flush()
      expect(s.attached).toBe(false)
      expect(s.refused).toBe('E_LEDGER_INTEGRITY')
      expect(await reading).toEqual({ done: true, value: undefined })
      // The daemon's notice is the one listeners hear; the session does not announce it again.
      expect(notices).toEqual([failed])
      const reconnected = nextReconnected(c)
      f.drop()
      await reconnected
      expect(attaches).toEqual(['s'])
    })
  })

  it('does not reconnect after a shutting_down notice, and reports closed once', async () => {
    const f = flakyEndpoint({ initialize: stockInit })
    const c = client(f)
    await c.initialize()
    f.notify({
      jsonrpc: '2.0',
      method: '_agnes/v1/daemon.notice',
      params: { kind: 'shutting_down', detail: {}, at: 't' },
    })
    await flush()
    const closed = new Promise((r) => c.on('closed', r))
    f.drop()
    await closed
    expect(c.connectionState).toBe('closed')
    await new Promise((r) => setTimeout(r, 20))
    expect(f.connects).toBe(1)
  })

  // The internal loop staying quiet (above) is only half the guarantee. A shutting_down
  // notice never sets `closing` (only an explicit close() does), so before this fix
  // initialize()/call()/notify() kept guarding on `closing` alone and happily re-ran the
  // handshake for any caller unaware the client had already gone terminal - opening a real
  // second connection behind a `closed` event that told every listener there would not be
  // one. This is the shape the bug report reproduced: daemon shutdown notice -> `closed`
  // fires -> some caller re-initializes -> connection count goes from 1 to 2.
  it('refuses a caller-initiated initialize()/call() after a shutting_down close, same as after close()', async () => {
    const f = flakyEndpoint({ initialize: stockInit })
    const c = client(f)
    await c.initialize()
    f.notify({
      jsonrpc: '2.0',
      method: '_agnes/v1/daemon.notice',
      params: { kind: 'shutting_down', detail: {}, at: 't' },
    })
    await flush()
    const closed = new Promise((r) => c.on('closed', r))
    f.drop()
    await closed

    await expect(c.initialize()).rejects.toMatchObject({ kind: 'transport-closed' })
    await expect(c.apis()).rejects.toMatchObject({ kind: 'transport-closed' })
    await expect(c.notify('session/cancel', { sessionId: 's1' })).rejects.toMatchObject({
      kind: 'transport-closed',
    })
    expect(f.connects).toBe(1)
    expect(c.isClosed).toBe(true)
  })

  it('retries with doubling backoff, capped, until the handshake succeeds', async () => {
    let armed = false
    let failuresLeft = 3
    const sleeps: number[] = []
    const f = flakyEndpoint({
      initialize: () => {
        if (armed && failuresLeft > 0) {
          failuresLeft--
          throw Object.assign(new Error('boom'), { code: -32603, data: { code: 'INTERNAL_ERROR' } })
        }
        return stockInitResult
      },
    })
    const c = client(f, {
      reconnect: { baseMs: 100, maxMs: 5000, jitter: 0, sleep: async (ms) => void sleeps.push(ms) },
    })
    await c.initialize()
    armed = true
    const reconnected = new Promise((r) => c.on('reconnected', r))
    f.drop()
    expect(await reconnected).toEqual({ attempts: 4 })
    expect(sleeps).toEqual([100, 200, 400, 800])
  })

  it('uses the server-supplied retryAfterMs verbatim on OVERLOADED, instead of doubling', async () => {
    let armed = false
    let overloadedOnce = true
    const sleeps: number[] = []
    const f = flakyEndpoint({
      initialize: () => {
        if (armed && overloadedOnce) {
          overloadedOnce = false
          throw Object.assign(new Error('OVERLOADED'), {
            code: -32001,
            data: { code: 'OVERLOADED', retryAfterMs: 250 },
          })
        }
        return stockInitResult
      },
    })
    const c = client(f, {
      reconnect: { baseMs: 100, maxMs: 5000, jitter: 0, sleep: async (ms) => void sleeps.push(ms) },
    })
    await c.initialize()
    armed = true
    const reconnected = new Promise((r) => c.on('reconnected', r))
    f.drop()
    await reconnected
    // Plain doubling would have slept 200ms second; the server's own number wins instead.
    expect(sleeps).toEqual([100, 250])
  })
})
