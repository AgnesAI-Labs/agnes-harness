import { createExtensionActivationBarrier } from '@agnes/host'
import type { Actor, ContentBlock } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type JobRow, JobsRepo } from '../src/jobs/repo.js'
import { Scheduler, type SchedulerRegistry } from '../src/jobs/scheduler.js'
import type { WorkspaceBindingEnvelope } from '../src/storage/workspaces.js'
import { sqliteTables } from './sqlite-tables.js'

const row = (key: string, over: Partial<JobRow> = {}): JobRow => ({
  idempotencyKey: key,
  sessionKey: 'k',
  profileHash: 'h',
  payload: { prompt: 'go' },
  schedule: { kind: 'once' },
  status: 'waiting',
  attempts: 0,
  maxAttempts: 2,
  backoffMs: 1_000,
  delayUntil: 0,
  stalledCounter: 0,
  protected: false,
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const workspaceAuthority = (path: string | null = '/workspace') => ({
  async restoreBinding(sessionKey: string): Promise<WorkspaceBindingEnvelope> {
    if (!path) throw new Error(`session workspace unavailable for ${sessionKey}`)
    return {
      version: 1,
      sessionKey,
      workspaceId: 'a'.repeat(64),
      revision: 1,
      canonicalRoot: path,
    } as WorkspaceBindingEnvelope
  },
})

function fakeRegistry(options: { busy?: boolean; fail?: boolean; live?: boolean; cwd?: string } = {}) {
  const calls: Array<{ kind: string; value?: unknown }> = []
  const entry = {
    key: 'k',
    inflight: options.busy ? { promptId: 'x', abort: new AbortController() } : null,
    session: {
      cwd: options.cwd ?? '/workspace',
      enqueue: async (target: 'next-turn' | 'next-step', message: unknown) => {
        calls.push({ kind: `enqueue:${target}`, value: message })
        return 5
      },
      run: async (_options: { until: 'turn-end'; signal: AbortSignal }) => {
        calls.push({ kind: 'run' })
        return options.fail
          ? { reason: 'error', lastSeq: 6, error: { code: 'X', message: 'boom' } }
          : { reason: 'completed', lastSeq: 6 }
      },
      resume: async () => {
        calls.push({ kind: 'resume' })
        return { state: 'resumed' }
      },
    },
  }
  const registry: SchedulerRegistry = {
    open: async (value) => {
      calls.push({ kind: 'open', value })
      return entry
    },
    get: () => (options.live === false ? undefined : entry),
    keys: () => (options.live === false ? [] : ['k']),
  }
  return { calls, registry }
}

function scheduler(
  repo: JobsRepo,
  registry: SchedulerRegistry,
  clock: () => number,
  emit: (kind: string, options: { sessionId?: string; detail: unknown }) => void = () => undefined,
) {
  return new Scheduler({
    repo,
    registry,
    notices: { emit } as never,
    clock,
    owner: 'owner',
    limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
    workspaces: workspaceAuthority(),
    ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
    activationBarrier: createExtensionActivationBarrier(),
    random: () => 0.5,
  })
}

describe('Scheduler', () => {
  it('does not start a scheduled remote turn across an activation cutover', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('activation-race'))
    const { calls, registry } = fakeRegistry()
    const activationBarrier = createExtensionActivationBarrier()
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const activation = activationBarrier.quiesce('scheduled-cutover', () => held)
    await Promise.resolve()
    const instance = new Scheduler({
      repo,
      registry,
      notices: { emit() {} } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: workspaceAuthority(),
      ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
      activationBarrier,
      random: () => 0.5,
    })

    await instance.tick()
    expect(calls).toEqual([])
    expect(repo.get('activation-race')).toMatchObject({
      status: 'delayed',
      error: 'activation-in-progress',
    })
    release()
    await activation
  })

  it('does not let a queued tick claim or open work after intake stops', async () => {
    vi.useFakeTimers()
    try {
      const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
      repo.insert(row('first'))
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const opened: string[] = []
      const registry = fakeRegistry().registry
      registry.open = vi.fn(async (options) => {
        opened.push(options.key ?? '')
        const entry = await fakeRegistry().registry.open(options)
        entry.session.run = async () => {
          await gate
          return { reason: 'completed', lastSeq: 1 }
        }
        return entry
      })
      const instance = new Scheduler({
        repo,
        registry,
        notices: { emit() {} } as never,
        clock: () => 10_000,
        owner: 'owner',
        limits: { tickMs: 10, lockMs: 60_000, maxStalled: 5 },
        workspaces: workspaceAuthority(),
        ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
        activationBarrier: createExtensionActivationBarrier(),
      })
      instance.start()
      await vi.advanceTimersByTimeAsync(10)
      expect(opened).toEqual(['k'])
      repo.insert(row('queued', { sessionKey: 'queued' }))
      vi.advanceTimersByTime(30)

      instance.stopIntake()
      release()
      await instance.stop()

      expect(opened).toEqual(['k'])
      expect(repo.get('queued')).toMatchObject({ status: 'waiting' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('immediately aborts a controller created reentrantly after stop', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('racing'))
    let instance!: Scheduler
    let stopping!: Promise<void>
    const fake = fakeRegistry()
    fake.registry.open = vi.fn(fake.registry.open)
    instance = new Scheduler({
      repo,
      registry: fake.registry,
      notices: {
        emit() {
          stopping = instance.stop()
        },
      } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: workspaceAuthority(),
      ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
      activationBarrier: createExtensionActivationBarrier(),
    })

    await instance.tick()
    await stopping

    expect(fake.registry.open).not.toHaveBeenCalled()
    expect(repo.get('racing')).toMatchObject({ status: 'active', leaseOwner: 'owner' })
  })

  it('does not claim waiting work when a dead-job notice stops intake during a tick', async () => {
    let now = 0
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('dead', { stalledCounter: 5 }))
    repo.claimDue(now, 'old-owner', 10, 1)
    repo.insert(row('waiting'))
    now = 20
    let instance!: Scheduler
    const opened = vi.fn(fakeRegistry().registry.open)
    instance = scheduler(
      repo,
      { ...fakeRegistry().registry, open: opened },
      () => now,
      (kind) => {
        if (kind === 'job_dead') instance.stopIntake()
      },
    )

    await expect(instance.tick()).resolves.toEqual({ claimed: 0, requeued: 0, dead: 1 })
    expect(opened).not.toHaveBeenCalled()
    expect(repo.get('waiting')).toMatchObject({ status: 'waiting' })
  })

  it('does not heartbeat an admitted job after stop aborts it', async () => {
    vi.useFakeTimers()
    try {
      const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
      repo.insert(row('heartbeat'))
      repo.heartbeat = vi.fn(repo.heartbeat.bind(repo))
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const fake = fakeRegistry()
      const entry = await fake.registry.open({ key: 'k', cwd: '/workspace' })
      entry.session.run = async () => {
        await gate
        return { reason: 'completed', lastSeq: 1 }
      }
      fake.registry.open = async () => entry
      const instance = scheduler(repo, fake.registry, () => 10_000)
      const ticking = instance.tick()
      await Promise.resolve()
      const stopping = instance.stop()

      vi.advanceTimersByTime(10_000)
      expect(repo.heartbeat).not.toHaveBeenCalled()
      release()
      await Promise.all([ticking, stopping])
      expect(repo.get('heartbeat')).toMatchObject({ status: 'active', leaseOwner: 'owner' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispatches a due once-job to an idle session and completes it', async () => {
    const now = 10_000
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('j1'))
    const notices: Array<{ kind: string; sessionId?: string }> = []
    const { calls, registry } = fakeRegistry()
    const instance = scheduler(
      repo,
      registry,
      () => now,
      (kind, options) =>
        notices.push({ kind, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }),
    )

    expect(await instance.tick()).toEqual({ claimed: 1, requeued: 0, dead: 0 })
    expect(calls.map((call) => call.kind)).toEqual(['open', 'enqueue:next-turn', 'run'])
    expect(repo.get('j1')).toMatchObject({
      status: 'completed',
      result: { seq: 6, reason: 'completed' },
    })
    expect(notices).toEqual([{ kind: 'job_dispatched', sessionId: 'k' }])
  })

  it('steers a busy session and preserves the scheduler actor and prompt', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('busy', { payload: { prompt: 'x', delivery: 'steer' } }))
    const { calls, registry } = fakeRegistry({ busy: true })
    await scheduler(repo, registry, () => 10_000).tick()
    expect(calls.map((call) => call.kind)).toEqual(['open', 'enqueue:next-step'])
    const message = calls[1]?.value as { actor: Actor; content: ContentBlock[] }
    expect(message.actor).toMatchObject({ id: 'job:busy', role: 'system' })
    expect(message.content).toEqual([{ type: 'text', text: 'x' }])
    expect(repo.get('busy')).toMatchObject({ status: 'completed', result: { seq: 5 } })
  })

  it('reopens a non-live session only at its persisted workspace and forwards its budget', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('budgeted', { budget: 7 }))
    const { calls, registry } = fakeRegistry({ live: false, cwd: '/workspace/from-index' })
    const instance = new Scheduler({
      repo,
      registry,
      notices: { emit: () => undefined } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: workspaceAuthority('/workspace/from-index'),
      ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
      activationBarrier: createExtensionActivationBarrier(),
    })
    await instance.tick()
    expect(calls[0]).toMatchObject({
      kind: 'open',
      value: {
        key: 'k',
        cwd: '/workspace/from-index',
        binding: { sessionKey: 'k', canonicalRoot: '/workspace/from-index' },
      },
    })
    expect(calls[1]).toMatchObject({
      kind: 'enqueue:next-turn',
      value: { budget: 7 },
    })
  })

  it('fails closed when a non-live session has no persisted workspace', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('missing-cwd'))
    const { calls, registry } = fakeRegistry({ live: false })
    const instance = new Scheduler({
      repo,
      registry,
      notices: { emit: () => undefined } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: workspaceAuthority(null),
      ownership: { resolve: () => ({ active: true, principalId: 'owner' }) },
      activationBarrier: createExtensionActivationBarrier(),
      random: () => 0.5,
    })
    await instance.tick()
    expect(calls).toEqual([])
    expect(repo.get('missing-cwd')).toMatchObject({
      status: 'delayed',
      error: 'session workspace unavailable for k',
    })
  })

  it('does not run a legacy job without an active session owner', async () => {
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => 10_000)
    repo.insert(row('unowned'))
    const { calls, registry } = fakeRegistry()
    const instance = new Scheduler({
      repo,
      registry,
      notices: { emit: () => undefined } as never,
      clock: () => 10_000,
      owner: 'owner',
      limits: { tickMs: 1_000, lockMs: 60_000, maxStalled: 5 },
      workspaces: workspaceAuthority(),
      ownership: { resolve: () => undefined },
      activationBarrier: createExtensionActivationBarrier(),
      random: () => 0.5,
    })
    await instance.tick()
    expect(calls).toEqual([])
    expect(repo.get('unowned')).toMatchObject({
      status: 'delayed',
      error: 'session owner unavailable for k',
    })
  })

  it('retries with jittered backoff, promotes delayed work, then fails', async () => {
    let now = 10_000
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('flaky'))
    const failed = fakeRegistry({ fail: true })
    const instance = scheduler(repo, failed.registry, () => now)
    await instance.tick()
    expect(repo.get('flaky')).toMatchObject({ status: 'delayed', attempts: 1, delayUntil: 11_000 })
    now = 11_000
    await instance.tick()
    expect(repo.get('flaky')).toMatchObject({ status: 'failed', attempts: 2, error: 'boom' })
  })

  it('reschedules recurring jobs after success and executes resume commands', async () => {
    const now = 10_000
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('every', { schedule: { kind: 'every', everyMs: 60_000 } }))
    repo.insert(
      row('resume', {
        payload: { command: { method: 'resume', params: {} } },
        createdAt: 1,
      }),
    )
    const fake = fakeRegistry()
    await scheduler(repo, fake.registry, () => now).tick()
    expect(repo.get('every')).toMatchObject({ status: 'waiting', delayUntil: 70_000 })
    expect(repo.get('resume')).toMatchObject({ status: 'completed', result: { reason: 'resumed' } })
    expect(fake.calls.map((call) => call.kind)).toContain('resume')
  })

  it('reclaims stale leases, emits routed dead notices, and reports doctor signals', async () => {
    let now = 0
    const repo = new JobsRepo(sqliteTables().table('jobs'), () => now)
    repo.insert(row('dead', { stalledCounter: 5 }))
    repo.claimDue(now, 'old-owner', 10, 1)
    for (let index = 0; index < 11; index++) repo.insert(row(`w${index}`, { createdAt: index + 1 }))
    now = 2 * 3_600_000
    const emit = vi.fn()
    const instance = scheduler(repo, fakeRegistry().registry, () => now, emit)
    const result = await instance.tick()
    expect(result.dead).toBe(1)
    expect(emit).toHaveBeenCalledWith('job_dead', {
      sessionId: 'k',
      detail: { jobId: 'dead', reason: 'stalled' },
    })

    for (let index = 0; index < 11; index++)
      repo.insert(row(`later${index}`, { sessionKey: 'deep', delayUntil: now + 1, createdAt: now + index }))
    repo.insert(row('old-active', { sessionKey: 'old', createdAt: now + 20 }))
    repo.claimDue(now, 'owner', 10_000_000, 1)
    now += 2 * 3_600_000
    expect(instance.doctor()).toEqual({
      stalledForever: ['old-active'],
      waitingDepth: [{ sessionKey: 'deep', depth: 11 }],
    })
  })
})
