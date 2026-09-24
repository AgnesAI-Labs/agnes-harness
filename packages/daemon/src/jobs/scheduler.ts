import type { ExtensionActivationBarrier } from '@agnes/host'
import type { Actor, ContentBlock } from '@agnes/protocol'
import type { NoticeSink } from '../local/notice.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import type { JobRow, JobsRepo } from './repo.js'
import { nextAfterCompletion } from './schedule.js'

type SchedulerEntry = {
  key: string
  inflight: unknown | null
  session: {
    cwd?: string
    enqueue(target: 'next-turn' | 'next-step', message: unknown): Promise<number>
    run(options: {
      until: 'turn-end'
      signal: AbortSignal
    }): Promise<{ reason: string; lastSeq: number; error?: unknown }>
    /** Supervisor workers use this across scheduler enqueue → run; local sessions need no lease. */
    beginActivity?(): () => void
    resume?(): Promise<unknown>
  }
}

export type SchedulerRegistry = {
  open(options: { key?: string; cwd: string; binding?: WorkspaceBindingEnvelope }): Promise<SchedulerEntry>
  get(key: string): SchedulerEntry | undefined
  keys(): string[]
}

type SchedulerOptions = {
  repo: JobsRepo
  registry: SchedulerRegistry
  notices: Pick<NoticeSink, 'emit'>
  clock: () => number
  owner: string
  limits: { tickMs: number; lockMs: number; maxStalled: number }
  workspaces: { restoreBinding(sessionKey: string): Promise<WorkspaceBindingEnvelope> }
  ownership: Pick<SessionPrincipalOwnership, 'resolve'>
  activationBarrier: ExtensionActivationBarrier
  random?: () => number
  log?: (message: string) => void
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly aborts = new Map<string, AbortController>()
  private ticking: Promise<unknown> = Promise.resolve()
  private accepting = true

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer || !this.accepting) return
    this.timer = setInterval(() => {
      this.ticking = this.ticking
        .then(() => (this.accepting ? this.tick() : undefined))
        .catch((error: unknown) => this.options.log?.(String(error)))
    }, this.options.limits.tickMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopIntake()
    this.abortActive()
    await this.ticking
  }

  /** Fence admitted jobs before a surrounding shutdown ladder starts awaiting other drains. */
  abortActive(): void {
    for (const controller of this.aborts.values()) controller.abort()
  }

  /** Stop claiming new jobs without waiting for or aborting work that was already admitted. */
  stopIntake(): void {
    this.accepting = false
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  abort(jobId: string): void {
    this.aborts.get(jobId)?.abort()
  }

  recordResume(sessionKey: string): void {
    const now = this.options.clock()
    this.options.repo.insert({
      idempotencyKey: `resume:${sessionKey}:${now}`,
      sessionKey,
      profileHash: '',
      payload: { command: { method: 'resume', params: {} } },
      schedule: { kind: 'once' },
      status: 'completed',
      attempts: 1,
      maxAttempts: 1,
      backoffMs: 0,
      delayUntil: now,
      stalledCounter: 0,
      protected: true,
      result: { reason: 'reclaimed' },
      createdAt: now,
      updatedAt: now,
    })
  }

  async tick(): Promise<{ claimed: number; requeued: number; dead: number }> {
    if (!this.accepting) return { claimed: 0, requeued: 0, dead: 0 }
    const now = this.options.clock()
    const reclaimed = this.options.repo.reclaimStalled(now, this.options.limits.maxStalled)
    for (const jobId of reclaimed.dead) {
      const job = this.options.repo.get(jobId)
      this.options.notices.emit('job_dead', {
        ...(job ? { sessionId: job.sessionKey } : {}),
        detail: { jobId, reason: 'stalled' },
      })
    }
    if (!this.accepting)
      return { claimed: 0, requeued: reclaimed.requeued.length, dead: reclaimed.dead.length }
    this.options.repo.promoteDelayed(now)
    if (!this.accepting)
      return { claimed: 0, requeued: reclaimed.requeued.length, dead: reclaimed.dead.length }
    const claimed = this.options.repo.claimDue(now, this.options.owner, this.options.limits.lockMs, 16)
    await Promise.all(claimed.map((job) => this.dispatch(job)))
    return { claimed: claimed.length, requeued: reclaimed.requeued.length, dead: reclaimed.dead.length }
  }

  private async dispatch(job: JobRow): Promise<void> {
    // `claimDue` returns a batch. Shutdown can begin while an earlier item in that batch is being
    // dispatched, so a later item must remain leased for the next owner rather than starting work.
    if (!this.accepting) return
    this.options.notices.emit('job_dispatched', {
      sessionId: job.sessionKey,
      detail: { jobId: job.idempotencyKey, sessionKey: job.sessionKey },
    })
    const controller = new AbortController()
    this.aborts.set(job.idempotencyKey, controller)
    if (!this.accepting) controller.abort()
    const heartbeat = setInterval(() => {
      if (!controller.signal.aborted)
        this.options.repo.heartbeat(job.idempotencyKey, this.options.owner, this.options.clock())
    }, 10_000)
    heartbeat.unref()
    try {
      const outcome = await this.execute(job, controller.signal)
      if (!controller.signal.aborted || this.accepting) this.settleSuccess(job, outcome)
    } catch (error) {
      // A shutdown abort deliberately leaves the active lease to expire and be reclaimed by the
      // next daemon owner. Settling from a late dispatch continuation could otherwise cross the
      // owner-lock release boundary and overwrite state owned by the replacement daemon.
      if (!controller.signal.aborted || this.accepting)
        this.settleFailure(job, error instanceof Error ? error.message : String(error))
    } finally {
      clearInterval(heartbeat)
      this.aborts.delete(job.idempotencyKey)
    }
  }

  private async execute(job: JobRow, signal: AbortSignal): Promise<{ seq?: number; reason?: string }> {
    const queued = this.options.activationBarrier.enqueue('turn')
    try {
      const invocation = await queued.start()
      return await invocation.run(() => this.executeAdmitted(job, signal))
    } finally {
      queued.cancel()
    }
  }

  private async executeAdmitted(
    job: JobRow,
    signal: AbortSignal,
  ): Promise<{ seq?: number; reason?: string }> {
    signal.throwIfAborted()
    if (!this.options.ownership.resolve(job.sessionKey))
      throw new Error(`session owner unavailable for ${job.sessionKey}`)
    const existing = this.options.registry.get(job.sessionKey)
    const binding = await this.options.workspaces.restoreBinding(job.sessionKey)
    const cwd = existing?.session.cwd ?? binding.canonicalRoot
    const entry = await this.options.registry.open({
      key: job.sessionKey,
      cwd,
      binding,
    })
    signal.throwIfAborted()
    if ('command' in job.payload && typeof job.payload.command === 'object') {
      if (job.budget !== undefined) throw new Error('a command job cannot carry a turn budget')
      if (job.payload.command.method !== 'resume') {
        throw new Error(`unsupported job command ${job.payload.command.method}`)
      }
      if (!entry.session.resume) throw new Error('session does not support resume')
      await entry.session.resume()
      signal.throwIfAborted()
      return { reason: 'resumed' }
    }
    if (!('prompt' in job.payload)) throw new Error(`unsupported job payload ${job.idempotencyKey}`)

    const actor = {
      id: `job:${job.idempotencyKey}`,
      org: 'local',
      role: 'system',
      deptPath: [],
      attrs: {},
    } satisfies Actor
    const content: ContentBlock[] =
      typeof job.payload.prompt === 'string'
        ? [{ type: 'text', text: job.payload.prompt }]
        : job.payload.prompt
    if (entry.inflight) {
      const steer = job.payload.delivery === 'steer'
      if (steer && job.budget !== undefined)
        throw new Error('a budgeted job cannot steer a turn that has already started')
      const seq = await entry.session.enqueue(steer ? 'next-step' : 'next-turn', {
        content,
        actor,
        kind: steer ? 'steer' : 'follow_up',
        ...(job.budget !== undefined ? { budget: job.budget } : {}),
      })
      signal.throwIfAborted()
      return { seq }
    }
    // Unlike ACP, scheduled prompts do not have a client prompt id. Keep the worker's separate
    // activity lease across its first enqueue → run await without changing ACP's `inflight` state.
    const releaseActivity = entry.session.beginActivity?.()
    try {
      const seq = await entry.session.enqueue('next-turn', {
        content,
        actor,
        kind: 'prompt',
        ...(job.budget !== undefined ? { budget: job.budget } : {}),
      })
      signal.throwIfAborted()
      const outcome = await entry.session.run({ until: 'turn-end', signal })
      signal.throwIfAborted()
      if (outcome.reason === 'error') {
        const detail = outcome.error as { message?: unknown } | undefined
        throw new Error(typeof detail?.message === 'string' ? detail.message : 'turn error')
      }
      return { seq: outcome.lastSeq || seq, reason: outcome.reason }
    } finally {
      releaseActivity?.()
    }
  }

  private settleSuccess(job: JobRow, result: { seq?: number; reason?: string }): void {
    const next = nextAfterCompletion(job.schedule, this.options.clock(), {
      ...(this.options.random ? { random: this.options.random } : {}),
    })
    this.options.repo.settle(
      job.idempotencyKey,
      next === null ? { status: 'completed', result } : { status: 'waiting', result, delayUntil: next },
    )
  }

  private settleFailure(job: JobRow, error: string): void {
    const attempts = job.attempts + 1
    if (attempts >= job.maxAttempts) {
      this.options.repo.settle(job.idempotencyKey, { status: 'failed', error, attempts })
      return
    }
    const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)()
    this.options.repo.settle(job.idempotencyKey, {
      status: 'delayed',
      error,
      attempts,
      delayUntil: this.options.clock() + Math.round(job.backoffMs * 2 ** job.attempts * jitter),
    })
  }

  doctor(): { stalledForever: string[]; waitingDepth: Array<{ sessionKey: string; depth: number }> } {
    const now = this.options.clock()
    return {
      stalledForever: this.options.repo
        .activeSince()
        .filter((active) => now - active.since > 3_600_000)
        .map((active) => active.key),
      waitingDepth: this.options.repo.waitingDepth(10),
    }
  }
}
