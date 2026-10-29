import type { ExtensionActivationBarrier } from '@agnes/host-extensions/ext-host/activation-barrier'
import type { Actor, ContentBlock } from '@agnes/protocol'
import type { NoticeSink } from '../local/notice.js'
import type { SessionPrincipalOwnership } from '../storage/session-ownership.js'
import type { WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import { dispatchMarkOf, type JobRow, type JobsRepo } from './repo.js'
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
  boundWake?: (job: JobRow, signal: AbortSignal) => Promise<{ reason: string; seq?: number }>
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
  onDispatched?(job: JobRow, info: { at: number; seq?: number; reason?: string; sessionKey: string }): void
  keepWaiting?(job: JobRow): boolean
  unattendedApproval?(job: JobRow): 'notify' | 'refuse'
  onSettled?(
    job: JobRow,
    info: { at: number; nextRunAt: number | null; status: 'completed' | 'waiting'; reason?: string },
  ): void
  /**
   * Resolves the session a job runs in before it is opened. A job whose row names a placeholder (a
   * scheduled task that opens a new session per run) gets a fresh session here; others return
   * undefined and run in their own session. It calls `dispatching` just before it opens a session,
   * so an interrupted attempt is known to have possibly run.
   */
  prepare?(
    job: JobRow,
    signal: AbortSignal,
    dispatching: () => void,
  ): Promise<{ sessionKey: string } | undefined>
  /**
   * False when a failed attempt must not be retried, e.g. one that may already have opened a session.
   * An attempt interrupted by a shutdown or crash after it was dispatched is not run again either.
   */
  retryable?(job: JobRow): boolean
  /** A final failure; `sessionKey` is the session the attempt used, when it got that far. */
  onFailed?(job: JobRow, info: { at: number; error: string; sessionKey?: string }): void
  /** True when a repeating job should continue to its next occurrence after a final failure. */
  recurAfterFailure?(job: JobRow): boolean
}

/** An error that carries the session a failed attempt had already opened. */
class AttemptFailed extends Error {
  constructor(
    message: string,
    readonly sessionKey: string | undefined,
  ) {
    super(message)
  }
}

/**
 * The session an attempt used, when it got that far. `prepare` may open a session and then fail
 * before returning it (naming or setting the model of a new session); it says so with `sessionKey`.
 */
function attemptSession(error: unknown): string | undefined {
  if (error instanceof AttemptFailed) return error.sessionKey
  const key =
    error && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'sessionKey')?.value
      : undefined
  return typeof key === 'string' && key ? key : undefined
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly aborts = new Map<string, AbortController>()
  private readonly active = new Map<string, Promise<void>>()
  private ticking: Promise<unknown> = Promise.resolve()
  private accepting = true

  constructor(private readonly options: SchedulerOptions) {}

  start(): void {
    if (this.timer || !this.accepting) return
    this.timer = setInterval(() => {
      this.ticking = this.ticking
        .then(() => (this.accepting ? this.tick(false) : undefined))
        .catch((error: unknown) => this.options.log?.(String(error)))
    }, this.options.limits.tickMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopIntake()
    this.abortActive()
    await this.ticking
    await Promise.allSettled(this.active.values())
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

  /** Manual ticks wait for their batch; background polling only admits work into the shared bound. */
  async tick(waitForCompletion = true): Promise<{ claimed: number; requeued: number; dead: number }> {
    if (!this.accepting) return { claimed: 0, requeued: 0, dead: 0 }
    const now = this.options.clock()
    const reclaimed = this.options.repo.reclaimStalled(
      now,
      this.options.limits.maxStalled,
      new Set(this.active.keys()),
      {
        retryable: (job) => this.options.retryable?.(job) !== false,
        owner: this.options.owner,
        lockMs: this.options.limits.lockMs,
      },
    )
    // The previous owner stopped mid-attempt after the job's first side effect. Running it again
    // could open a second session or send the prompt twice, so the attempt ends as interrupted.
    for (const job of reclaimed.interrupted) {
      this.options.log?.(`job ${job.idempotencyKey} was interrupted after dispatch; not retrying`)
      this.settleFinalFailure(job, 'interrupted', job.attempts + 1, dispatchMarkOf(job)?.sessionKey)
    }
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
    const claimed = this.options.repo.claimDue(
      now,
      this.options.owner,
      this.options.limits.lockMs,
      16 - this.active.size,
    )
    const pending = claimed.map((job) => {
      // Register before dispatch: callbacks may synchronously stop intake or enter another tick.
      const work = Promise.resolve()
        .then(() => this.dispatch(job))
        .finally(() => {
          this.active.delete(job.idempotencyKey)
        })
      this.active.set(job.idempotencyKey, work)
      // Background dispatch must always observe failures; manual callers still receive rejection.
      if (!waitForCompletion) void work.catch((error: unknown) => this.options.log?.(String(error)))
      return work
    })
    if (waitForCompletion) await Promise.all(pending)
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
        this.settleFailure(job, error instanceof Error ? error.message : String(error), attemptSession(error))
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
    if ('pluginNotification' in job.payload) {
      if (!this.options.boundWake) return { reason: 'refused' }
      return this.options.boundWake(job, signal)
    }
    const prepared = await this.options.prepare?.(job, signal, () => this.markDispatched(job))
    const sessionKey = prepared?.sessionKey ?? job.sessionKey
    try {
      return await this.runIn(job, sessionKey, signal)
    } catch (error) {
      if (!prepared) throw error
      throw new AttemptFailed(error instanceof Error ? error.message : String(error), sessionKey)
    }
  }

  private async runIn(
    job: JobRow,
    sessionKey: string,
    signal: AbortSignal,
  ): Promise<{ seq?: number; reason?: string }> {
    signal.throwIfAborted()
    if (!this.options.ownership.resolve(sessionKey))
      throw new Error(`session owner unavailable for ${sessionKey}`)
    const existing = this.options.registry.get(sessionKey)
    const binding = await this.options.workspaces.restoreBinding(sessionKey)
    const cwd = existing?.session.cwd ?? binding.canonicalRoot
    const entry = await this.options.registry.open({
      key: sessionKey,
      cwd,
      binding,
    })
    signal.throwIfAborted()
    this.markDispatched(job, sessionKey)
    if ('command' in job.payload && typeof job.payload.command === 'object') {
      if (job.budget !== undefined) throw new Error('a command job cannot carry a turn budget')
      if (job.payload.command.method !== 'resume') {
        throw new Error(`unsupported job command ${job.payload.command.method}`)
      }
      if (!entry.session.resume) throw new Error('session does not support resume')
      await entry.session.resume()
      signal.throwIfAborted()
      this.dispatched(job, { reason: 'resumed', sessionKey })
      return { reason: 'resumed' }
    }
    if (!('prompt' in job.payload)) throw new Error(`unsupported job payload ${job.idempotencyKey}`)

    const unattendedApproval = this.options.unattendedApproval?.(job) ?? 'notify'
    const actor = {
      id: `job:${job.idempotencyKey}`,
      org: 'local',
      role: 'system',
      deptPath: [],
      // `refuse` declares that nobody will answer this run, so its turn is unattended as well and
      // offers no tool that waits on a person. `notify` hands decisions to the owner, who answers
      // later in the Web or a bound channel, so that turn stays attended.
      attrs: {
        unattendedApproval,
        ...(unattendedApproval === 'refuse' ? { interaction: 'unattended' } : {}),
      },
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
        origin: 'system',
        kind: steer ? 'steer' : 'follow_up',
        ...(job.budget !== undefined ? { budget: job.budget } : {}),
      })
      signal.throwIfAborted()
      this.dispatched(job, { seq, sessionKey })
      return { seq }
    }
    // Unlike ACP, scheduled prompts do not have a client prompt id. Keep the worker's separate
    // activity lease across its first enqueue → run await without changing ACP's `inflight` state.
    const releaseActivity = entry.session.beginActivity?.()
    try {
      const seq = await entry.session.enqueue('next-turn', {
        content,
        actor,
        origin: 'system',
        kind: 'prompt',
        ...(job.budget !== undefined ? { budget: job.budget } : {}),
      })
      signal.throwIfAborted()
      this.dispatched(job, { seq, reason: 'prompt', sessionKey })
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

  private markDispatched(job: JobRow, sessionKey?: string): void {
    this.options.repo.markDispatched(job.idempotencyKey, this.options.owner, {
      at: this.options.clock(),
      ...(sessionKey ? { sessionKey } : {}),
    })
  }

  private dispatched(job: JobRow, info: { seq?: number; reason?: string; sessionKey: string }): void {
    this.options.onDispatched?.(job, { at: this.options.clock(), ...info })
  }

  private settleSuccess(job: JobRow, result: { seq?: number; reason?: string }): void {
    const blocked = this.options.keepWaiting?.(job) === false
    const next = blocked
      ? null
      : nextAfterCompletion(job.schedule, this.options.clock(), {
          ...(this.options.random ? { random: this.options.random } : {}),
        })
    const status = next === null ? 'completed' : 'waiting'
    this.options.repo.settle(
      job.idempotencyKey,
      next === null ? { status, result } : { status, result, delayUntil: next },
    )
    this.options.onSettled?.(job, {
      at: this.options.clock(),
      nextRunAt: next,
      status,
      ...(result.reason ? { reason: result.reason } : {}),
    })
  }

  private settleFailure(job: JobRow, error: string, sessionKey?: string): void {
    const attempts = job.attempts + 1
    if (attempts >= job.maxAttempts || this.options.retryable?.(job) === false) {
      this.settleFinalFailure(job, error, attempts, sessionKey)
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

  private settleFinalFailure(job: JobRow, error: string, attempts: number, sessionKey?: string): void {
    const at = this.options.clock()
    this.options.onFailed?.(job, { at, error, ...(sessionKey ? { sessionKey } : {}) })
    const next =
      this.options.recurAfterFailure?.(job) === true
        ? nextAfterCompletion(job.schedule, at, {
            ...(this.options.random ? { random: this.options.random } : {}),
          })
        : null
    if (next === null) {
      this.options.repo.settle(job.idempotencyKey, { status: 'failed', error, attempts })
      if (this.options.onFailed) this.options.onSettled?.(job, { at, nextRunAt: null, status: 'completed' })
      return
    }
    // A failed occurrence does not end a repeating task: the next one starts with fresh attempts.
    this.options.repo.settle(job.idempotencyKey, {
      status: 'waiting',
      error,
      attempts: 0,
      delayUntil: next,
    })
    this.options.onSettled?.(job, { at, nextRunAt: next, status: 'waiting' })
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
