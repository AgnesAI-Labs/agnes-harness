import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Duplex, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type { ResolvedProfile } from '@agnes/host'
import {
  type EventEnvelope,
  type McpStatus,
  rpcError,
  type WorkerGeneration,
  workerGeneration,
} from '@agnes/protocol'
import {
  type ResourceWorkerAcquireOptions,
  type ResourceWorkerBootstrapConfiguration,
  type ResourceWorkerReport,
  resourceWorkerEnvironment,
  resourceWorkerObservation,
} from '@agnes/resource-control-daemon'
import { windowsProcessStartTimeSync } from '@agnes/system-node'
import type { CompositeRuntimeDelivery, RuntimeBootDelivery } from '../composite-runtime-delivery.js'
import type { DaemonConfig } from '../config.js'
import type { PreviewUpdate } from '../registry.js'
import { assertWorkspaceBindingEnvelope, type WorkspaceBindingEnvelope } from '../storage/workspaces.js'
import type { RequestFrame } from './frames.js'
import { WorkerLink, type WorkerSessionChannel } from './worker-link.js'

/**
 * The narrow shape this pool needs from daemon's notice sink. The real `NoticeSink` is
 * `local/notice.ts`, daemon Task 12 ([I6]) - not built yet at the time this file was written.
 * Once it lands it satisfies this structurally (it is at minimum an `emit(kind, info)` method), so
 * nothing here needs to change; this is a standalone local type, not an import of a missing module.
 */
export type NoticeEmitter = { emit(kind: string, info?: { sessionId?: string; detail?: unknown }): void }

/** Immutable worker inputs selected when a session is first acquired. */
export type WorkerProfile = Readonly<{ profile: ResolvedProfile; profileFile: string }>
type SessionWorkerAcquireOptions = Readonly<{
  resume?: boolean
  cwd?: string
  binding?: WorkspaceBindingEnvelope
  preset?: string
  parent?: { key: string; boundarySeq: number }
}>

type ResourceControlWorkerAcquireOptions = ResourceWorkerAcquireOptions &
  SessionWorkerAcquireOptions &
  Readonly<{
    kind: 'service'
    resourceControl: true
  }>

type WorkerAcquireOptions =
  | (SessionWorkerAcquireOptions & Readonly<{ kind?: 'session'; resourceControl?: false }>)
  | ResourceControlWorkerAcquireOptions

// `| undefined` spelled out on the optional fields, not just `?:`: with `exactOptionalPropertyTypes`
// a bare `?:` field forbids ever assigning `undefined` to it (only omitting it), and `link`/`starting`
// are explicitly set back to `undefined` below once a worker exits or finishes starting.
type Slot = {
  link?: WorkerLink | undefined
  /** Adopted socket currently passing the private initializer, before it becomes publicly live. */
  initializingLink?: WorkerLink | undefined
  child?: ChildProcess
  token: string
  sessionKey: string
  /** Business sessions currently multiplexed through this process. */
  sessions: Set<string>
  channels: Map<string, WorkerSessionChannel>
  generation: WorkerGeneration
  /** Resource lifecycle workers have no Host and cannot receive extension activation commands. */
  resourceControl: boolean
  lastUsed: number
  starting?: Promise<WorkerLink> | undefined
  failStarting?: ((error: Error) => void) | undefined
  startupTimer?: ReturnType<typeof setTimeout> | undefined
  /** Settles after process exit recovery has classified this generation's durable turn. */
  exitRecovery?: Promise<void> | undefined
  /** Intentional idle/shutdown retirement must not count toward the crash quarantine breaker. */
  intentionalExit?: boolean
}

/**
 * One `@shared` Host-bearing process plus isolated resource-control processes. A
 * spawned worker connects back on `workersSocketPath`, announces itself with a `hello` bearing the
 * token this pool minted for it, then waits on fd 3 for the start gate this pool writes once the
 * token is matched and the profile hash checked - see worker/main.ts for the other half of that
 * handshake. `crashed()` runs a 5-minute-window / 3-strikes breaker with capped exponential backoff
 * between strikes, matching the daemon spec's §5.2 crash policy.
 */
export class WorkerPool {
  private readonly slots = new Map<string, Slot>()
  private readonly pendingByToken = new Map<string, (link: WorkerLink) => void>()
  private readonly crashes = new Map<string, number[]>()
  private readonly quarantined = new Set<string>()
  private readonly backoffUntil = new Map<string, number>()
  private stopping = false
  private nextGeneration = 1
  private activationOperation: string | undefined
  private initializeLink:
    | ((input: { sessionKey: string; generation: WorkerGeneration; link: WorkerLink }) => Promise<void>)
    | undefined
  private workerExit:
    | ((input: { sessionKey: string; generation: WorkerGeneration }) => void | Promise<void>)
    | undefined

  constructor(
    private readonly o: {
      config: DaemonConfig
      profile: ResolvedProfile
      profileFile: string
      /** Daemon-authored resource inputs copied privately to new worker generations. */
      resourceBootstrap?: ResourceWorkerBootstrapConfiguration
      spawn?: typeof nodeSpawn
      execPath?: string
      execArgv?: string[]
      workerEntry?: string
      clock: () => number
      onEvent: (sessionKey: string, e: EventEnvelope) => void | Promise<void>
      /** Live streamed text, only from the worker that currently hosts the session. */
      onPreview?: (sessionKey: string, update: PreviewUpdate) => void
      /** Safe live resource observations are fenced by the resource adapter's active worker key. */
      onResourceStatus?: (input: { sessionKey: string; serverId: string; status: McpStatus }) => void
      onRequest: (sessionKey: string, f: RequestFrame) => Promise<unknown>
      onLog?: (input: {
        sessionKey: string
        level: 'debug' | 'info' | 'warn' | 'error'
        message: string
      }) => void
      onSessionFailure?: (sessionKey: string, error: unknown) => void
      runtimeDelivery?: CompositeRuntimeDelivery
      notices: NoticeEmitter
      /** Called synchronously before a worker is accepted. A rejected observer rejects the candidate. */
      onResources?: (input: {
        sessionKey: string
        workerKind: 'session' | 'service'
        report: ResourceWorkerReport
      }) => Promise<void> | void
    },
  ) {}

  /** `workers.sock`'s connection handler: a worker connects before this pool knows which acquire()
   *  it belongs to, so it is claimed by the token its `hello` carries. `key` is captured off that
   *  same `hello`, not off the first `event` frame - an `onRequest` (permission ask) can in
   *  principle arrive before any event has been tailed, and routing it with an empty session key
   *  would misroute it. */
  adopt(socket: Duplex): void {
    let workerKey = ''
    let generation = 0
    const link = new WorkerLink(socket, {
      onEvent: (k, e) => this.o.onEvent(k, e),
      onPreview: (k, update) => {
        if (this.hosts(link, k)) this.o.onPreview?.(k, update)
      },
      onResourceStatus: (serverId, status) =>
        this.o.onResourceStatus?.({ sessionKey: workerKey, serverId, status }),
      onRequest: (f) => this.o.onRequest(f.sessionKey, f),
      onLog: (sessionKey, level, message) => this.o.onLog?.({ sessionKey, level, message }),
      onActivity: (sessionKey) => this.touch(sessionKey),
      onSessionFailure: (sessionKey, error) => {
        this.o.notices.emit('session_interrupted', { sessionId: sessionKey })
        this.retire([sessionKey], 'session-projection-failed')
        this.o.onSessionFailure?.(sessionKey, error)
      },
      onRuntimeFrame: (frame) => {
        this.o.runtimeDelivery?.handleWorkerFrame(generation, frame)
      },
    })
    void link.hello.then(async (h) => {
      generation = workerGeneration(h.workerGeneration)
      workerKey = h.workerKey
      const claim = this.pendingByToken.get(h.token)
      if (!claim) {
        link.close('unknown token')
        return
      }
      this.pendingByToken.delete(h.token)
      if (h.resources) {
        const observation = resourceWorkerObservation(h)
        if (!observation) {
          link.close('invalid resource bootstrap report')
          return
        }
        try {
          await this.o.onResources?.({
            sessionKey: h.workerKey,
            ...observation,
          })
        } catch {
          link.close('resource bootstrap observation rejected')
          return
        }
      }
      claim(link)
    })
  }

  async acquire(
    sessionKey: string,
    opts?: SessionWorkerAcquireOptions & { kind?: 'session'; resourceControl?: false },
  ): Promise<WorkerSessionChannel>
  async acquire(sessionKey: string, opts: ResourceControlWorkerAcquireOptions): Promise<WorkerLink>
  async acquire(
    sessionKey: string,
    opts: WorkerAcquireOptions = {},
  ): Promise<WorkerLink | WorkerSessionChannel> {
    if (opts.kind === 'service') {
      if (opts.resourceControl !== true)
        throw new Error('service workers are reserved for resource-control helpers')
      if (sessionKey === '@shared')
        throw new Error('resource-control helpers cannot use the shared business worker key')
      return this.acquireWorker(sessionKey, opts)
    }
    assertWorkspaceBindingEnvelope(opts.binding)
    const link = await this.acquireWorker('@shared', { ...opts, kind: 'session' })
    const slot = this.slots.get('@shared')
    if (!slot) throw new Error('shared worker slot disappeared')
    const existing = slot.channels.get(sessionKey)
    if (existing?.alive) return existing
    let channel: WorkerSessionChannel
    channel = link.session(
      sessionKey,
      {
        binding: opts.binding,
        ...(opts.preset ? { preset: opts.preset } : {}),
        ...(opts.resume ? { resume: true } : {}),
        ...(opts.parent ? { parent: opts.parent } : {}),
      },
      () => {
        if (slot.channels.get(sessionKey) !== channel) return
        slot.channels.delete(sessionKey)
        slot.sessions.delete(sessionKey)
      },
    )
    slot.channels.set(sessionKey, channel)
    try {
      await channel.hello
      slot.sessions.add(sessionKey)
      return channel
    } catch (error) {
      if (slot.channels.get(sessionKey) === channel) slot.channels.delete(sessionKey)
      throw error
    }
  }

  private async acquireWorker(workerKey: string, opts: WorkerAcquireOptions): Promise<WorkerLink> {
    const assertAdmission = (): void => {
      if (this.stopping) throw new Error('worker pool is shutting down')
      if (this.activationOperation)
        throw rpcError('OVERLOADED', {
          retryAfterMs: 1000,
          reason: 'activation-in-progress',
          operationId: this.activationOperation,
        })
      if (this.quarantined.has(workerKey)) throw new Error(`worker ${workerKey} is quarantined`)
    }
    assertAdmission()
    const cur = this.slots.get(workerKey)
    const requestedResourceControl = opts.resourceControl === true
    if ((cur?.link?.alive || cur?.starting) && cur.resourceControl !== requestedResourceControl)
      throw new Error(`worker ${workerKey} already exists with a different worker kind`)
    if (cur?.link?.alive) {
      cur.lastUsed = this.o.clock()
      return cur.link
    }
    if (cur?.starting) return cur.starting
    if (cur?.child?.exitCode === null && cur.child.signalCode === null) {
      await new Promise<void>((resolve) => cur.child?.once('exit', () => resolve()))
      await cur.exitRecovery
      return this.acquireWorker(workerKey, opts)
    }
    if (cur?.exitRecovery) {
      await cur.exitRecovery
      if (this.slots.get(workerKey) === cur) this.slots.delete(workerKey)
      return this.acquireWorker(workerKey, opts)
    }
    const until = this.backoffUntil.get(workerKey) ?? 0
    if (until > this.o.clock()) await new Promise((r) => setTimeout(r, until - this.o.clock()))
    assertAdmission()
    // Another caller may have already (re)inserted a live or starting slot for this worker key
    // while this call was backing off. Fall back onto that slot instead of spawning a second
    // process and silently overwriting it (a slot left behind by a startup failure that never
    // reached `link`/`starting` is still fair game to retry over, same as the checks above).
    const raced = this.slots.get(workerKey)
    if (raced?.link?.alive || raced?.starting) return this.acquireWorker(workerKey, opts)
    const selected = { profile: this.o.profile, profileFile: this.o.profileFile }
    // Activation may have frozen membership while admission was in progress; re-check before
    // inserting the slot so waitForStarting cannot miss a late old-revision worker.
    assertAdmission()
    const live = [...this.slots.values()].filter((s) => s.link?.alive).length
    if (live >= this.o.config.limits.maxWorkers) throw rpcError('OVERLOADED', { retryAfterMs: 1000 })

    const token = randomBytes(32).toString('hex')
    const generation = workerGeneration(this.nextGeneration)
    this.nextGeneration = generation + 1
    const slot: Slot = {
      token,
      sessionKey: workerKey,
      sessions: new Set(),
      channels: new Map(),
      generation,
      resourceControl: opts.resourceControl === true,
      lastUsed: this.o.clock(),
    }
    slot.starting = new Promise<WorkerLink>((resolve, reject) => {
      let child: ChildProcess | undefined
      let startupFinished = false
      // Set from the moment a runtime target is offered until the worker proves it can run it.
      let bootOffer: RuntimeBootDelivery | undefined
      const failStarting = (error: Error): void => {
        if (startupFinished) return
        startupFinished = true
        // A start that dies on the very target it was given says something about that target, not
        // about the worker; only then is the exit expected rather than a crash to count.
        if (bootOffer && this.o.runtimeDelivery?.recordBootFailure(slot.generation, bootOffer, error))
          slot.intentionalExit = true
        bootOffer = undefined
        this.pendingByToken.delete(token)
        slot.initializingLink?.close('worker startup failed')
        slot.initializingLink = undefined
        if (slot.startupTimer !== undefined) clearTimeout(slot.startupTimer)
        slot.startupTimer = undefined
        if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        reject(error)
      }
      slot.failStarting = failStarting
      const timer = setTimeout(() => {
        failStarting(
          new Error(`worker ${workerKey} did not hello within ${this.o.config.limits.workerStartupMs} ms`),
        )
      }, this.o.config.limits.workerStartupMs)
      slot.startupTimer = timer
      this.pendingByToken.set(token, (link) => {
        if (startupFinished) {
          link.close('startup already failed')
          return
        }
        clearTimeout(timer)
        slot.startupTimer = undefined
        slot.initializingLink = link
        void link.hello.then(async (h) => {
          if (startupFinished) {
            link.close('startup already failed')
            return
          }
          if (h.profileHash !== selected.profile.hash) {
            link.close('profile hash mismatch')
            failStarting(new Error('profile hash mismatch'))
            return
          }
          if (h.workerGeneration !== slot.generation) {
            link.close('worker generation mismatch')
            failStarting(new Error('worker generation mismatch'))
            return
          }
          if (h.workerKey !== workerKey) {
            link.close('worker key mismatch')
            failStarting(new Error('worker key mismatch'))
            return
          }
          if (h.workerKind !== (opts.kind ?? 'session')) {
            link.close('worker kind mismatch')
            failStarting(new Error('worker kind mismatch'))
            return
          }
          try {
            await this.initializeLink?.({ sessionKey: workerKey, generation: slot.generation, link })
          } catch (error) {
            link.close('worker activation initialization failed')
            failStarting(
              new Error(
                `worker ${workerKey} activation initialization failed: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
              ),
            )
            return
          }
          const boot =
            workerKey === '@shared' && (opts.kind ?? 'session') === 'session'
              ? this.o.runtimeDelivery?.bootFor(slot.generation)
              : undefined
          if (boot && this.o.runtimeDelivery) {
            const admission = this.o.runtimeDelivery.beginBoot(slot.generation, boot)
            bootOffer = boot
            link.offerRuntimeTarget(boot.artifact)
            const remaining = Math.max(1, this.o.config.limits.workerStartupMs)
            const timeout = new Promise<never>((_, reject) => {
              setTimeout(
                () => reject(new Error(`worker ${workerKey} did not boot_ready within ${remaining} ms`)),
                remaining,
              ).unref()
            })
            try {
              await Promise.race([admission.whenReady(), timeout])
            } catch (error) {
              link.close('runtime boot admission failed')
              failStarting(error instanceof Error ? error : new Error(String(error)))
              return
            }
            if (!admission.ready) {
              link.close('runtime boot admission failed')
              failStarting(new Error(`worker ${workerKey} runtime boot was not admitted`))
              return
            }
            bootOffer = undefined
            const desired = this.o.runtimeDelivery.desired()
            if (desired) link.offerRuntimeTarget(desired)
          }
          // `.end()` right after the write, not left open: worker/main.ts's gate is an
          // `fs.createReadStream` on this pipe's other end, and a raw-fd read stream keeps a read
          // pending until it sees EOF - as long as this side stays open, that pending read outlives
          // `.once('data', ...)`'s listener removal and blocks the worker's own `process.exit()` from
          // ever completing (reverse-verified with a standalone probe: an unclosed gate pipe hangs a
          // real child process's exit indefinitely; closing this end after the write lets it exit
          // immediately). One write is this gate's whole contract, so there is nothing else to send.
          const gate = spawnedChild.stdio[3] as Writable | null | undefined
          gate?.write('start\n')
          gate?.end()
          slot.link = link
          link.onExit(() => {
            if (slot.link === link) slot.link = undefined
            if (!startupFinished) failStarting(new Error(`worker ${workerKey} link closed during startup`))
          })
          if (!link.alive) return
          slot.initializingLink = undefined
          startupFinished = true
          resolve(link)
        })
      })
      try {
        const supervisorStartId = this.o.config.workersSocketPath.startsWith('\\\\.\\pipe\\')
          ? windowsProcessStartTimeSync(process.pid)
          : undefined
        if (supervisorStartId === null) throw new Error('Supervisor process identity unavailable')
        child = (this.o.spawn ?? nodeSpawn)(
          this.o.execPath ?? process.execPath,
          [
            ...(this.o.execArgv ?? []),
            this.o.workerEntry ?? fileURLToPath(new URL('../worker/main.js', import.meta.url)),
          ],
          {
            env: {
              ...process.env,
              ...(this.o.config.home !== undefined ? { AGH_HOME: this.o.config.home } : {}),
              AGNES_WORKER_TOKEN: token,
              AGNES_SUPERVISOR_SOCKET: this.o.config.workersSocketPath,
              AGNES_SUPERVISOR_PID: supervisorStartId ? String(process.pid) : undefined,
              AGNES_SUPERVISOR_START_ID: supervisorStartId,
              AGNES_WORKER_KEY: workerKey,
              AGNES_WORKER_KIND: opts.kind ?? 'session',
              ...(workerKey === '@shared' && (opts.kind ?? 'session') === 'session'
                ? (() => {
                    const boot = this.o.runtimeDelivery?.bootFor(generation)
                    return boot ? { AGNES_RUNTIME_BOOT_SOURCE: boot.source } : {}
                  })()
                : {}),
              ...resourceWorkerEnvironment(opts, this.o.resourceBootstrap),
              AGNES_WORKER_GENERATION: String(generation),
              AGNES_GATE_FD: '3',
              AGNES_PROFILE_FILE: selected.profileFile,
              // The shared business worker multiplexes unrelated workspaces. Explicitly clear an
              // inherited value so its process-wide Host cannot be pinned to the first session cwd.
              AGNES_WORKER_ROOT: opts.kind === 'service' && opts.cwd ? opts.cwd : undefined,
            },
            windowsHide: true,
            stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
          },
        )
      } catch (error) {
        failStarting(
          new Error(
            `worker ${workerKey} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
        return
      }
      if (!child) {
        failStarting(new Error(`worker ${workerKey} failed to spawn: process handle unavailable`))
        return
      }
      const spawnedChild = child
      slot.child = spawnedChild
      spawnedChild.once('error', (error) => {
        if (!slot.link)
          failStarting(
            new Error(
              `worker ${workerKey} failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      })
      // A worker that exits before hello is a bounded startup failure, not a live-worker crash.
      // Reject immediately so callers do not wait for the full startup deadline and remove the
      // token before a late socket connection can claim a failed generation.
      spawnedChild.once('exit', (code, signal) => {
        if (startupFinished) {
          slot.link = undefined
          if (!slot.intentionalExit) this.crashed(workerKey)
          slot.exitRecovery = Promise.resolve()
            .then(async () => {
              const keys = slot.sessions.size > 0 ? [...slot.sessions] : [workerKey]
              await Promise.allSettled(
                keys.map((sessionKey) => this.workerExit?.({ sessionKey, generation: slot.generation })),
              )
            })
            .then(
              () => undefined,
              () => undefined,
            )
          return
        }
        failStarting(
          new Error(
            `worker ${workerKey} exited before hello (${code === null ? 'signal' : `code ${code}`}${signal ? `, ${signal}` : ''})`,
          ),
        )
      })
    }).finally(() => {
      slot.starting = undefined
      slot.failStarting = undefined
      slot.startupTimer = undefined
    })
    this.slots.set(workerKey, slot)
    return slot.starting
  }

  acquireSharedWorker(): Promise<WorkerLink> {
    return this.acquireWorker('@shared', { kind: 'session' })
  }

  /** Whether `link` is the live worker that currently carries `sessionKey`'s channel. */
  private hosts(link: WorkerLink, sessionKey: string): boolean {
    for (const slot of this.slots.values())
      if (slot.link === link && slot.channels.has(sessionKey)) return true
    return false
  }

  /** Compensates a fork whose child was adopted by the shared worker but whose daemon-side open
   *  failed before a registry entry could own its session channel. */
  async closeHostedSession(sessionKey: string, reason: string): Promise<void> {
    const slot = this.slots.get('@shared')
    const channel = slot?.channels.get(sessionKey)
    if (channel) {
      await channel.closeSession(reason)
      return
    }
    if (slot?.link?.alive) await slot.link.closeSession(sessionKey, reason)
  }

  /** Apply a new default for workers acquired after this point. Live links retain their snapshot. */
  reloadProfile(selected: WorkerProfile): void {
    this.o.profile = selected.profile
    this.o.profileFile = selected.profileFile
  }

  /** Update the live shared Host, including a worker that started during preparation. */
  async applyModelProfile(selected: WorkerProfile): Promise<void> {
    for (;;) {
      const slot = this.slots.get('@shared')
      if (slot?.starting) {
        await slot.starting
        continue
      }
      const link = slot?.link
      if (link?.alive) {
        const applied = await link.command('configuration.apply', { profile: selected.profile })
        if (
          !applied ||
          typeof applied !== 'object' ||
          !('profileHash' in applied) ||
          applied.profileHash !== selected.profile.hash
        )
          throw new Error('worker did not confirm the model configuration')
        if (this.slots.get('@shared')?.link !== link || !link.alive) continue
      }
      // No asynchronous gap between checking membership and changing future startup input.
      this.reloadProfile(selected)
      return
    }
  }

  /** Install the active plugin revision before a newly acquired worker is released to callers. */
  setLinkInitializer(
    initialize: (input: {
      sessionKey: string
      generation: WorkerGeneration
      link: WorkerLink
    }) => Promise<void>,
  ): void {
    if (this.initializeLink) throw new Error('worker link initializer is already configured')
    this.initializeLink = initialize
  }

  /** Observe a fully exited worker, after it can no longer execute against a retained revision. */
  setWorkerExitHandler(
    handler: (input: { sessionKey: string; generation: WorkerGeneration }) => void | Promise<void>,
  ): void {
    if (this.workerExit) throw new Error('worker exit handler is already configured')
    this.workerExit = handler
  }

  /** Freeze worker membership for a profile activation publish window. */
  beginActivation(operationId: string): void {
    if (!operationId) throw new Error('activation operation id is required')
    if (this.activationOperation && this.activationOperation !== operationId)
      throw new Error(`worker activation already in progress: ${this.activationOperation}`)
    this.activationOperation = operationId
  }

  endActivation(operationId: string): void {
    if (this.activationOperation !== operationId) throw new Error('worker activation ownership changed')
    this.activationOperation = undefined
  }

  /** After beginActivation prevents new starts, wait for already-admitted handshakes to either
   * become live or fail so the publisher can enumerate a closed worker set. */
  async waitForStarting(): Promise<void> {
    const starting = [...this.slots.values()].flatMap((slot) => (slot.starting ? [slot.starting] : []))
    const settled = await Promise.allSettled(starting)
    const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }

  /** Used by configuration activation to reject a default change while a worker is still live. */
  hasActivity(): boolean {
    return [...this.slots.values()].some((slot) => slot.link?.alive || slot.starting !== undefined)
  }

  /** Resource-control helpers must not block provider setup; only Host-bearing workers do. */
  hasHostActivity(): boolean {
    return [...this.slots.values()].some(
      (slot) => !slot.resourceControl && (slot.link?.alive || slot.starting !== undefined),
    )
  }

  isQuarantined(workerKey: string): boolean {
    return this.quarantined.has(workerKey)
  }

  /** Test-only equivalent of an idle eviction, for the one worker key idle eviction never touches:
   *  forces a live '@shared' link closed so a caller can verify a session recovers against the
   *  replacement the shared-worker keeper spins up. Returns whether a live link was closed. */
  retireSharedWorkerNow(): boolean {
    const slot = this.slots.get('@shared')
    if (!slot?.link?.alive) return false
    slot.intentionalExit = true
    slot.link.close('test-retire')
    return true
  }

  /** 5-minute rolling window, 3 strikes: the third qualifying crash quarantines the session (no more
   *  auto-restarts until an operator intervenes); the first two back off the next `acquire()` with
   *  capped exponential delay (1s, 2s, ... up to 30s) instead of restarting immediately. */
  crashed(sessionKey: string): 'restart' | 'quarantined' {
    const now = this.o.clock()
    const times = [...(this.crashes.get(sessionKey) ?? []).filter((t) => now - t < 5 * 60_000), now]
    this.crashes.set(sessionKey, times)
    // The shared worker is the one business process: quarantining it would stop the daemon doing
    // anything at all. It keeps backing off instead, and the shared-worker keeper retries it.
    if (times.length >= 3 && sessionKey !== '@shared') {
      this.quarantined.add(sessionKey)
      this.o.notices.emit('worker_quarantined', { sessionId: sessionKey, detail: { crashes: times.length } })
      return 'quarantined'
    }
    this.backoffUntil.set(sessionKey, now + Math.min(30_000, 1000 * 2 ** (times.length - 1)))
    this.o.notices.emit('worker_crashed', { sessionId: sessionKey, detail: { crashes: times.length } })
    return 'restart'
  }

  evictIdle(now: number, busy: (sessionKey: string) => boolean): number {
    if (this.activationOperation) return 0
    let n = 0
    for (const [k, s] of this.slots)
      if (
        // Kept up from daemon start for MCP connections and Skill scans, not just for sessions.
        k !== '@shared' &&
        s.link?.alive &&
        [...s.sessions].every((sessionKey) => !busy(sessionKey)) &&
        !busy(k) &&
        now - s.lastUsed > this.o.config.limits.workerIdleEvictMs
      ) {
        s.intentionalExit = true
        s.link.close('idle')
        n++
      }
    return n
  }

  touch(sessionKey: string): void {
    const s = this.slots.get(sessionKey) ?? this.slots.get('@shared')
    if (s) s.lastUsed = this.o.clock()
  }

  links(): Array<{ sessionKey: string; generation: WorkerGeneration; link: WorkerLink }> {
    return [...this.slots.values()]
      .filter((s) => s.link?.alive)
      .map((s) => ({ sessionKey: s.sessionKey, generation: s.generation, link: s.link as WorkerLink }))
  }

  businessWorker(): { workerKey: '@shared'; generation: WorkerGeneration; link: WorkerLink } | undefined {
    const slot = this.slots.get('@shared')
    if (!slot?.link?.alive || slot.resourceControl) return undefined
    return { workerKey: '@shared', generation: slot.generation, link: slot.link }
  }

  retireWorker(reason: string): void {
    const slot = this.slots.get('@shared')
    if (!slot?.link?.alive) return
    slot.intentionalExit = true
    slot.link.close(reason)
  }

  /** Live workers that own a Host and can participate in package extension activation. */
  activationLinks(): Array<{ sessionKey: string; generation: WorkerGeneration; link: WorkerLink }> {
    const shared = this.slots.get('@shared')
    if (!shared?.link?.alive || shared.resourceControl) return []
    return [{ sessionKey: '@shared', generation: shared.generation, link: shared.link }]
  }

  /** Confirm that a dead link's owning process can no longer execute plugin code. */
  async waitForGenerationExit(
    sessionKey: string,
    generation: WorkerGeneration,
    timeoutMs: number,
  ): Promise<boolean> {
    const slot = this.slots.get(sessionKey)
    if (!slot || slot.generation !== generation) return true
    const child = slot.child
    if (!child || child.exitCode !== null || child.signalCode !== null) return true
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onExit = (): void => finish(true)
      const finish = (exited: boolean): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (!exited) child.off('exit', onExit)
        resolve(exited)
      }
      child.once('exit', onExit)
      timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
    })
  }

  /**
   * Retire selected generations after a durable resource snapshot changes. A replacement is always
   * acquired later from the new snapshot; this method never reports a candidate as live before its
   * normal hello/profile gate succeeds. Callers keep an old worker until their own candidate gate
   * has accepted, so this is deliberately a narrow destructive primitive rather than activation.
   */
  retire(sessionKeys: readonly string[], reason = 'resource-snapshot-reload'): void {
    for (const key of sessionKeys) {
      const direct = this.slots.get(key)
      if (direct && key !== '@shared') {
        direct.intentionalExit = true
        direct.link?.close(reason)
        continue
      }
      const slot = this.slots.get('@shared')
      const channel = slot?.channels.get(key)
      if (!slot || !channel) continue
      slot.channels.delete(key)
      slot.sessions.delete(key)
      void channel.closeSession(reason).catch(() => undefined)
    }
  }

  async closeAll(graceMs: number): Promise<void> {
    this.stopping = true
    this.cancelStarting()
    const live = this.links()
    for (const { sessionKey, link } of live) {
      const slot = this.slots.get(sessionKey)
      if (slot) slot.intentionalExit = true
      link.close('shutdown')
    }
    const deadline = Date.now() + graceMs
    while (this.hasLiveChildren() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    if (this.hasLiveChildren()) throw new Error(`workers did not close within ${graceMs} ms`)
    await this.waitForExitRecovery()
  }

  /** Wait until every owned process has exited and its durable generation recovery has settled. */
  async waitForExitRecovery(): Promise<void> {
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        const child = slot.child
        if (child?.exitCode === null && child.signalCode === null)
          await new Promise<void>((resolve) => child.once('exit', () => resolve()))
        // The pool's exit listener is registered before this waiter, so it has assigned
        // exitRecovery by the time the promise above resolves.
        await slot.exitRecovery
      }),
    )
  }

  /** Force-terminates every child still owned by the pool, including one still in startup. */
  killAll(): void {
    this.stopping = true
    this.cancelStarting()
    for (const slot of this.slots.values())
      if (slot.child?.exitCode === null && slot.child.signalCode === null) slot.child.kill('SIGKILL')
  }

  /**
   * Fail closed after an activation decision whose durable outcome cannot be recovered. Every
   * adopted link becomes unusable synchronously, before process-exit delivery can lag behind.
   */
  failStop(reason: string): void {
    this.stopping = true
    this.cancelStarting()
    for (const slot of this.slots.values()) {
      slot.intentionalExit = true
      slot.initializingLink?.close(reason)
      slot.initializingLink = undefined
      slot.link?.close(reason)
      if (slot.child?.exitCode === null && slot.child.signalCode === null) slot.child.kill('SIGKILL')
    }
  }

  private cancelStarting(): void {
    for (const slot of this.slots.values()) {
      if (!slot.starting) continue
      slot.failStarting?.(new Error('worker pool shut down during startup'))
    }
  }

  private hasLiveChildren(): boolean {
    return [...this.slots.values()].some(
      (slot) => slot.child?.exitCode === null && slot.child.signalCode === null,
    )
  }
}
