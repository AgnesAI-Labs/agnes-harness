import { createExtensionActivationBarrier, StoredOpeningError } from '@agnes/host'
import { type EventEnvelope, rpcError } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachedFeed } from '../src/local/attached.js'
import { CommandQueue } from '../src/local/command-queue.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { type Feed, type LocalContext, registerAcp } from '../src/local/methods/acp.js'
import { registerStoredOpening } from '../src/local/methods/stored-opening.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'

const KEY = 'agnes:local:default:daemon:dm:session-loading'
type Progress = { phase: string; done: number; total: number }

afterEach(() => {
  vi.useRealTimers()
})

const row = (seq: number): EventEnvelope =>
  ({
    seq,
    ts: '2026-10-13T00:00:00.000Z',
    id: `e${seq}`,
    type: 'user/message',
    lane: 'main',
    v: 1,
    actor: { id: 'u', org: 'local', role: 'owner', deptPath: [], attrs: {} },
    origin: 'principal',
    trust: 'trusted',
    data: { content: [{ type: 'text', text: `row ${seq}` }] },
  }) as unknown as EventEnvelope

/**
 * A registry whose open takes `openMs` and reports fold progress every 100 ms while it runs, the way
 * the supervisor relays a worker's progress frames. Without `progress` it has no progress channel,
 * like the in-process registry.
 */
function slowRegistry(o: {
  openMs: number
  lastSeq: number
  progress?: boolean
  fail?: Error
  /** Fail only the first open; later ones succeed. */
  failOnce?: boolean
  /** How long each replay page takes to read. */
  scanMs?: number
}) {
  const listeners = new Map<string, Set<(p: Progress) => void>>()
  const entry = {
    key: KEY,
    generation: 1,
    inflight: null,
    listeners: new Set(),
    session: {
      lastSeq: o.lastSeq,
      latest: () => null,
      scan: async (q: { fromSeq: number; toSeq: number; limit: number }) => {
        if (o.scanMs) await new Promise((resolve) => setTimeout(resolve, o.scanMs))
        const rows: EventEnvelope[] = []
        for (let seq = q.fromSeq; seq <= Math.min(q.toSeq, o.lastSeq); seq++) rows.push(row(seq))
        return rows.slice(0, q.limit)
      },
    },
  }
  let opened = false
  let opens = 0
  const registry = {
    get: () => (opened ? entry : undefined),
    open: async () => {
      const started = Date.now()
      const tick = setInterval(() => {
        const elapsed = Date.now() - started
        for (const fn of listeners.get(KEY) ?? []) fn({ phase: 'fold', done: elapsed, total: 100_000 })
      }, 100)
      try {
        await new Promise((resolve) => setTimeout(resolve, o.openMs))
      } finally {
        clearInterval(tick)
      }
      opens++
      if (o.fail && (!o.failOnce || opens === 1)) throw o.fail
      opened = true
      return entry
    },
    subscribe: () => () => undefined,
    subscribePreview: () => () => undefined,
    previewSnapshot: async () => [],
    ...(o.progress === false
      ? {}
      : {
          onOpenProgress(key: string, fn: (p: Progress) => void) {
            const set = listeners.get(key) ?? new Set()
            set.add(fn)
            listeners.set(key, set)
            return () => {
              set.delete(fn)
            }
          },
        }),
    listenerCount: () => listeners.get(KEY)?.size ?? 0,
  }
  return registry
}

function connect(registry: ReturnType<typeof slowRegistry>) {
  const ep = new LocalEndpoint({ clock: () => Date.now(), principalId: 'local' })
  ep.conn.initialized = true
  const pushed: Array<{ at: number; params: Progress & { sessionId: string } }> = []
  const push = ep.push.bind(ep)
  vi.spyOn(ep, 'push').mockImplementation((message) => {
    const m = message as { method?: string; params?: unknown }
    if (m.method === '_agnes/v1/session.loading')
      pushed.push({ at: Date.now(), params: m.params as Progress & { sessionId: string } })
    return push(message)
  })
  const cx = {
    registry,
    clock: () => Date.now(),
    quiescenceWaitMs: 2_000,
    commandQueue: new CommandQueue(),
    activationBarrier: createExtensionActivationBarrier(),
    workspaces: { restoreBinding: async () => ({ canonicalRoot: '/workspace' }) },
    sessionOwnership: { resolve: () => ({ principalId: 'local' }) },
  } as unknown as LocalContext
  registerAcp(ep, cx, new Map<string, Feed>(), new Map<string, AttachedFeed>())
  const load = () =>
    ep.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/load',
      params: { sessionId: KEY, cwd: '/workspace', mcpServers: [] },
    })
  return { pushed, load }
}

describe('session/load progress notifications', () => {
  it('sends at most one notice a second while the open runs, then replay progress', async () => {
    vi.useFakeTimers()
    const registry = slowRegistry({ openMs: 3_500, lastSeq: 1_200 })
    const c = connect(registry)
    const started = Date.now()
    const answer = c.load()
    await vi.advanceTimersByTimeAsync(3_600)
    expect(await answer).not.toHaveProperty('error')

    const during = c.pushed.filter((n) => n.at - started <= 3_500 && n.params.phase !== 'replay')
    expect(during.length).toBeGreaterThanOrEqual(3)
    expect(during.length).toBeLessThanOrEqual(4)
    expect(during.every((n) => n.params.phase === 'fold' && n.params.sessionId === KEY)).toBe(true)
    for (let i = 1; i < during.length; i++)
      expect((during[i]?.at as number) - (during[i - 1]?.at as number)).toBeGreaterThanOrEqual(1_000)
    const replay = c.pushed.filter((n) => n.params.phase === 'replay')
    expect(replay.at(-1)?.params).toMatchObject({ phase: 'replay', done: 1_200, total: 1_200 })
    expect(registry.listenerCount()).toBe(0)
  })

  it('sends a heartbeat at least every 5 s when the registry reports no progress', async () => {
    vi.useFakeTimers()
    const registry = slowRegistry({ openMs: 12_000, lastSeq: 0, progress: false })
    const c = connect(registry)
    const started = Date.now()
    const answer = c.load()
    await vi.advanceTimersByTimeAsync(12_100)
    expect(await answer).not.toHaveProperty('error')
    const beats = c.pushed.filter((n) => n.params.phase === 'open')
    expect(beats.length).toBeGreaterThanOrEqual(2)
    let last = started
    for (const beat of beats) {
      expect(beat.at - last).toBeLessThanOrEqual(5_000)
      expect(beat.params).toEqual({ sessionId: KEY, phase: 'open', done: 0, total: 0 })
      last = beat.at
    }
    // Nothing more once the open is over.
    const count = c.pushed.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(c.pushed.length).toBe(count)
  })

  it('stops the heartbeat and the progress subscription when the open fails', async () => {
    vi.useFakeTimers()
    const registry = slowRegistry({ openMs: 2_000, lastSeq: 0, fail: new Error('open failed') })
    const c = connect(registry)
    const answer = c.load()
    await vi.advanceTimersByTimeAsync(2_100)
    expect(await answer).toHaveProperty('error')
    expect(registry.listenerCount()).toBe(0)
    const count = c.pushed.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(c.pushed.length).toBe(count)
  })
})

describe('session/load progress around failures and slow replay', () => {
  it('forgets a failed load, so the next load of the session is not throttled by it', async () => {
    vi.useFakeTimers()
    const registry = slowRegistry({
      openMs: 2_500,
      lastSeq: 0,
      progress: false,
      fail: new Error('open failed'),
      failOnce: true,
    })
    const c = connect(registry)
    const first = c.load()
    await vi.advanceTimersByTimeAsync(2_600)
    expect(await first).toHaveProperty('error')
    expect(c.pushed.length).toBeGreaterThanOrEqual(1)
    const retryAt = Date.now()
    const second = c.load()
    await vi.advanceTimersByTimeAsync(2_600)
    expect(await second).not.toHaveProperty('error')
    // The retry's first heartbeat goes on the first tick, not 4 s after the failed load's last notice.
    const retried = c.pushed.filter((n) => n.at > retryAt)
    expect(retried[0]?.at).toBeLessThanOrEqual(retryAt + 1_000)
  })

  it('keeps sending heartbeats while a slow replay page is read', async () => {
    vi.useFakeTimers()
    const registry = slowRegistry({ openMs: 0, lastSeq: 1_200, progress: false, scanMs: 12_000 })
    const c = connect(registry)
    const started = Date.now()
    const answer = c.load()
    await vi.advanceTimersByTimeAsync(37_000)
    expect(await answer).not.toHaveProperty('error')
    let last = started
    for (const n of c.pushed) {
      expect(n.at - last).toBeLessThanOrEqual(5_000)
      last = n.at
    }
    expect(c.pushed.filter((n) => n.params.phase === 'open').length).toBeGreaterThanOrEqual(6)
    expect(c.pushed.at(-1)?.params).toMatchObject({ phase: 'replay', done: 1_200, total: 1_200 })
    const count = c.pushed.length
    await vi.advanceTimersByTimeAsync(20_000)
    expect(c.pushed.length).toBe(count)
  })
})

describe('worker registry open progress', () => {
  it('relays progress to the listeners of that session only, until they leave', () => {
    const registry = new WorkerRegistry({} as WorkerPool)
    const a: Progress[] = []
    const b: Progress[] = []
    const offA = registry.onOpenProgress('a', (p) => a.push(p))
    registry.onOpenProgress('b', (p) => b.push(p))
    registry.onOpenProgress('a', () => {
      throw new Error('listener broke')
    })
    registry.openProgress('a', { phase: 'fold', done: 1, total: 2 })
    offA()
    registry.openProgress('a', { phase: 'fold', done: 2, total: 2 })
    expect(a).toEqual([{ phase: 'fold', done: 1, total: 2 }])
    expect(b).toEqual([])
  })
})

describe('session.storedOpening', () => {
  const timeline = { sessionId: KEY, upto: 9, opState: null, nodes: [], turns: [] }
  function endpoint(o: {
    owner?: string
    storedOpening?: Parameters<typeof registerStoredOpening>[1]['storedOpening']
  }) {
    const ep = new LocalEndpoint({ clock: () => Date.now(), principalId: 'local' })
    ep.conn.initialized = true
    registerStoredOpening(ep, {
      requireSessionOwner: (method, sessionId, c) => {
        if ((o.owner ?? 'local') !== c.conn.principalId)
          throw rpcError('CAPABILITY_DENIED', { method, sessionId, reason: 'session owner unavailable' })
      },
      ...(o.storedOpening ? { storedOpening: o.storedOpening } : {}),
    })
    return (params: Record<string, unknown>) =>
      ep.handle({ jsonrpc: '2.0', id: 1, method: '_agnes/v1/session.storedOpening', params }) as Promise<{
        result?: unknown
        error?: { data?: Record<string, unknown> }
      }>
  }

  it('answers with the stored opening, marked unverified', async () => {
    const opening = vi.fn(async () => ({ timeline, hasEarlier: true, lastSeq: 9 }))
    const call = endpoint({ storedOpening: { opening } })
    expect(await call({ sessionId: KEY })).toMatchObject({
      result: { timeline: { ...timeline, generation: 1 }, hasEarlier: true, verified: false, lastSeq: 9 },
    })
    await call({ sessionId: KEY, maxNodes: 20 })
    expect(opening.mock.calls).toEqual([
      [KEY, 200],
      [KEY, 20],
    ])
  })

  it('refuses another principal before reading anything', async () => {
    const opening = vi.fn()
    const call = endpoint({ owner: 'someone-else', storedOpening: { opening } })
    expect((await call({ sessionId: KEY })).error?.data).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(opening).not.toHaveBeenCalled()
  })

  it('refuses when there is no reader, or the storage does not hold the session', async () => {
    expect((await endpoint({})({ sessionId: KEY })).error?.data).toMatchObject({
      reason: 'stored-opening-unavailable',
    })
    const empty = endpoint({
      storedOpening: {
        opening: async () => ({ timeline: { ...timeline, upto: 0 }, hasEarlier: false, lastSeq: 0 }),
      },
    })
    expect((await empty({ sessionId: KEY })).error?.data).toMatchObject({
      reason: 'stored-opening-unavailable',
    })
    const looped = endpoint({
      storedOpening: {
        opening: async () => {
          throw new StoredOpeningError('stored session ancestry loops or is too deep')
        },
      },
    })
    expect((await looped({ sessionId: KEY })).error?.data).toMatchObject({
      code: 'SEMANTIC_REJECTED',
      reason: 'stored-opening-unavailable',
    })
  })
})
