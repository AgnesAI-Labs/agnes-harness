import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { ProcessOutput, SandboxProcess, SessionChildJobs, ToolContext } from '@agnes/extension-api'
import { SHELL_SENTINEL, SHELL_STDIN_SENTINEL } from '@agnes/extension-api'
import {
  type ChildJobListing,
  collectBoundedJobs,
  type ExtendedChildJobsPort,
  isReadOnlyChildListing,
  pruneReclaimedChildren,
  resolveChildJobsPort,
  type ShellJobView,
  stopChildJob,
  upsertChildProjection,
} from './child-jobs.js'
import { legacyProcess } from './legacy-process.js'
import { OutputCursors, type OutputPosition, outputPosition } from './output-cursor.js'
import { PersistentShell, type PersistentShellName, type ShellName, shellArgv } from './persistent-shell.js'

export type { ShellJobView }
export type ProcessJobContext = Pick<ToolContext, 'session' | 'cwd' | 'signal' | 'fs'> & {
  sandbox: Pick<ToolContext['sandbox'], 'openProcess'> | ToolContext['sandbox']
}
export type JobOwner = Pick<ToolContext, 'session'>
interface Job {
  view: ShellJobView
  /** When the registry took the job on; a read of a running job says how long it has run. */
  startedAt: number
  childIdle?: boolean
  childTerminal?: boolean
  readOnly?: boolean
  /** Last output, input or read; an idle persistent shell or terminal is closed from it. */
  activeAt: number
  capturedBytes: number
  position: OutputPosition
  cleanupPending?: boolean
  done: Promise<ShellJobView>
  /** Settles when the command itself has ended, even while processes it backgrounded still run. */
  foreground: Promise<void>
  finish(code: number | null): void
  endForeground(code: number): void
  stop(): Promise<void>
  refreshChild?: () => Promise<ChildJobListing | undefined>
  /** The child's newest message as last read; a child reports one message, never a stream. */
  childText?: string
}
const MAX_JOBS = 128,
  MAX_OUTPUT = 4 * 1024 * 1024
/**
 * A persistent shell with no command running, or a terminal nobody has written to, read or heard
 * from, is closed after these. Both otherwise keep a process alive for the whole daemon lifetime and
 * stop their session from hibernating. Background commands are never closed this way.
 */
export const SHELL_IDLE_MS = 30 * 60_000
export const TERMINAL_IDLE_MS = 2 * 60 * 60_000
const IDLE_SWEEP_MS = 60_000
/** How long a command's shell may take to exit after reporting its own code. */
const FOREGROUND_SETTLE_MS = 100
const owner = (ctx: JobOwner) => `${ctx.session.key}\0${ctx.session.lane}`
const copy = (job: Job) => ({ ...job.view })

/** One owner-scoped registry for every executable kind. Handles live until session/provider shutdown. */
export class ShellJobs {
  private readonly cursors = new OutputCursors()
  private readonly sessions = new Map<string, Map<string, Job>>()
  /** Direct controllable children, isolated from the 128-slot local process/terminal table. */
  private readonly directChildren = new Map<string, Map<string, Job>>()
  /** Read-only descendant and ambiguous child projections, strictly isolated from kill and completions. */
  private readonly descendants = new Map<string, Map<string, Job>>()
  private readonly processes = new Map<string, SandboxProcess>()
  private readonly shells = new Map<string, PersistentShell>()
  private readonly calls = new Map<string, string>()
  private readonly notifications = new Map<string, ShellJobView[]>()
  /** Per owner, the ended jobs the model has been told about, by a tool result or a notice. */
  private readonly told = new Map<string, Set<string>>()
  private readonly closing = new Set<string>()
  private readonly starting = new Map<string, Set<Promise<SandboxProcess>>>()
  private disposed = false
  private disposal: Promise<void> | undefined
  private sweeper: ReturnType<typeof setInterval> | undefined

  private assertOpen(key: string): void {
    if (this.disposed || this.closing.has(key)) throw new Error('session jobs are closing')
  }
  private mapFor(store: Map<string, Map<string, Job>>, ctx: JobOwner): Map<string, Job> {
    const key = owner(ctx)
    this.assertOpen(key)
    let jobs = store.get(key)
    if (!jobs) {
      jobs = new Map()
      store.set(key, jobs)
    }
    return jobs
  }
  private table(ctx: JobOwner): Map<string, Job> {
    return this.mapFor(this.sessions, ctx)
  }
  private createJob(
    ctx: JobOwner,
    view: ShellJobView,
    stop: () => Promise<void>,
    quiet = false,
    readOnly = false,
  ): Job {
    let resolve!: (view: ShellJobView) => void
    let foreground!: () => void
    const job: Job = {
      view,
      stop,
      ...(readOnly ? { readOnly: true } : {}),
      startedAt: Date.now(),
      activeAt: Date.now(),
      capturedBytes: 0,
      position: outputPosition(),
      done: new Promise((r) => {
        resolve = r
      }),
      foreground: new Promise((r) => {
        foreground = r
      }),
      endForeground: (code) => {
        if (view.foregroundCode === undefined && view.code === null) view.foregroundCode = code
        foreground()
      },
      finish: (code) => {
        if (view.status !== 'running' && view.status !== 'killed') return
        if (view.code !== null) return
        view.code = code ?? -1
        if (view.status !== 'killed') view.status = code === 0 ? 'completed' : 'failed'
        if (!quiet) {
          const queue = this.notifications.get(owner(ctx)) ?? []
          queue.push({ ...view, stdout: '', stderr: '' })
          this.notifications.set(owner(ctx), queue.slice(-128))
        }
        resolve(copy(job))
        foreground()
      },
    }
    return job
  }
  private add(ctx: JobOwner, view: ShellJobView, stop: () => Promise<void>, quiet = false): Job {
    view.ownerSessionId = ctx.session.key
    const jobs = this.table(ctx)
    if (jobs.size >= MAX_JOBS) {
      const old = [...jobs].find(([, job]) => job.view.status !== 'running' && !job.cleanupPending)
      if (!old) throw new Error('session job limit reached; close a running job first')
      jobs.delete(old[0])
      for (const [call, id] of this.calls) if (id === old[0]) this.calls.delete(call)
    }
    const job = this.createJob(ctx, view, stop, quiet)
    jobs.set(view.id, job)
    return job
  }
  private view(kind: ShellJobView['kind'], command: string, cwd: string): ShellJobView {
    return {
      id: randomUUID(),
      owner: 'agent',
      ownerSessionId: '',
      kind,
      command: command.slice(0, 2048),
      cwd,
      status: 'running',
      code: null,
      stdout: '',
      stderr: '',
      truncated: false,
    }
  }
  private append(job: Job, chunk: ProcessOutput) {
    job.activeAt = Date.now()
    const available = Math.max(0, MAX_OUTPUT - job.capturedBytes)
    const bytes = Buffer.from(chunk.text)
    let end = Math.min(available, bytes.length)
    // Do not expose half of a UTF-8 character at the byte limit.
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    job.capturedBytes += end
    job.view[chunk.stream] += bytes.subarray(0, end).toString('utf8')
    if (end < bytes.length) {
      job.view.truncated = true
      job.position.lost += bytes.length - end
    }
  }
  private watchIdle(): void {
    if (this.sweeper) return
    this.sweeper = setInterval(() => void this.closeIdle().catch(() => undefined), IDLE_SWEEP_MS)
    this.sweeper.unref?.()
  }
  /** Close persistent shells and terminals idle past their limit; stop watching when none remain. */
  async closeIdle(now = Date.now()): Promise<void> {
    let watched = false
    const idle: Job[] = []
    for (const jobs of this.sessions.values())
      for (const job of jobs.values()) {
        if (job.view.status !== 'running' || (job.view.kind !== 'shell-session' && job.view.kind !== 'pty'))
          continue
        watched = true
        const limit = job.view.kind === 'pty' ? TERMINAL_IDLE_MS : SHELL_IDLE_MS
        if (this.shells.get(job.view.id)?.busy || now - job.activeAt < limit) continue
        idle.push(job)
      }
    if (!watched) {
      clearInterval(this.sweeper)
      this.sweeper = undefined
    }
    await Promise.all(
      idle.map(async (job) => {
        job.view.status = 'killed'
        try {
          await job.stop()
          job.cleanupPending = false
          job.finish(-1)
        } catch {
          job.view.status = 'running'
        }
      }),
    )
  }
  private get(ctx: JobOwner, id: string): Job {
    const key = owner(ctx)
    const job =
      this.sessions.get(key)?.get(id) ??
      this.directChildren.get(key)?.get(id) ??
      this.descendants.get(key)?.get(id)
    if (!job) throw new Error('JOB_NOT_FOUND: job is not owned by this session/lane')
    return job
  }
  private async open(
    ctx: ProcessJobContext,
    argv: string[],
    cwd: string,
    pty?: { columns: number; rows: number },
  ): Promise<SandboxProcess> {
    ctx.signal.throwIfAborted()
    cwd = resolvePath(ctx.cwd, cwd)
    this.table(ctx)
    if (cwd !== ctx.cwd && (await ctx.fs.stat(cwd)).kind !== 'dir')
      throw new Error('job cwd must be readable')
    const opening = ctx.sandbox.openProcess
      ? ctx.sandbox.openProcess({
          argv,
          cwd,
          env: { PYTHONUNBUFFERED: '1', PYTHONUTF8: '1' },
          signal: ctx.signal,
          ...(pty ? { pty } : {}),
        })
      : pty || argv[0] === SHELL_STDIN_SENTINEL || !('confine' in ctx.sandbox)
        ? undefined
        : legacyProcess({ signal: ctx.signal, sandbox: ctx.sandbox }, argv, cwd)
    if (!opening) throw new Error('SANDBOX_UNAVAILABLE: this Host has no PTY process port')
    const starts = this.starting.get(owner(ctx)) ?? new Set<Promise<SandboxProcess>>()
    this.starting.set(owner(ctx), starts)
    const pending = opening.then(async (handle) => {
      if (ctx.signal.aborted || this.disposed || this.closing.has(owner(ctx))) {
        await handle.close()
        ctx.signal.throwIfAborted()
        throw new Error('session jobs closed during launch')
      }
      return handle
    })
    starts.add(pending)
    let handle: SandboxProcess
    try {
      handle = await pending
    } finally {
      starts.delete(pending)
    }
    if (!handle) throw new Error('SANDBOX_UNAVAILABLE: this Host has no PTY process port')
    if (ctx.signal.aborted || this.disposed || this.closing.has(owner(ctx))) {
      await handle.close()
      ctx.signal.throwIfAborted()
      throw new Error('session jobs closed during launch')
    }
    return handle
  }
  async start(command: string, cwd: string, ctx: ToolContext): Promise<ShellJobView> {
    const call = `${owner(ctx)}\0${ctx.session.toolUseId}`
    const prior = this.calls.get(call)
    if (prior) return copy(this.get(ctx, prior))
    // Nothing ever writes to a command's input, so a prompt for input would wait forever. Reading
    // from /dev/null makes it fail at once instead of leaving a process nobody can answer.
    // The process group is stopped when the shell exits, so the shell's exit trap reports the
    // command's own code on stderr and then waits for what the command started with & or nohup:
    // those stay this job, under job_kill and session close, instead of being reaped at once.
    const mark = `AGH_FG_${randomUUID().slice(0, 8)}:`
    const argv =
      ctx.platform.shell === 'powershell'
        ? [SHELL_SENTINEL, command]
        : [
            'sh',
            '-c',
            `exec </dev/null; trap '__agh_rc=$?; printf "\\n${mark}%s\\n" "$__agh_rc" >&2; wait; exit "$__agh_rc"' EXIT\n${command}`,
          ]
    const handle = await this.open(ctx, argv, cwd)
    let job: Job
    try {
      job = this.add(ctx, this.view('shell', command, cwd), () => handle.close())
    } catch (error) {
      await handle.close()
      throw error
    }
    this.calls.set(call, job.view.id)
    const ended = new RegExp(`\\n?${mark}(-?\\d+)\\n?`)
    const off = handle.onOutput((chunk) => {
      const found = chunk.stream === 'stderr' ? ended.exec(chunk.text) : null
      if (!found) return this.append(job, chunk)
      this.append(job, { stream: 'stderr', text: chunk.text.replace(found[0], '') })
      job.endForeground(Number(found[1]))
    })
    void handle.exited.then(({ code, error, stoppedProcesses, signal }) => {
      off()
      if (stoppedProcesses !== undefined) job.view.stoppedProcesses = stoppedProcesses
      if (code === null && signal && !error) job.view.signal = signal
      job.cleanupPending = error !== undefined
      if (error) this.append(job, { stream: 'stderr', text: String(error) })
      job.finish(error ? null : code)
    })
    return copy(job)
  }
  /**
   * One-shot command a human typed (`!cmd`). Same sandbox path as `start`, but the job is human-owned,
   * accepts signals, ends as `killed` after `timeoutMs` (SIGTERM, then a kill after 2 s) and never
   * joins the completion queue that feeds the model's context.
   */
  async run(
    ctx: ProcessJobContext,
    command: string,
    timeoutMs: number,
    powershell = false,
  ): Promise<ShellJobView> {
    const argv = powershell ? [SHELL_SENTINEL, command] : ['sh', '-c', command]
    const handle = await this.open(ctx, argv, ctx.cwd)
    let job: Job
    try {
      job = this.add(
        ctx,
        { ...this.view('shell', command, ctx.cwd), owner: 'human' },
        () => handle.close(),
        true,
      )
    } catch (error) {
      await handle.close()
      throw error
    }
    this.processes.set(job.view.id, handle)
    const off = handle.onOutput((chunk) => this.append(job, chunk))
    let escalation: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      if (job.view.code !== null) return
      job.view.status = 'killed'
      void handle.signal('SIGTERM').catch(() => undefined)
      escalation = setTimeout(() => {
        if (job.view.code === null)
          void job
            .stop()
            .then(() => job.finish(-1))
            .catch(() => undefined)
      }, 2000)
    }, timeoutMs)
    void handle.exited.then(({ code, error, stoppedProcesses }) => {
      clearTimeout(timer)
      clearTimeout(escalation)
      off()
      this.processes.delete(job.view.id)
      if (stoppedProcesses !== undefined) job.view.stoppedProcesses = stoppedProcesses
      job.cleanupPending = error !== undefined
      if (error) this.append(job, { stream: 'stderr', text: String(error) })
      job.finish(error ? null : code)
    })
    return copy(job)
  }
  async openTerminal(
    ctx: ProcessJobContext,
    shell: PersistentShellName,
    cwd = ctx.cwd,
    dimensions = { columns: 100, rows: 30 },
    pty = true,
    origin: 'human' | 'agent' = 'agent',
  ): Promise<ShellJobView> {
    const handle = await this.open(ctx, shellArgv(shell, pty), cwd, pty ? dimensions : undefined)
    let job: Job
    try {
      job = this.add(
        ctx,
        { ...this.view(pty ? 'pty' : 'shell-session', shell, cwd), shell, owner: origin },
        () => handle.close(),
      )
    } catch (error) {
      await handle.close()
      throw error
    }
    this.processes.set(job.view.id, handle)
    const off = handle.onOutput((chunk) => this.append(job, chunk))
    void handle.exited.then(({ code, error }) => {
      off()
      job.cleanupPending = error !== undefined
      if (error) this.append(job, { stream: 'stderr', text: String(error) })
      job.finish(error ? null : code)
      this.processes.delete(job.view.id)
      this.shells.delete(job.view.id)
    })
    if (!pty) this.shells.set(job.view.id, new PersistentShell(handle, shell))
    this.watchIdle()
    return copy(job)
  }
  async startPersistent(
    command: string,
    cwd: string | undefined,
    ctx: ToolContext,
    shell?: ShellName,
    sessionId?: string,
  ): Promise<ShellJobView> {
    const call = `${owner(ctx)}\0${ctx.session.toolUseId}`
    const prior = this.calls.get(call)
    if (prior) return copy(this.get(ctx, prior))
    const selected: PersistentShellName =
      shell ?? (ctx.platform.shell === 'powershell' ? 'powershell' : 'bash')
    let session = sessionId
      ? this.get(ctx, sessionId)
      : [...this.table(ctx).values()].find(
          (job) =>
            job.view.kind === 'shell-session' && job.view.shell === selected && job.view.status === 'running',
        )
    if (!session)
      session = this.get(ctx, (await this.openTerminal(ctx, selected, cwd ?? ctx.cwd, undefined, false)).id)
    const transport = this.shells.get(session.view.id)
    if (!transport || session.view.status !== 'running')
      throw new Error('shell session is closed or is not a persistent shell')
    if (transport.busy) throw new Error('SHELL_BUSY: wait for the running command before sending another')
    const job = this.add(
      ctx,
      {
        ...this.view('shell', command, session.view.cwd),
        shell: session.view.shell!,
        sessionId: session.view.id,
      },
      async () => {
        await this.kill(ctx, session!.view.id)
      },
    )
    this.calls.set(call, job.view.id)
    const shellJob = session
    shellJob.activeAt = Date.now()
    void transport
      .run(command, cwd, (chunk) => this.append(job, chunk))
      .then(
        ({ code, cwd: next }) => {
          shellJob.activeAt = Date.now()
          if (next) {
            shellJob.view.cwd = next
            job.view.cwd = next
          }
          job.finish(code)
        },
        (error: unknown) => {
          shellJob.activeAt = Date.now()
          this.append(job, { stream: 'stderr', text: String(error) })
          job.finish(null)
        },
      )
    return copy(job)
  }
  list(ctx: JobOwner): ShellJobView[] {
    const key = owner(ctx)
    return [
      ...(this.sessions.get(key)?.values() ?? []),
      ...(this.directChildren.get(key)?.values() ?? []),
      ...(this.descendants.get(key)?.values() ?? []),
    ].map(copy)
  }
  /**
   * Bounded list for the public `jobs.read` RPC (`maxItems: 128`). Real session jobs always come
   * first, then direct children, then read-only descendants, while preserving an explicitly
   * selected job if it falls past the window.
   */
  listBounded(ctx: JobOwner, selectedJobId?: string, limit = MAX_JOBS): ShellJobView[] {
    const key = owner(ctx)
    return collectBoundedJobs(
      [this.sessions.get(key), this.directChildren.get(key), this.descendants.get(key)],
      selectedJobId,
      limit,
    )
  }
  findLocalJob(ctx: JobOwner, id: string): ShellJobView | undefined {
    const job = this.sessions.get(owner(ctx))?.get(id)
    return job ? copy(job) : undefined
  }
  isControllableChild(ctx: JobOwner, id: string): boolean {
    const job = this.directChildren.get(owner(ctx))?.get(id)
    return Boolean(job && !job.readOnly && job.view.ownerSessionId === ctx.session.key)
  }
  completions(ctx: JobOwner): ShellJobView[] {
    return [...(this.notifications.get(owner(ctx)) ?? [])]
  }
  /**
   * A tool result has shown the model how this job ended (a foreground command's exit, a read of a
   * finished job, a kill), so no completion notice is due for it. A job still running is not marked.
   */
  acknowledge(ctx: JobOwner, id: string): void {
    const key = owner(ctx)
    const job = this.sessions.get(key)?.get(id) ?? this.directChildren.get(key)?.get(id)
    if (job && job.view.code !== null) this.markTold(key, [id])
  }
  /** The completions the model has not been told about yet, each returned once. */
  announceCompletions(ctx: JobOwner): ShellJobView[] {
    const told = this.told.get(owner(ctx))
    const fresh = this.completions(ctx).filter((job) => !told?.has(job.id))
    if (fresh.length)
      this.markTold(
        owner(ctx),
        fresh.map((job) => job.id),
      )
    return fresh
  }
  /** Only a queued job can be announced, so what is kept is never more than the queue. */
  private markTold(key: string, ids: string[]): void {
    const queued = new Set((this.notifications.get(key) ?? []).map((job) => job.id))
    const told = [...(this.told.get(key) ?? []), ...ids].filter((id) => queued.has(id))
    if (told.length) this.told.set(key, new Set(told))
    else this.told.delete(key)
  }
  private upsertChild(
    ctx: JobOwner & Pick<ToolContext, 'cwd'>,
    child: ChildJobListing,
    controls: ExtendedChildJobsPort,
  ): Job {
    return upsertChildProjection(ctx.session.key, child, controls, {
      direct: () => this.mapFor(this.directChildren, ctx),
      descendants: () => this.mapFor(this.descendants, ctx),
      create: (id, ownerSessionId, readOnly, stop) =>
        this.createJob(
          ctx,
          { ...this.view('child', child.providerId, ctx.cwd), id, ownerSessionId },
          stop,
          readOnly,
          readOnly,
        ),
    })
  }
  async syncChildren(
    ctx: JobOwner & Pick<ToolContext, 'cwd'> & { subagent?: ToolContext['subagent'] },
    port?: SessionChildJobs,
    selectedJobId?: string,
  ): Promise<void> {
    const controls = resolveChildJobsPort(ctx.subagent, port, selectedJobId)
    if (!controls) return
    const present = new Set<string>()
    let listedDirect = 0
    let listedDescendants = 0
    for (const child of await controls.list()) {
      const job = this.upsertChild(ctx, child, controls)
      present.add(job.view.id)
      if (job.readOnly) listedDescendants++
      else listedDirect++
    }
    const selectedConfirmedMissing = new Set<string>()
    if (selectedJobId?.startsWith('child:') && controls.readDetail) {
      const detail = await controls.readDetail(selectedJobId.slice('child:'.length))
      if (detail) present.add(this.upsertChild(ctx, detail, controls).view.id)
      else if (!present.has(selectedJobId)) selectedConfirmedMissing.add(selectedJobId)
    }
    await pruneReclaimedChildren(
      controls,
      {
        direct: this.directChildren.get(owner(ctx)),
        descendants: this.descendants.get(owner(ctx)),
        upsert: (child) => this.upsertChild(ctx, child, controls),
      },
      { present, selectedConfirmedMissing, listedDirect, listedDescendants },
    )
  }
  /** Resolve and sync one direct child for kill without materializing the full descendant tree. */
  async syncDirectChild(
    ctx: JobOwner & Pick<ToolContext, 'cwd'>,
    port: SessionChildJobs | undefined,
    jobId: string,
  ): Promise<ShellJobView | undefined> {
    if (!port || !jobId.startsWith('child:')) return undefined
    const extended = port as ExtendedChildJobsPort
    if (extended.readDirect) {
      const rawId = jobId.slice('child:'.length)
      const existing = this.directChildren.get(owner(ctx))?.get(jobId)
      const direct = await extended.readDirect(rawId)
      if (!direct || isReadOnlyChildListing(direct, ctx.session.key)) {
        const map = this.directChildren.get(owner(ctx))
        if (existing && !existing.childTerminal && map?.get(jobId) === existing) map.delete(jobId)
        return undefined
      }
      return copy(this.upsertChild(ctx, direct, extended))
    }
    await this.syncChildren(ctx, port)
    const job = this.directChildren.get(owner(ctx))?.get(jobId)
    return job && !job.readOnly ? copy(job) : undefined
  }

  output(ctx: JobOwner, id: string, cursor?: string) {
    const job = this.get(ctx, id)
    job.activeAt = Date.now()
    return {
      ...copy(job),
      startedAt: job.startedAt,
      ...this.cursors.read(owner(ctx), id, job.position, job.view.stdout, job.view.stderr, cursor),
    }
  }
  async wait(
    ctx: JobOwner & Pick<ToolContext, 'signal'> & Partial<Pick<ToolContext, 'cwd' | 'subagent'>>,
    id: string,
    ms: number,
    /** Return once the command itself has ended, though processes it backgrounded still run. */
    opts: { foreground?: boolean } = {},
  ): Promise<ShellJobView> {
    ctx.signal.throwIfAborted()
    const job = this.get(ctx, id)
    job.activeAt = Date.now()
    if (job.view.kind === 'child' && ctx.cwd && ctx.subagent) {
      const deadline = Date.now() + Math.max(0, ms)
      do {
        await this.syncChildren({ session: ctx.session, cwd: ctx.cwd, subagent: ctx.subagent }, undefined, id)
        if (job.view.status !== 'running' || ms <= 0) return copy(job)
        await this.wait(
          { session: ctx.session, signal: ctx.signal },
          id,
          Math.min(50, Math.max(0, deadline - Date.now())),
        )
      } while (Date.now() < deadline)
      return copy(job)
    }
    if (job.view.status !== 'running' || ms <= 0) return copy(job)
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abort)
      }
      const finish = () => {
        cleanup()
        resolve(copy(job))
      }
      const abort = () => {
        cleanup()
        reject(ctx.signal.reason ?? new Error('cancelled'))
      }
      const timer = setTimeout(finish, ms)
      ctx.signal.addEventListener('abort', abort, { once: true })
      if (ctx.signal.aborted) abort()
      // bash also runs the exit trap when a signal ends the shell, then dies of that signal; the
      // brief settle lets that exit, or a plain one with nothing in the background, win the report.
      void (
        opts.foreground
          ? job.foreground.then(() =>
              Promise.race([job.done, new Promise((r) => setTimeout(r, FOREGROUND_SETTLE_MS))]),
            )
          : job.done
      ).then(finish)
    })
  }
  async kill(ctx: JobOwner, id: string): Promise<ShellJobView> {
    const job = this.get(ctx, id)
    if (job.readOnly)
      throw new Error('CAPABILITY_DENIED: read-only child job cannot be stopped from this session')
    if (job.view.status === 'running' || job.cleanupPending || job.childIdle) {
      if (job.view.kind === 'child') {
        const isCurrent = () => this.directChildren.get(owner(ctx))?.get(id) === job
        const reclaimed = await stopChildJob(job, isCurrent)
        const view = copy(job)
        if (reclaimed && !job.childTerminal && isCurrent()) this.directChildren.get(owner(ctx))?.delete(id)
        return view
      }
      const { status, code } = job.view
      job.view.code = null
      job.view.status = 'killed'
      try {
        await job.stop()
        job.cleanupPending = false
        job.finish(-1)
      } catch (error) {
        job.view.status = status
        job.view.code = code
        throw error
      }
    }
    return copy(job)
  }
  async send(ctx: JobOwner, id: string, text: string): Promise<void> {
    const job = this.get(ctx, id)
    if (job.view.kind !== 'pty' || job.view.status !== 'running') throw new Error('job is not a running PTY')
    if (Buffer.byteLength(text) > 65536) throw new Error('terminal input exceeds 64KiB')
    job.activeAt = Date.now()
    await this.processes.get(id)!.write(text)
  }
  async resize(ctx: JobOwner, id: string, columns: number, rows: number): Promise<void> {
    this.get(ctx, id)
    const process = this.processes.get(id)
    if (!process) throw new Error('PTY is closed')
    await process.resize(columns, rows)
  }
  async signal(ctx: JobOwner, id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): Promise<void> {
    this.get(ctx, id)
    const process = this.processes.get(id)
    if (!process) throw new Error('process is closed')
    await process.signal(signal)
  }
  async closeSession(key: string, lane?: string): Promise<void> {
    const ownerKeys = new Set([
      ...this.sessions.keys(),
      ...this.directChildren.keys(),
      ...this.descendants.keys(),
    ])
    for (const ownerKey of ownerKeys) {
      if (lane === undefined ? !ownerKey.startsWith(`${key}\0`) : ownerKey !== `${key}\0${lane}`) continue
      const jobs = this.sessions.get(ownerKey)
      this.closing.add(ownerKey)
      await Promise.allSettled([...(this.starting.get(ownerKey) ?? [])])
      const failures = await Promise.allSettled(
        [...(jobs?.values() ?? [])]
          .filter((job) => (job.view.status === 'running' || job.cleanupPending) && job.view.kind !== 'child')
          .map(async (job) => {
            job.view.status = 'killed'
            try {
              await job.stop()
              job.cleanupPending = false
              job.finish(-1)
            } catch (error) {
              job.view.status = 'running'
              throw error
            }
          }),
      )
      if (failures.some((result) => result.status === 'rejected'))
        throw new AggregateError(
          failures.filter((result) => result.status === 'rejected').map((result) => result.reason),
          'job shutdown failed',
        )
      this.sessions.delete(ownerKey)
      this.directChildren.delete(ownerKey)
      this.descendants.delete(ownerKey)
      this.notifications.delete(ownerKey)
      this.told.delete(ownerKey)
      this.starting.delete(ownerKey)
      for (const call of this.calls.keys()) if (call.startsWith(`${ownerKey}\0`)) this.calls.delete(call)
      this.closing.delete(ownerKey)
    }
  }
  async closeTerminals(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].flatMap((jobs) =>
        [...jobs.values()]
          .filter((job) => job.view.kind === 'pty' && job.view.status === 'running')
          .map(async (job) => {
            job.view.status = 'killed'
            try {
              await job.stop()
              job.cleanupPending = false
              job.finish(-1)
            } catch (error) {
              job.view.status = 'running'
              throw error
            }
          }),
      ),
    )
  }
  dispose(): Promise<void> {
    this.disposal ??= (async () => {
      this.disposed = true
      clearInterval(this.sweeper)
      this.sweeper = undefined
      await Promise.resolve()
      try {
        const keys = new Set([
          ...this.sessions.keys(),
          ...this.directChildren.keys(),
          ...this.descendants.keys(),
        ])
        for (const key of keys) await this.closeSession(key.split('\0')[0]!)
      } finally {
        this.disposed = false
        this.disposal = undefined
      }
    })()
    return this.disposal
  }
}
const registries = new WeakMap<AbortSignal, ShellJobs>()
export function shellJobsFor(signal: AbortSignal): ShellJobs {
  let jobs = registries.get(signal)
  if (!jobs) {
    jobs = new ShellJobs()
    registries.set(signal, jobs)
    const registry = jobs
    signal.addEventListener(
      'abort',
      () => {
        void registry.dispose().catch(() => undefined)
      },
      { once: true },
    )
  }
  return jobs
}
export const standaloneShellJobs = new ShellJobs()
