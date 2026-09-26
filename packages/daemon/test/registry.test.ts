import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import type { LocalContext } from '../src/local/methods/acp.js'
import type { SessionEntry } from '../src/local/sessions.js'
import type { Registry } from '../src/registry.js'
import { type RemoteEntry, WorkerRegistry } from '../src/supervisor/registry.js'
import type { WorkerPool } from '../src/supervisor/worker-pool.js'
import { workspaceBinding } from './workspace-authority.js'

async function open(
  registry: WorkerRegistry,
  options: Parameters<WorkerRegistry['open']>[0] & { key: string },
) {
  return registry.open({
    ...options,
    binding: await workspaceBinding(options.key, options.cwd),
  })
}

// This suite is deliberately compile-time-first: the value of the `Registry<T>` extraction is that
// `tsc` accepts these assignments at all, not any particular runtime behavior. Each `it` still calls
// one shared method so the assertion is not entirely inert.
describe('Registry<T> extraction (local/sessions.ts SessionRegistry, supervisor/registry.ts WorkerRegistry)', () => {
  it('lets the live tool-result projection satisfy an overtaking same-turn media read', async () => {
    const artifactEvent = {
      seq: 7,
      type: 'tool/result',
      lane: 'main',
    } as EventEnvelope
    const command = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'scan') return undefined
      if (params.fromSeq === 1) return []
      return []
    })
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-on-demand',
        sessionKey: 'same-turn-session',
        writerRunId: 'run-on-demand',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command,
    }
    const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => undefined) }
    const registry = new WorkerRegistry(
      { acquire: vi.fn(async () => link) } as unknown as WorkerPool,
      lifecycle,
    )
    await open(registry, { key: 'same-turn-session', cwd: '/workspace', resume: true })
    lifecycle.observe.mockClear()

    const ensuring = registry.ensureArtifactAuthority('same-turn-session', 7)
    await Promise.resolve()
    await registry.deliver('same-turn-session', artifactEvent)
    await ensuring

    expect(command).not.toHaveBeenCalledWith('scan', expect.objectContaining({ fromSeq: 7 }))
    expect(lifecycle.observe).toHaveBeenCalledWith(
      'same-turn-session',
      artifactEvent,
      expect.any(AbortSignal),
    )
  })

  it('reuses a live-projected row without scanning the worker that is waiting for media', async () => {
    const artifactEvent = {
      seq: 7,
      type: 'tool/result',
      lane: 'main',
    } as EventEnvelope
    const command = vi.fn(async (method: string) => (method === 'scan' ? [] : undefined))
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-live-projected',
        sessionKey: 'live-projected-session',
        writerRunId: 'run-live-projected',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command,
    }
    const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => undefined) }
    const registry = new WorkerRegistry(
      { acquire: vi.fn(async () => link) } as unknown as WorkerPool,
      lifecycle,
    )
    await open(registry, { key: 'live-projected-session', cwd: '/workspace', resume: true })
    command.mockClear()
    lifecycle.observe.mockClear()

    await registry.deliver('live-projected-session', artifactEvent)
    await registry.ensureArtifactAuthority('live-projected-session', artifactEvent.seq)

    expect(lifecycle.observe).toHaveBeenCalledOnce()
    expect(command).not.toHaveBeenCalledWith('scan', expect.anything())
  })

  it('refuses media authority when the live ledger row never arrives', async () => {
    vi.useFakeTimers()
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-missing-row',
        sessionKey: 'missing-row-session',
        writerRunId: 'run-missing-row',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(async (method: string) => (method === 'scan' ? [] : undefined)),
    }
    const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => undefined) }
    const registry = new WorkerRegistry(
      { acquire: vi.fn(async () => link) } as unknown as WorkerPool,
      lifecycle,
    )
    await open(registry, { key: 'missing-row-session', cwd: '/workspace', resume: true })

    try {
      const ensuring = registry.ensureArtifactAuthority('missing-row-session', 9)
      const refusal = expect(ensuring).rejects.toThrow('artifact authority event is unavailable')
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(2_000)
      await refusal
      expect(lifecycle.observe).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('replays authority before live publication and detaches synchronously on close', async () => {
    let releaseScan: ((events: EventEnvelope[]) => void) | undefined
    const scan = new Promise<EventEnvelope[]>((resolve) => {
      releaseScan = resolve
    })
    const replay = { seq: 1, type: 'request/header' } as EventEnvelope
    const live = { seq: 2, type: 'request/header' } as EventEnvelope
    const order: string[] = []
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-artifacts',
        sessionKey: 'artifact-session',
        writerRunId: 'run-artifacts',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      closeSession: vi.fn(async () => {
        order.push('worker-close')
      }),
      command: vi.fn((method: string) => {
        if (method === 'scan') return scan
        return Promise.resolve(undefined)
      }),
    }
    const pool = { acquire: vi.fn(async () => link), retire: vi.fn() } as unknown as WorkerPool
    const lifecycle = {
      resetSession: vi.fn(() => order.push('reset')),
      observe: vi.fn(async (_session: string, event: EventEnvelope) => {
        order.push(`observe-${event.seq}`)
      }),
    }
    const registry = new WorkerRegistry(pool, lifecycle)
    const opening = open(registry, { key: 'artifact-session', cwd: '/workspace', resume: true })
    while (!link.command.mock.calls.some(([method]) => method === 'scan')) await Promise.resolve()
    const delivering = registry.deliver('artifact-session', live)
    // Startup delivery must only buffer. Awaiting the replay chain here puts the scan reply behind
    // an event which itself waits for that reply and deadlocks the real worker wire.
    expect(delivering).toBeUndefined()
    releaseScan?.([replay])
    const entry = await opening
    await delivering

    expect(order).toEqual(['reset', 'observe-1', 'observe-2'])
    expect(entry.session.lastSeq).toBe(2)
    const closing = registry.close('artifact-session')
    await closing
    expect(order.slice(-2)).toEqual(['reset', 'worker-close'])
  })

  it('wakes a waiter registered while openFresh replay is still in flight, like deliver() does for live frames', async () => {
    vi.useFakeTimers()
    try {
      let releaseScan: ((events: EventEnvelope[]) => void) | undefined
      const scan = new Promise<EventEnvelope[]>((resolve) => {
        releaseScan = resolve
      })
      const replay = { seq: 1, type: 'request/header' } as EventEnvelope
      const link = {
        alive: true,
        hello: Promise.resolve({
          kind: 'hello' as const,
          token: 'token-replay-waiter',
          sessionKey: 'replay-waiter-session',
          writerRunId: 'run-replay-waiter',
          generation: 1,
          profileHash: 'sha256-profile',
        }),
        onExit: vi.fn(),
        closeSession: vi.fn(async () => undefined),
        command: vi.fn((method: string) => {
          if (method === 'scan') return scan
          return Promise.resolve(undefined)
        }),
      }
      const pool = { acquire: vi.fn(async () => link), retire: vi.fn() } as unknown as WorkerPool
      const lifecycle = { resetSession: vi.fn(), observe: vi.fn(async () => undefined) }
      const registry = new WorkerRegistry(pool, lifecycle)

      const opening = open(registry, { key: 'replay-waiter-session', cwd: '/workspace', resume: true })
      // Let openFresh() publish the entry and issue its replay scan(), but not resolve it yet - the
      // worker is blocked awaiting this exact reply, mirroring the media-read scenario this queue
      // exists for.
      while (!link.command.mock.calls.some(([method]) => method === 'scan')) await Promise.resolve()

      // A live turn asks for media authority on seq 1, satisfiable purely by the in-flight replay.
      const ensuring = registry.ensureArtifactAuthority('replay-waiter-session', 1)

      releaseScan?.([replay])
      await opening

      // If replay woke the waiter the way deliver() does for the live path, this resolves well before
      // the 2s timeout. Advancing past it and still resolving proves the wakeup, not the timeout, fired.
      await vi.advanceTimersByTimeAsync(2_000)

      await expect(ensuring).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('withdraws the entry and closes its channel when tail setup fails after publication', async () => {
    const closeSession = vi.fn(async () => undefined)
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-tail-failure',
        sessionKey: 'tail-failure-session',
        writerRunId: 'run-tail-failure',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      tail: vi.fn(async () => {
        throw new Error('tail setup failed')
      }),
      closeSession,
      command: vi.fn(),
    }
    const registry = new WorkerRegistry({ acquire: vi.fn(async () => link) } as unknown as WorkerPool)

    await expect(
      open(registry, { key: 'tail-failure-session', cwd: '/workspace', resume: true }),
    ).rejects.toThrow('tail setup failed')

    expect(registry.get('tail-failure-session')).toBeUndefined()
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('WorkerRegistry structurally implements Registry<RemoteEntry>', () => {
    // The constructor only stores `pool` privately - it is never touched unless `.open()` is
    // called, so a cast stand-in is enough here; this test never calls `.open()`.
    const wr = new WorkerRegistry({} as WorkerPool)
    const asRegistry: Registry<RemoteEntry> = wr
    expect(asRegistry.keys()).toEqual([])
  })

  it('coalesces concurrent opens for one session key onto one worker link and entry', async () => {
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token',
        sessionKey: 'session-one',
        writerRunId: 'run-one',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    }
    const pool = { acquire: vi.fn(async () => link) } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const [first, second] = await Promise.all([
      open(registry, { key: 'session-one', cwd: '/workspace' }),
      open(registry, { key: 'session-one', cwd: '/workspace' }),
    ])
    expect(first).toBe(second)
    expect(pool.acquire).toHaveBeenCalledTimes(1)
    expect(registry.keys()).toEqual(['session-one'])
  })

  it('retires an idle session synchronously so the same history opens a fresh resource generation', async () => {
    let generation = 0
    const retire = vi.fn()
    const resetSession = vi.fn()
    const pool = {
      acquire: vi.fn(async (key: string) => ({
        alive: true,
        hello: Promise.resolve({
          kind: 'hello' as const,
          token: `token-${++generation}`,
          sessionKey: key,
          writerRunId: `run-${generation}`,
          generation,
          profileHash: 'sha256-profile',
        }),
        onExit: vi.fn(),
        command: vi.fn(async (method: string) => (method === 'scan' ? [] : undefined)),
      })),
      retire,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool, {
      resetSession,
      observe: vi.fn(async () => undefined),
    })
    await open(registry, { key: 'same-history', cwd: '/workspace', resume: true })
    resetSession.mockClear()

    registry.retireForResourceSnapshot()

    expect(retire).toHaveBeenCalledWith(['same-history'], 'resource-snapshot-reload')
    expect(resetSession).toHaveBeenCalledWith('same-history')
    expect(registry.get('same-history')).toBeUndefined()
    await open(registry, { key: 'same-history', cwd: '/workspace', resume: true })
    expect(pool.acquire).toHaveBeenCalledTimes(2)
  })

  it('does not publish a worker that was still opening when the resource snapshot changed', async () => {
    let releaseFirst: ((link: unknown) => void) | undefined
    const first = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    const retire = vi.fn()
    const link = (token: string) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token,
        sessionKey: 'opening-session',
        writerRunId: token,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      closeSession: vi.fn(async () => undefined),
      command: vi.fn(),
    })
    const initial = link('old-generation')
    const replacement = link('new-generation')
    let acquireCalls = 0
    const pool = {
      acquire: vi.fn(async () => (++acquireCalls === 1 ? first : replacement)),
      retire,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const binding = await workspaceBinding('opening-session')
    const opening = registry.open({
      key: 'opening-session',
      cwd: '/workspace',
      binding,
      resume: true,
    })
    await Promise.resolve()

    registry.retireForResourceSnapshot()
    releaseFirst?.(initial)
    const opened = await opening

    expect(opened.session.writerRunId).toBe('new-generation')
    expect(initial.closeSession).toHaveBeenCalledWith('resource-snapshot-reload')
    expect(pool.acquire).toHaveBeenCalledTimes(2)
  })

  // The worker's tail replay for the discarded open can still be in flight when the fence trips. Were
  // those frames projected after the entry was gone they would fail the key, and that failure retires
  // whichever channel then holds the key: the replacement, so the open failed as an internal error.
  it('absorbs frames the discarded open sends while it closes, and publishes the replacement', async () => {
    let registry!: WorkerRegistry
    let releaseFirst: ((link: unknown) => void) | undefined
    const first = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    const staleDeliveries: Array<Promise<unknown>> = []
    const link = (token: string, closeSession: () => Promise<void>) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token,
        sessionKey: 'opening-session',
        writerRunId: token,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      closeSession: vi.fn(closeSession),
      command: vi.fn(async (method: string) => (method === 'scan' ? [] : undefined)),
    })
    const initial = link('old-generation', async () => {
      staleDeliveries.push(
        Promise.resolve().then(() =>
          registry.deliver('opening-session', { seq: 1, type: 'session/opened' } as unknown as EventEnvelope),
        ),
      )
      await staleDeliveries.at(-1)
    })
    const replacement = link('new-generation', async () => undefined)
    let acquireCalls = 0
    // Like the real pool, retiring the key closes its current channel without waiting.
    const retire = vi.fn(() => void initial.closeSession())
    const pool = {
      acquire: vi.fn(async () => (++acquireCalls === 1 ? first : replacement)),
      retire,
    } as unknown as WorkerPool
    registry = new WorkerRegistry(pool, { observe: async () => undefined, resetSession: () => undefined })
    const opening = registry.open({
      key: 'opening-session',
      cwd: '/workspace',
      binding: await workspaceBinding('opening-session'),
      resume: true,
    })
    await Promise.resolve()

    registry.noteResourceSnapshotCommitted()
    releaseFirst?.(initial)
    const opened = await opening

    await expect(Promise.all(staleDeliveries)).resolves.toBeDefined()
    expect(initial.closeSession).toHaveBeenCalledWith('resource-snapshot-reload')
    expect(opened.session.writerRunId).toBe('new-generation')
    expect(registry.get('opening-session')).toBe(opened)
    expect(retire).not.toHaveBeenCalled()
  })

  // Task 7 (resource-live-reload plan): the daemon's wiring (supervisor.ts's
  // `wireResourceSnapshotNotifications`) now calls this narrower sibling of
  // `retireForResourceSnapshot()` for only the sessions whose lightweight `resource.stale`
  // notification failed to deliver, instead of unconditionally retiring every live session.
  it('retireSessions retires only the named sessions and threads the given reason to pool.retire', async () => {
    let generation = 0
    const retire = vi.fn()
    const pool = {
      acquire: vi.fn(async (key: string) => ({
        alive: true,
        hello: Promise.resolve({
          kind: 'hello' as const,
          token: `token-${++generation}`,
          sessionKey: key,
          writerRunId: `run-${generation}`,
          generation,
          profileHash: 'sha256-profile',
        }),
        onExit: vi.fn(),
        command: vi.fn(),
      })),
      retire,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    await open(registry, { key: 'keep-session', cwd: '/workspace', resume: true })
    await open(registry, { key: 'notify-failed-session', cwd: '/workspace', resume: true })

    registry.retireSessions(['notify-failed-session'], 'resource-notify-failed')

    expect(retire).toHaveBeenCalledTimes(1)
    expect(retire).toHaveBeenCalledWith(['notify-failed-session'], 'resource-notify-failed')
    expect(registry.get('notify-failed-session')).toBeUndefined()
    expect(registry.get('keep-session')).toBeDefined()
  })

  it('retireSessions still bumps the resource epoch so a worker mid-open when any snapshot changes is discarded, even when its key is not in the retired list', async () => {
    let releaseFirst: ((link: unknown) => void) | undefined
    const first = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    const retire = vi.fn()
    const link = (token: string) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token,
        sessionKey: 'opening-session',
        writerRunId: token,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      closeSession: vi.fn(async () => undefined),
      command: vi.fn(),
    })
    const initial = link('old-generation')
    const replacement = link('new-generation')
    let acquireCalls = 0
    const pool = {
      acquire: vi.fn(async () => (++acquireCalls === 1 ? first : replacement)),
      retire,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const binding = await workspaceBinding('opening-session')
    const opening = registry.open({
      key: 'opening-session',
      cwd: '/workspace',
      binding,
      resume: true,
    })
    await Promise.resolve()

    // Note: 'opening-session' itself is never named here - it is not (yet) a live entry this call
    // could retire by key, but the epoch bump must still fence it out of publishing the stale read.
    registry.retireSessions(['some-other-session-that-failed-notify'], 'resource-notify-failed')
    releaseFirst?.(initial)
    const opened = await opening

    expect(opened.session.writerRunId).toBe('new-generation')
    expect(pool.acquire).toHaveBeenCalledTimes(2)
  })

  it('keeps a busy session on its old snapshot until the terminal turn boundary', async () => {
    let completeRun: ((value: { reason: string; lastSeq: number }) => void) | undefined
    const run = new Promise<{ reason: string; lastSeq: number }>((resolve) => {
      completeRun = resolve
    })
    const retire = vi.fn()
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-busy',
        sessionKey: 'busy-session',
        writerRunId: 'run-busy',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn((method: string) => (method === 'run' ? run : undefined)),
    }
    const pool = { acquire: vi.fn(async () => link), retire } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const entry = await open(registry, { key: 'busy-session', cwd: '/workspace' })
    const running = entry.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await Promise.resolve()

    registry.retireForResourceSnapshot()
    expect(retire).not.toHaveBeenCalled()
    expect(registry.get('busy-session')).toBe(entry)

    completeRun?.({ reason: 'completed', lastSeq: 4 })
    await running
    expect(retire).toHaveBeenCalledWith(['busy-session'], 'resource-snapshot-reload')
    expect(registry.get('busy-session')).toBeUndefined()
  })

  it('does not retire a reopened session from a stale crashed generation marker', async () => {
    let oldExit: (() => void) | undefined
    const old = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-old',
        sessionKey: 'crashed-session',
        writerRunId: 'run-old',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn((notify: () => void) => {
        oldExit = notify
      }),
      command: vi.fn(),
    }
    const current = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-current',
        sessionKey: 'crashed-session',
        writerRunId: 'run-current',
        generation: 2,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    }
    let acquires = 0
    const retire = vi.fn()
    const pool = {
      acquire: vi.fn(async () => (++acquires === 1 ? old : current)),
      retire,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const busy = await open(registry, { key: 'crashed-session', cwd: '/workspace' })
    busy.inflight = { promptId: 'prompt', abort: new AbortController() }

    registry.retireForResourceSnapshot()
    expect(retire).not.toHaveBeenCalled()
    oldExit?.()
    expect(registry.get('crashed-session')).toBeUndefined()

    const reopened = await open(registry, { key: 'crashed-session', cwd: '/workspace', resume: true })
    registry.retireAtTurnBoundary('crashed-session')

    expect(reopened.session.writerRunId).toBe('run-current')
    expect(registry.get('crashed-session')).toBe(reopened)
    expect(retire).not.toHaveBeenCalled()
  })

  it('keeps a scheduler enqueue-to-run activity lease on the old snapshot until released', async () => {
    const retire = vi.fn()
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-scheduler',
        sessionKey: 'scheduler-session',
        writerRunId: 'run-scheduler',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    }
    const pool = { acquire: vi.fn(async () => link), retire } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const entry = await open(registry, { key: 'scheduler-session', cwd: '/workspace' })
    const releaseActivity = entry.session.beginActivity()

    registry.retireForResourceSnapshot()
    expect(retire).not.toHaveBeenCalled()
    releaseActivity()

    expect(retire).toHaveBeenCalledWith(['scheduler-session'], 'resource-snapshot-reload')
  })

  it('waits for ACP prompt cleanup when the worker run has already reached its terminal boundary', async () => {
    const retire = vi.fn()
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token-prompt',
        sessionKey: 'prompt-session',
        writerRunId: 'run-prompt',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(async () => ({ reason: 'completed', lastSeq: 4 })),
    }
    const pool = { acquire: vi.fn(async () => link), retire } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    const entry = await open(registry, { key: 'prompt-session', cwd: '/workspace' })
    entry.inflight = { promptId: 'prompt', abort: new AbortController() }

    registry.retireForResourceSnapshot()
    expect(retire).not.toHaveBeenCalled()
    entry.inflight = null
    registry.retireAtTurnBoundary(entry.key)

    expect(retire).toHaveBeenCalledWith(['prompt-session'], 'resource-snapshot-reload')
  })

  it('forks through the parent worker, reopens the child independently, and keeps retry identity', async () => {
    const parentCommand = vi.fn(async (method: string) => {
      if (method === 'ping') return { lastSeq: 12, preset: 'coding', parent: null }
      if (method === 'projectUI') return { opState: null }
      if (method === 'scan') return [{ type: 'turn/end', data: { reason: 'completed' } }]
      if (method === 'fork') return { sessionId: 'child', parent: { key: 'parent', boundarySeq: 9 } }
      throw new Error(`unexpected parent command ${method}`)
    })
    const childCommand = vi.fn(async (method: string) => {
      if (method === 'ping')
        return {
          lastSeq: 13,
          preset: 'coding',
          parent: { key: 'parent', boundarySeq: 9 },
        }
      throw new Error(`unexpected child command ${method}`)
    })
    const link = (key: string, command: (method: string) => Promise<unknown>) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: `${key}-token`,
        sessionKey: key,
        writerRunId: `${key}-run`,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command,
    })
    const pool = {
      acquire: vi.fn(async (key: string) =>
        key === 'parent' ? link(key, parentCommand) : link(key, childCommand),
      ),
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    await open(registry, { key: 'parent', cwd: '/workspace', preset: 'coding' })

    const childBinding = await workspaceBinding('child')
    const first = await registry.fork({ parent: 'parent', at: 9, childKey: 'child', binding: childBinding })
    const retried = await registry.fork({
      parent: 'parent',
      at: 9,
      childKey: 'child',
      binding: childBinding,
    })

    expect(retried).toBe(first)
    expect(parentCommand).toHaveBeenCalledWith('fork', {
      at: 9,
      childKey: 'child',
      credential: undefined,
      binding: childBinding,
    })
    expect(pool.acquire).toHaveBeenCalledWith('child', {
      resume: true,
      cwd: '/workspace',
      binding: childBinding,
      preset: 'coding',
      parent: { key: 'parent', boundarySeq: 9 },
    })
  })

  it('closes a worker-adopted child when its daemon-side open is not acknowledged', async () => {
    const parentCommand = vi.fn(async (method: string) => {
      if (method === 'ping') return { lastSeq: 12, preset: 'coding', parent: null }
      if (method === 'projectUI') return { opState: null }
      if (method === 'scan') return [{ type: 'turn/end', data: { reason: 'completed' } }]
      if (method === 'fork') return { sessionId: 'orphan', parent: { key: 'parent', boundarySeq: 9 } }
      throw new Error(`unexpected parent command ${method}`)
    })
    const parentLink = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'parent-token',
        sessionKey: 'parent',
        writerRunId: 'parent-run',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: parentCommand,
    }
    const closeHostedSession = vi.fn(async () => undefined)
    const pool = {
      acquire: vi.fn(async (key: string) => {
        if (key === 'parent') return parentLink
        throw new Error('child open ACK lost')
      }),
      closeHostedSession,
    } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)
    await open(registry, { key: 'parent', cwd: '/workspace', preset: 'coding' })
    const binding = await workspaceBinding('orphan')

    await expect(registry.fork({ parent: 'parent', at: 9, childKey: 'orphan', binding })).rejects.toThrow(
      'child open ACK lost',
    )

    expect(parentCommand).toHaveBeenCalledWith('fork', {
      at: 9,
      childKey: 'orphan',
      credential: undefined,
      binding,
    })
    expect(closeHostedSession).toHaveBeenCalledWith('orphan', 'fork adoption failed')
    expect(registry.get('orphan')).toBeUndefined()
  })

  it('does not publish a link that died before its exit observer was registered', async () => {
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'token',
        sessionKey: 'session-died-during-open',
        writerRunId: 'run-died-during-open',
        generation: 1,
        workerGeneration: 2,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn((notify: () => void) => {
        link.alive = false
        notify()
      }),
      command: vi.fn(),
    }
    const pool = { acquire: vi.fn(async () => link) } as unknown as WorkerPool
    const registry = new WorkerRegistry(pool)

    await expect(
      open(registry, { key: 'session-died-during-open', cwd: '/workspace', resume: true }),
    ).rejects.toThrow('worker link closed while opening session')
    expect(registry.keys()).toEqual([])
  })

  it('lets an explicit close fence an in-flight crash recovery before it can republish', async () => {
    let oldExit: (() => void) | undefined
    let releaseRecovery: ((link: unknown) => void) | undefined
    const recoveryLink = new Promise((resolve) => {
      releaseRecovery = resolve
    })
    const old = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'old-token',
        sessionKey: 'close-during-recovery',
        writerRunId: 'old-run',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn((notify: () => void) => {
        oldExit = notify
      }),
      command: vi.fn(),
    }
    const recovered = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'new-token',
        sessionKey: 'close-during-recovery',
        writerRunId: 'new-run',
        generation: 2,
        profileHash: 'sha256-profile',
      }),
      closeSession: vi.fn(async () => {
        throw new Error('recovery channel close failed')
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    }
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(old)
      .mockImplementationOnce(() => recoveryLink)
    const registry = new WorkerRegistry({ acquire } as unknown as WorkerPool)
    await open(registry, { key: 'close-during-recovery', cwd: '/workspace' })
    // Crash recovery reopens only a session somebody is subscribed to.
    registry.subscribe('close-during-recovery', () => undefined)

    oldExit?.()
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(2))
    const closing = registry.close('close-during-recovery')
    releaseRecovery?.(recovered)
    await closing

    await vi.waitFor(() => expect(recovered.closeSession).toHaveBeenCalledOnce())
    expect(registry.get('close-during-recovery')).toBeUndefined()
    expect(acquire).toHaveBeenCalledTimes(2)
  })

  // A session reopened by the resource-snapshot fence leaves the discarded generation's exit
  // observer on the shared worker, next to the replacement's. When that worker goes, the stale
  // observer runs first; it must not keep the replacement's own observer from starting recovery.
  it('recovers a watched session whose earlier open was discarded on the same worker', async () => {
    const key = 'reopened-then-crashed'
    const workerExit: Array<() => void> = []
    const channel = (token: string) => ({
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token,
        sessionKey: key,
        writerRunId: token,
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      // Like a real session channel, exit is observed on the whole worker link.
      onExit: (notify: () => void) => void workerExit.push(notify),
      closeSession: vi.fn(async () => undefined),
      command: vi.fn(async (method: string) => (method === 'scan' ? [] : undefined)),
    })
    let releaseFirst: ((link: unknown) => void) | undefined
    const first = new Promise<unknown>((resolve) => {
      releaseFirst = resolve
    })
    const acquire = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce(channel('replacement'))
      .mockResolvedValueOnce(channel('recovered'))
    const registry = new WorkerRegistry({ acquire, retire: vi.fn() } as unknown as WorkerPool)
    const opening = open(registry, { key, cwd: '/workspace', resume: true })
    await vi.waitFor(() => expect(acquire).toHaveBeenCalledOnce())
    registry.noteResourceSnapshotCommitted()
    releaseFirst?.(channel('discarded'))
    expect((await opening).session.writerRunId).toBe('replacement')
    registry.subscribe(key, () => undefined)
    expect(workerExit).toHaveLength(2)

    for (const notify of workerExit.splice(0)) notify()

    await vi.waitFor(() => expect(registry.get(key)?.session.writerRunId).toBe('recovered'))
    expect(acquire).toHaveBeenCalledTimes(3)
    await registry.closeAll()
  })

  it('finishes pending and map cleanup after the first session close fails', async () => {
    const link = {
      alive: true,
      hello: Promise.resolve({
        kind: 'hello' as const,
        token: 'close-failure-token',
        sessionKey: 'close-failure-session',
        writerRunId: 'close-failure-run',
        generation: 1,
        profileHash: 'sha256-profile',
      }),
      onExit: vi.fn(),
      command: vi.fn(),
    }
    const registry = new WorkerRegistry({ acquire: vi.fn(async () => link) } as unknown as WorkerPool)
    const first = await open(registry, { key: 'close-failure-session', cwd: '/workspace' })
    const firstClose = vi.fn(async () => {
      throw new Error('first close failed')
    })
    first.session.close = firstClose

    const lateClose = vi.fn(async () => undefined)
    const late = {
      ...first,
      session: { close: lateClose },
      ac: new AbortController(),
      recover: true,
    } as unknown as RemoteEntry
    type RegistryInternals = {
      entries: Map<string, RemoteEntry>
      opening: Map<string, { epoch: number; promise: Promise<RemoteEntry> }>
      artifactQueues: Map<string, Promise<void>>
      resourceRetirements: Map<string, unknown>
    }
    const internals = registry as unknown as RegistryInternals
    let releaseOpening: (() => void) | undefined
    const opening = new Promise<RemoteEntry>((resolve) => {
      releaseOpening = () => {
        internals.entries.set('close-failure-session', late)
        resolve(late)
      }
    }).finally(() => internals.opening.delete('close-failure-session'))
    internals.opening.set('close-failure-session', { epoch: 0, promise: opening })
    internals.artifactQueues.set('close-failure-session', Promise.resolve())
    internals.resourceRetirements.set('close-failure-session', {})

    const closing = registry.close('close-failure-session')
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce())
    releaseOpening?.()
    await expect(closing).rejects.toThrow('first close failed')

    expect(lateClose).toHaveBeenCalledOnce()
    expect(registry.get('close-failure-session')).toBeUndefined()
    expect(internals.opening.has('close-failure-session')).toBe(false)
    expect(internals.artifactQueues.has('close-failure-session')).toBe(false)
    expect(internals.resourceRetirements.has('close-failure-session')).toBe(false)
  })

  it('LocalContext.registry accepts any Registry<SessionEntry>, not just a SessionRegistry instance', () => {
    // A minimal fake, not a SessionRegistry: this is the actual proof the extraction was worth
    // doing - LocalContext no longer names the concrete class, so anything shaped like
    // Registry<SessionEntry> is accepted.
    const fake: Registry<SessionEntry> = {
      open: () => Promise.reject(new Error('unused')),
      fork: () => Promise.reject(new Error('unused')),
      get: () => undefined,
      require: () => {
        throw new Error('unused')
      },
      subscribe: () => () => undefined,
      subscribePreview: () => () => undefined,
      previewSnapshot: () => Promise.resolve([]),
      keys: () => [],
      close: () => Promise.resolve(),
      closeAll: () => Promise.resolve(),
    }
    const registry: LocalContext['registry'] = fake
    expect(registry.keys()).toEqual([])
  })

  it('a WorkerRegistry (Registry<RemoteEntry>) is correctly refused where Registry<SessionEntry> is required', () => {
    // The flip side of the test above: the generic parameter is doing real work, not erasing to
    // `any`. SessionEntry and RemoteEntry are genuinely different shapes (a RemoteEntry has no
    // backlog/backlogTruncated/tailError/listenerErrors, and its `session` is a RemoteSession, not
    // a HostSession) - a real WorkerRegistry is not a drop-in for LocalContext.registry today. That
    // reconciliation is later work (a future startSupervisor task), not this extraction.
    const wr = new WorkerRegistry({} as WorkerPool)
    // @ts-expect-error RemoteEntry is not assignable to SessionEntry - see comment above.
    const registry: LocalContext['registry'] = wr
    expect(registry).toBe(wr)
  })
})
