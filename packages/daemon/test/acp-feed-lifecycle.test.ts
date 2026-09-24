import { createExtensionActivationBarrier } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { AttachedFeed } from '../src/local/attached.js'
import { CommandQueue } from '../src/local/command-queue.js'
import { LocalEndpoint } from '../src/local/endpoint.js'
import { disposeFeeds, type Feed, type LocalContext, registerAcp } from '../src/local/methods/acp.js'
import type { SessionEntry } from '../src/local/sessions.js'
import { WorkerRegistry } from '../src/supervisor/registry.js'
import { SupervisorRegistry } from '../src/supervisor/supervisor.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

const KEY = 'agnes:local:default:daemon:dm:feed-lifecycle'

type Hold = { gate: Promise<void>; lastSeq: number }

/** One worker generation for KEY: answers the few commands ACP sends and can be made to crash. */
function workerLink(hold: Hold) {
  const exits: Array<() => void> = []
  const link = {
    alive: true,
    hello: Promise.resolve({
      kind: 'hello' as const,
      token: 'token',
      sessionKey: KEY,
      writerRunId: 'run',
      generation: 1,
      profileHash: 'sha256-profile',
    }),
    onExit: (fn: () => void) => void exits.push(fn),
    command: vi.fn(async (method: string) => {
      if (method === 'run') {
        await hold.gate
        return { reason: 'completed', lastSeq: hold.lastSeq }
      }
      if (method === 'enqueue') return 1
      if (method === 'ping') return { lastSeq: 0, preset: null }
      if (method === 'scan') return []
      return undefined
    }),
    closeSession: async () => undefined,
    crash() {
      link.alive = false
      for (const fn of exits.splice(0)) fn()
    },
  }
  return link
}

/** The supervisor's per-connection ACP wiring over a real WorkerRegistry, minus the sockets. */
async function connection() {
  const links: Array<ReturnType<typeof workerLink>> = []
  // Held requests wait inside the turn (prompt) or before the open (load) until released.
  const hold: Hold = { gate: Promise.resolve(), lastSeq: 0 }
  const held = (lastSeq = 0) => {
    let release!: () => void
    hold.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hold.lastSeq = lastSeq
    return release
  }
  const acquire = vi.fn(async () => {
    const link = workerLink(hold)
    links.push(link)
    return link
  })
  const inner = new WorkerRegistry({ acquire } as unknown as WorkerPool)
  const registry = new SupervisorRegistry(inner, {
    put() {},
    get: () => undefined,
    keys: () => [],
    observe() {},
    metadata: () => undefined,
    refresh: async () => undefined,
  })
  const binding = await workspaceBinding(KEY)
  await registry.open({ key: KEY, cwd: binding.canonicalRoot, binding })
  const connect = () => {
    const ep = new LocalEndpoint({ clock: () => Date.now(), principalId: 'local' })
    ep.conn.initialized = true
    const pushed = vi.spyOn(ep, 'push')
    const feeds = new Map<string, Feed>()
    const cx = {
      registry,
      clock: () => Date.now(),
      quiescenceWaitMs: 2_000,
      commandQueue: new CommandQueue(),
      activationBarrier: createExtensionActivationBarrier(),
      workspaces: {
        restoreBinding: async () => {
          await hold.gate
          return binding
        },
      },
      sessionOwnership: { resolve: () => ({ principalId: 'local' }) },
    } as unknown as LocalContext
    registerAcp(ep, cx, feeds, new Map<string, AttachedFeed>())
    let id = 0
    const call = (method: string, params: Record<string, unknown>) =>
      ep.handle({ jsonrpc: '2.0', id: ++id, method, params })
    return { ep, feeds, pushed, call }
  }
  const listeners = () => inner.get(KEY)?.listeners.size ?? 0
  let seq = 0
  const turnEnd = (): EventEnvelope =>
    ({
      seq: ++seq,
      type: 'turn/end',
      lane: 'main',
      data: { reason: 'completed' },
    }) as unknown as EventEnvelope
  const deliver = async () => {
    await inner.deliver(KEY, turnEnd())
  }
  return { inner, registry, links, acquire, binding, connect, listeners, deliver, held }
}

const load = { sessionId: KEY, cwd: '/workspace', mcpServers: [] }
const prompt = { sessionId: KEY, prompt: [{ type: 'text', text: 'hi' }] }
const updates = (pushed: { mock: { calls: Array<[{ method: string }]> } }) =>
  pushed.mock.calls.filter(([n]) => n.method === 'session/update').length

describe('ACP feeds on the supervisor path hold one subscription per connection and session', () => {
  it('reuses the subscription across repeated load and prompt, so each event is pushed once', async () => {
    const t = await connection()
    const c = t.connect()
    expect(await c.call('session/load', load)).not.toHaveProperty('error')
    const feed = c.feeds.get(KEY)
    for (const [method, params] of [
      ['session/load', load],
      ['session/prompt', prompt],
      ['session/prompt', prompt],
    ] as const)
      expect(await c.call(method, params)).not.toHaveProperty('error')
    // Every lookup hands out a new view of the same entry; the Feed and its stream state carry over.
    expect(c.feeds.get(KEY)).toBe(feed)
    expect(t.listeners()).toBe(1)
    const before = updates(c.pushed)
    await t.deliver()
    expect(updates(c.pushed) - before).toBe(1)
  })

  it('moves the subscription to a replacement entry for the same key instead of adding one', async () => {
    const t = await connection()
    const c = t.connect()
    expect(await c.call('session/load', load)).not.toHaveProperty('error')
    t.links[0]?.crash()
    // A connection that is still subscribed makes the registry reopen the session.
    await vi.waitFor(() => expect(t.inner.get(KEY)).toBeDefined())
    expect(t.acquire).toHaveBeenCalledTimes(2)
    expect(await c.call('session/load', load)).not.toHaveProperty('error')
    expect(t.listeners()).toBe(1)
    const before = updates(c.pushed)
    await t.deliver()
    expect(updates(c.pushed) - before).toBe(1)
  })

  it('drops every subscription of a closed connection, and a crash then reopens nothing', async () => {
    const t = await connection()
    const c = t.connect()
    expect(await c.call('session/load', load)).not.toHaveProperty('error')
    expect(await c.call('session/prompt', prompt)).not.toHaveProperty('error')
    expect(t.listeners()).toBe(1)
    disposeFeeds(c.feeds)
    expect(t.listeners()).toBe(0)
    expect(c.feeds.size).toBe(0)
    t.links[0]?.crash()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(t.inner.get(KEY)).toBeUndefined()
    expect(t.acquire).toHaveBeenCalledTimes(1)
  })

  it('keeps the other connection subscribed when one of two closes', async () => {
    const t = await connection()
    const a = t.connect()
    const b = t.connect()
    expect(await a.call('session/load', load)).not.toHaveProperty('error')
    expect(await b.call('session/load', load)).not.toHaveProperty('error')
    expect(t.listeners()).toBe(2)
    disposeFeeds(a.feeds)
    expect(t.listeners()).toBe(1)
    const before = updates(b.pushed)
    await t.deliver()
    expect(updates(b.pushed) - before).toBe(1)
  })

  it('does not resubscribe for a prompt that finishes after its connection closed', async () => {
    const t = await connection()
    const c = t.connect()
    expect(await c.call('session/load', load)).not.toHaveProperty('error')
    // The turn reports a seq no row will carry to a feed that is gone; the answer must not wait on it.
    const release = t.held(5)
    const answer = c.call('session/prompt', prompt)
    await vi.waitFor(() => expect(t.links[0]?.command).toHaveBeenCalledWith('run', expect.anything()))
    disposeFeeds(c.feeds)
    const started = Date.now()
    release()
    expect(await answer).not.toHaveProperty('error')
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(t.listeners()).toBe(0)
    expect(c.feeds.size).toBe(0)
  })

  it('does not subscribe for a load that finishes after its connection closed', async () => {
    const t = await connection()
    const c = t.connect()
    const release = t.held()
    const answer = c.call('session/load', load)
    disposeFeeds(c.feeds)
    release()
    expect(await answer).not.toHaveProperty('error')
    expect(t.listeners()).toBe(0)
    expect(c.feeds.size).toBe(0)
  })
})

describe('ACP feed replacement', () => {
  it('keeps the old subscription when subscribing to the replacement entry fails', async () => {
    const listeners = new Set<(e: EventEnvelope) => void>()
    let refuse = false
    const registry = {
      get: () => undefined,
      // A new object per open: the Feed cannot claim it, so every load tries to resubscribe.
      open: async () =>
        ({
          key: KEY,
          generation: 1,
          session: { lastSeq: 0, latest: () => undefined },
        }) as unknown as SessionEntry,
      subscribe: (_key: string, fn: (e: EventEnvelope) => void) => {
        if (refuse) throw new Error('SESSION_NOT_FOUND')
        listeners.add(fn)
        return () => void listeners.delete(fn)
      },
      subscribePreview: () => () => undefined,
      previewSnapshot: async () => [],
    }
    const binding = await workspaceBinding(KEY)
    const ep = new LocalEndpoint({ clock: () => Date.now(), principalId: 'local' })
    ep.conn.initialized = true
    const feeds = new Map<string, Feed>()
    const cx = {
      registry,
      workspaces: { restoreBinding: async () => binding },
      sessionOwnership: { resolve: () => ({ principalId: 'local' }) },
    } as unknown as LocalContext
    registerAcp(ep, cx, feeds, new Map<string, AttachedFeed>())
    const loadIt = (id: number) => ep.handle({ jsonrpc: '2.0', id, method: 'session/load', params: load })
    expect(await loadIt(1)).not.toHaveProperty('error')
    const kept = feeds.get(KEY)
    refuse = true
    expect(await loadIt(2)).toHaveProperty('error')
    expect(listeners.size).toBe(1)
    expect(feeds.get(KEY)).toBe(kept)
  })
})

describe('opening a session for crash recovery', () => {
  it('opens nothing when the session is already open or opening in this daemon', async () => {
    const t = await connection()
    const open = { key: KEY, cwd: t.binding.canonicalRoot, binding: t.binding, resume: true }
    expect(t.registry.openIfAbsent(open, 'run')).toBeNull()
    t.links[0]?.crash()
    // With the entry gone and no one watching it, recovery opens it afresh.
    expect(t.inner.get(KEY)).toBeUndefined()
    const reopening = t.registry.openIfAbsent(open, 'run')
    expect(reopening).not.toBeNull()
    // While that open is in flight, a second recovery pass finds it and stays out.
    expect(t.registry.openIfAbsent(open, 'run')).toBeNull()
    await reopening
    expect(t.acquire).toHaveBeenCalledTimes(2)
  })

  it('recovers a lapsed claim held by some other writer even while this daemon has an entry', async () => {
    const t = await connection()
    const open = { key: KEY, cwd: t.binding.canonicalRoot, binding: t.binding, resume: true }
    // The entry's writer is 'run'; the lapsed claim belongs to a turn some other process left behind.
    const recovering = t.registry.openIfAbsent(open, 'crashed-cli-run')
    expect(recovering).not.toBeNull()
    await expect(recovering).resolves.toMatchObject({ key: KEY })
  })
})
