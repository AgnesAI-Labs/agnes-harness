import { readFileSync } from 'node:fs'
import type { Host, HostSession } from '@agnes/host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_SCOPED_WORKER_METHODS,
  sessionIdleCloseMs,
  sessionScopedKey,
} from '../src/hosted-sessions.js'
import { realHosted } from './real-hosted.js'

const T = 60_000
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  let now = Date.UTC(2026, 0, 1)
  let creates = 0
  const t = await realHosted({
    idleCloseMs: T,
    clock: () => now,
    wrapHost: (host) =>
      ({
        ...host,
        createSession: async (o: Parameters<Host['createSession']>[0]) => {
          creates++
          return host.createSession(o)
        },
      }) as Host,
  })
  cleanups.push(t.close)
  const open = async (key: string) => {
    await t.hosted.open(t.openFrame(key))
    return live(key)
  }
  const live = (key: string): HostSession => {
    const session = t.host.kernel.get(key)
    if (!session) throw new Error(`${key} is not open`)
    return session
  }
  const idle = async (ms = T) => {
    now += ms
    await t.hosted.sweep()
  }
  const hibernated = (key: string) => t.host.kernel.get(key) === undefined
  /** True when nobody holds the writer lease: another writer can open the ledger. */
  const leaseFree = async (session: HostSession) => {
    const storage = session.d.log.storage
    try {
      await storage.open(session.key, { writerRunId: 'probe', ttlMs: 1_000 })
    } catch {
      return false
    }
    await storage.release(session.key, 'probe')
    return true
  }
  const ping = (key: string) => t.hosted.dispatch(t.command(key, 'ping'))
  return { ...t, open, live, idle, hibernated, leaseFree, ping, creates: () => creates }
}

describe('HostedSessions hibernates idle sessions and wakes them on demand', () => {
  it('hibernates a session idle for T and releases its writer lease', async () => {
    const t = await setup()
    const session = await t.open('idle')
    await t.idle(T - 1)
    expect(t.hibernated('idle')).toBe(false)
    await t.idle(1)
    expect(t.hibernated('idle')).toBe(true)
    expect(await t.leaseFree(session)).toBe(true)
    expect(t.sent.filter((f) => f.kind === 'log')).not.toHaveLength(0)
  })

  it('does nothing when T is zero', async () => {
    const t = await realHosted({ idleCloseMs: 0, clock: () => Date.now() + 10 * T })
    cleanups.push(t.close)
    await t.hosted.open(t.openFrame('off'))
    await t.hosted.sweep()
    expect(t.host.kernel.get('off')).toBeDefined()
  })

  it('answers ping and a run-less abort from the stub without waking, and wakes for anything else', async () => {
    const t = await setup()
    const session = await t.open('stub')
    const lastSeq = session.lastSeq
    await t.idle()
    const created = t.creates()
    await expect(t.ping('stub')).resolves.toEqual({
      ok: true,
      lastSeq,
      preset: session.preset.name,
      parent: null,
    })
    await expect(t.hosted.dispatch(t.command('stub', 'abort', { runId: 'none' }))).resolves.toEqual({})
    expect(t.creates()).toBe(created)
    expect(t.hibernated('stub')).toBe(true)
    await expect(t.hosted.dispatch(t.command('stub', 'latest', { register: 'op.state' }))).resolves.toBeNull()
    expect(t.creates()).toBe(created + 1)
    expect(t.hibernated('stub')).toBe(false)
  })

  it('answers ping with the ledger head, even after another writer appended while it slept', async () => {
    const t = await setup()
    const session = await t.open('moved')
    const storage = session.d.log.storage
    await t.idle()
    const before = ((await t.ping('moved')) as { lastSeq: number }).lastSeq
    await storage.open('moved', { writerRunId: 'cli', ttlMs: 60_000 })
    await storage.commit('moved', {
      events: [
        {
          ...session.ev('x/test/note', { text: 'from elsewhere' }, { ignorable: true }),
          ts: new Date().toISOString(),
          id: session.d.ids.ulid(),
          v: 1,
          lane: 'main',
        } as never,
      ],
      expectedWriterRunId: 'cli',
    })
    await storage.release('moved', 'cli')
    const created = t.creates()
    await expect(t.ping('moved')).resolves.toMatchObject({ ok: true, lastSeq: before + 1 })
    expect(t.creates()).toBe(created)
  })

  it('is not kept awake by a periodic ping', async () => {
    const t = await setup()
    await t.open('pinged')
    for (let i = 0; i < 4; i++) {
      await t.idle(T / 4)
      await t.ping('pinged')
    }
    await t.idle(0)
    expect(t.hibernated('pinged')).toBe(true)
  })

  it('stays open while a run is in progress', async () => {
    const t = await setup()
    await t.open('running')
    const release = t.hold()
    await t.prompt('running', 'hold')
    const running = t.run('running')
    await vi.waitFor(() => expect(t.live('running').op()).not.toBeNull())
    await t.idle(10 * T)
    expect(t.hibernated('running')).toBe(false)
    release()
    await running
    await t.idle()
    expect(t.hibernated('running')).toBe(true)
  })

  it('stays open with an unconsumed inbox item', async () => {
    const t = await setup()
    await t.open('inbox')
    await t.prompt('inbox', 'not yet run')
    await t.idle(10 * T)
    expect(t.hibernated('inbox')).toBe(false)
  })

  it('stays open with a pending approval', async () => {
    const t = await setup()
    const session = await t.open('approval')
    await session.append([
      session.ev('approval/asked', {
        requestId: 'pending-request',
        kind: 'tool',
        summary: 'pending',
        risk: 'destructive',
        bindingHash: '0'.repeat(64),
        pending: { ticket: 'pending-ticket', expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
      }),
    ])
    await t.idle(10 * T)
    expect(t.hibernated('approval')).toBe(false)
  })

  it('stays open while a prompter request is outstanding', async () => {
    const t = await setup()
    await t.open('prompter')
    const ac = new AbortController()
    const pending = t.channel.run('prompter', () => t.channel.notice({}, ac.signal)).catch(() => undefined)
    await t.idle(10 * T)
    expect(t.hibernated('prompter')).toBe(false)
    ac.abort()
    await pending
    await t.idle()
    expect(t.hibernated('prompter')).toBe(true)
  })

  it('stays open once its log has faulted', async () => {
    const t = await setup()
    const session = await t.open('faulted')
    ;(session.d.log as unknown as { markFaulted(e: unknown): void }).markFaulted(new Error('sealed'))
    await t.idle(10 * T)
    expect(t.hibernated('faulted')).toBe(false)
  })

  it('wakes for a session-scoped worker command and holds the session open while it runs', async () => {
    const t = await setup()
    await t.open('service')
    await t.idle()
    expect(t.hibernated('service')).toBe(true)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const call = t.hosted.withSession('service', 'callService', async () => {
      expect(t.hibernated('service')).toBe(false)
      await held
      return 'served'
    })
    await vi.waitFor(() => expect(t.hibernated('service')).toBe(false))
    await t.idle(10 * T)
    expect(t.hibernated('service')).toBe(false)
    release()
    await expect(call).resolves.toBe('served')
    // An unknown key is passed straight through, as before.
    await expect(t.hosted.withSession('nobody', 'inspectService', async () => 'through')).resolves.toBe(
      'through',
    )
  })

  it('keeps the pushed stream contiguous across hibernation, resending rows it had not pushed', async () => {
    const t = await setup()
    const session = await t.open('stream')
    await t.hosted.tail('stream', 1)
    const note = (text: string) => session.append([session.ev('x/test/note', { text }, { ignorable: true })])
    await note('first')
    // A commit whose notice never goes out leaves a row behind that no later batch will fill.
    const o = (session.d.log as unknown as { o: { onAppended: ((evs: unknown[]) => void) | undefined } }).o
    const original = o.onAppended
    o.onAppended = (evs) => {
      o.onAppended = original
      original?.(evs)
      throw new Error('host callback failed')
    }
    await expect(note('unannounced')).rejects.toThrow('host callback failed')
    const seqs = () => t.sent.filter((f) => f.kind === 'event').map((f) => f.seq as number)
    expect(seqs().at(-1)).toBeLessThan(session.lastSeq)
    await t.idle()
    expect(t.hibernated('stream')).toBe(true)
    await t.hosted.dispatch(t.command('stream', 'latest', { register: 'op.state' }))
    const woken = t.live('stream')
    await vi.waitFor(() => expect(seqs().at(-1)).toBe(woken.lastSeq))
    expect(seqs()).toEqual(Array.from({ length: woken.lastSeq }, (_, i) => i + 1))
  })

  it('keeps preset and yolo across hibernation', async () => {
    const t = await setup()
    const session = await t.open('settings')
    await t.hosted.dispatch(t.command('settings', 'setYolo', { enabled: true, actor: session.d.actor }))
    const preset = session.preset.name
    await t.idle()
    expect(t.hibernated('settings')).toBe(true)
    await t.hosted.dispatch(t.command('settings', 'latest', { register: 'op.state' }))
    const woken = t.live('settings')
    expect(woken).not.toBe(session)
    expect(woken.preset.name).toBe(preset)
    expect(woken.yolo).toBe(true)
  })

  it('hibernates a fork child before its parent, and wakes the child on its own', async () => {
    const t = await setup()
    const parent = await t.open('parent')
    await t.prompt('parent', 'establish a boundary')
    await t.run('parent')
    const [boundary] = await parent.scan({ type: 'turn/end', order: 'desc', limit: 1 })
    if (!boundary) throw new Error('missing boundary')
    await t.hosted.dispatch(
      t.command('parent', 'fork', {
        at: boundary.seq,
        childKey: 'child',
        credential: undefined,
        binding: t.binding('child'),
      }),
    )
    expect(t.hibernated('child')).toBe(false)
    await t.idle()
    // The parent waits while its child is open; the child goes first.
    expect(t.hibernated('child')).toBe(true)
    expect(t.hibernated('parent')).toBe(false)
    await t.idle()
    expect(t.hibernated('parent')).toBe(true)
    // The child wakes without its parent, serves a session-scoped command, and hibernates again.
    await expect(
      t.hosted.withSession('child', 'callService', async () => t.live('child').d.log.parent),
    ).resolves.toEqual({ key: 'parent', boundarySeq: boundary.seq })
    expect(t.hibernated('parent')).toBe(true)
    await t.idle()
    expect(t.hibernated('child')).toBe(true)
    // With the parent awake, waking the child still lets both hibernate again in order.
    await t.ping('parent')
    await t.hosted.dispatch(t.command('parent', 'latest', { register: 'op.state' }))
    await t.hosted.dispatch(t.command('child', 'latest', { register: 'op.state' }))
    await t.idle()
    await t.idle()
    expect(t.hibernated('child')).toBe(true)
    expect(t.hibernated('parent')).toBe(true)
  })

  it('wakes once for two commands that arrive together', async () => {
    const t = await setup()
    await t.open('twice')
    await t.idle()
    const created = t.creates()
    await Promise.all([
      t.hosted.dispatch(t.command('twice', 'latest', { register: 'op.state' })),
      t.hosted.dispatch(t.command('twice', 'latest', { register: 'inbox' })),
    ])
    expect(t.creates()).toBe(created + 1)
  })

  it('lets close and closeAll wait for a hibernation or a wake in progress', async () => {
    const t = await setup()
    await t.open('a')
    await t.open('b')
    t.hold()
    const hibernating = t.idle()
    const closing = t.hosted.close('a')
    await Promise.all([hibernating, closing])
    expect(t.hibernated('a')).toBe(true)
    await expect(t.ping('a')).rejects.toThrow(/not open/)
    const waking = t.hosted.dispatch(t.command('b', 'latest', { register: 'op.state' }))
    await t.hosted.closeAll()
    await waking.catch(() => undefined)
    expect(t.host.kernel.get('b')).toBeUndefined()
    await expect(t.ping('b')).rejects.toThrow()
  })

  it('does not let a command wake a session that is being closed', async () => {
    const t = await setup()
    await t.open('closing')
    const hibernating = t.idle()
    const closing = t.hosted.close('closing')
    const command = t.hosted.dispatch(t.command('closing', 'latest', { register: 'op.state' }))
    await Promise.allSettled([hibernating, closing, command])
    await expect(command).rejects.toThrow(/not open/)
    expect(t.hibernated('closing')).toBe(true)
    await expect(t.ping('closing')).rejects.toThrow(/not open/)
  })

  it('closes a session that a command was waking when close began', async () => {
    const t = await setup()
    await t.open('waking')
    await t.idle()
    const command = t.hosted.dispatch(t.command('waking', 'latest', { register: 'op.state' }))
    const closing = t.hosted.close('waking')
    await Promise.allSettled([command, closing])
    expect(t.hibernated('waking')).toBe(true)
    await expect(t.ping('waking')).rejects.toThrow(/not open/)
  })

  it('fails a command whose wake is refused, keeps the stub, and wakes on the next command', async () => {
    const t = await setup()
    const session = await t.open('contested')
    const storage = session.d.log.storage
    await t.idle()
    await storage.open('contested', { writerRunId: 'someone-else', ttlMs: 60_000 })
    await expect(
      t.hosted.dispatch(t.command('contested', 'latest', { register: 'op.state' })),
    ).rejects.toThrow()
    await expect(t.ping('contested')).resolves.toMatchObject({ ok: true })
    await storage.release('contested', 'someone-else')
    await expect(
      t.hosted.dispatch(t.command('contested', 'latest', { register: 'op.state' })),
    ).resolves.toBeNull()
    expect(t.hibernated('contested')).toBe(false)
  })
})

describe('the session idle limit', () => {
  it('reads a non-negative whole number of milliseconds, and the default for anything else', () => {
    expect(sessionIdleCloseMs(undefined)).toBe(600_000)
    expect(sessionIdleCloseMs({})).toBe(600_000)
    expect(sessionIdleCloseMs({ 'worker.session_idle_close_ms': 0 })).toBe(0)
    expect(sessionIdleCloseMs({ 'worker.session_idle_close_ms': 5_000 })).toBe(5_000)
    for (const bad of ['5000', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null])
      expect(sessionIdleCloseMs({ 'worker.session_idle_close_ms': bad as never })).toBe(600_000)
  })

  it('assembles in a profile and reaches the worker through Host', async () => {
    const t = await realHosted({ limits: { 'worker.session_idle_close_ms': 5_000 } })
    cleanups.push(t.close)
    expect(t.host.profile.limits['worker.session_idle_close_ms']).toBe(5_000)
  })
})

describe('session-scoped worker commands', () => {
  it('lists every worker command that names a session, and main.ts wakes the session for each', () => {
    const commands = readFileSync(new URL('../src/commands.ts', import.meta.url), 'utf8')
    const service = commands.slice(commands.indexOf('export async function handleServiceCommand'))
    const scoped = [...service.matchAll(/case '([\w.]+)': \{[\s\S]*?(?=\n {4}case |\n {4}default:)/g)]
      .filter(([body]) => /\bp\.(sessionKey|sessionId)\b/.test(body))
      .map(([, method]) => method)
    expect(scoped.length).toBeGreaterThan(0)
    expect([...SESSION_SCOPED_WORKER_METHODS].sort()).toEqual([...scoped].sort())
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).toMatch(/SESSION_SCOPED_WORKER_METHODS/)
    expect(main).toMatch(/withSession\(/)
    // main.ts finds the session under the same two names this guard looks for.
    expect(main).toMatch(/sessionScopedKey\(/)
    expect(sessionScopedKey({ sessionKey: 'a' })).toBe('a')
    expect(sessionScopedKey({ sessionId: 'b' })).toBe('b')
    expect(sessionScopedKey({ sessionKey: 7 })).toBeUndefined()
  })
})
