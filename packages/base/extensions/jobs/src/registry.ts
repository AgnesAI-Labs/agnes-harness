import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import type { ProcessOutput, SandboxProcess, SessionChildJobs, ToolContext } from '@agnes/extension-api'
import { legacyProcess } from './legacy-process.js'
import { PersistentShell, type ShellName, shellArgv } from './persistent-shell.js'

export interface ShellJobView {
  id: string
  kind: 'shell' | 'shell-session' | 'pty' | 'child'
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
  shell?: ShellName
  sessionId?: string
}
export type ProcessJobContext = Pick<ToolContext, 'session' | 'cwd' | 'signal' | 'fs'> & {
  sandbox: Pick<ToolContext['sandbox'], 'openProcess'> | ToolContext['sandbox']
}
export type JobOwner = Pick<ToolContext, 'session'>
interface Job {
  view: ShellJobView
  capturedBytes: number
  done: Promise<ShellJobView>
  finish(code: number | null): void
  stop(): Promise<void>
}
const MAX_JOBS = 128,
  MAX_OUTPUT = 4 * 1024 * 1024
const owner = (ctx: JobOwner) => `${ctx.session.key}\0${ctx.session.lane}`
const copy = (job: Job) => ({ ...job.view })

/** One owner-scoped registry for every executable kind. Handles live until session/provider shutdown. */
export class ShellJobs {
  private readonly sessions = new Map<string, Map<string, Job>>()
  private readonly processes = new Map<string, SandboxProcess>()
  private readonly shells = new Map<string, PersistentShell>()
  private readonly calls = new Map<string, string>()
  private readonly notifications = new Map<string, ShellJobView[]>()
  private readonly closing = new Set<string>()
  private readonly starting = new Map<string, Set<Promise<SandboxProcess>>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  private table(ctx: JobOwner): Map<string, Job> {
    const key = owner(ctx)
    if (this.disposed || this.closing.has(key)) throw new Error('session jobs are closing')
    let jobs = this.sessions.get(key)
    if (!jobs) {
      jobs = new Map()
      this.sessions.set(key, jobs)
    }
    return jobs
  }
  private add(ctx: JobOwner, view: ShellJobView, stop: () => Promise<void>): Job {
    const jobs = this.table(ctx)
    if (jobs.size >= MAX_JOBS) {
      const old = [...jobs].find(([, job]) => job.view.status !== 'running')
      if (!old) throw new Error('session job limit reached; close a running job first')
      jobs.delete(old[0])
      for (const [call, id] of this.calls) if (id === old[0]) this.calls.delete(call)
    }
    let resolve!: (view: ShellJobView) => void
    const job: Job = {
      view,
      stop,
      capturedBytes: 0,
      done: new Promise((r) => {
        resolve = r
      }),
      finish: (code) => {
        if (view.status !== 'running' && view.status !== 'killed') return
        if (view.code !== null) return
        view.code = code ?? -1
        if (view.status !== 'killed') view.status = code === 0 ? 'completed' : 'failed'
        const queue = this.notifications.get(owner(ctx)) ?? []
        queue.push({ ...view, stdout: '', stderr: '' })
        this.notifications.set(owner(ctx), queue.slice(-128))
        resolve(copy(job))
      },
    }
    jobs.set(view.id, job)
    return job
  }
  private view(kind: ShellJobView['kind'], command: string, cwd: string): ShellJobView {
    return {
      id: randomUUID(),
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
    const available = Math.max(0, MAX_OUTPUT - job.capturedBytes)
    const bytes = Buffer.from(chunk.text)
    let end = Math.min(available, bytes.length)
    // Do not expose half of a UTF-8 character at the byte limit.
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
    job.capturedBytes += end
    job.view[chunk.stream] += bytes.subarray(0, end).toString('utf8')
    if (end < bytes.length) job.view.truncated = true
  }
  private get(ctx: JobOwner, id: string): Job {
    const job = this.sessions.get(owner(ctx))?.get(id)
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
      ? ctx.sandbox.openProcess({ argv, cwd, signal: ctx.signal, ...(pty ? { pty } : {}) })
      : pty || !('confine' in ctx.sandbox)
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
    const argv =
      ctx.platform.shell === 'powershell'
        ? ['pwsh', '-NoLogo', '-NoProfile', '-Command', command]
        : ['sh', '-c', command]
    const handle = await this.open(ctx, argv, cwd)
    let job: Job
    try {
      job = this.add(ctx, this.view('shell', command, cwd), () => handle.close())
    } catch (error) {
      await handle.close()
      throw error
    }
    this.calls.set(call, job.view.id)
    const off = handle.onOutput((chunk) => this.append(job, chunk))
    void handle.exited.then(({ code }) => {
      off()
      job.finish(code)
    })
    return copy(job)
  }
  async openTerminal(
    ctx: ProcessJobContext,
    shell: ShellName,
    cwd = ctx.cwd,
    dimensions = { columns: 100, rows: 30 },
    pty = true,
  ): Promise<ShellJobView> {
    const handle = await this.open(ctx, shellArgv(shell, pty), cwd, pty ? dimensions : undefined)
    let job: Job
    try {
      job = this.add(ctx, { ...this.view(pty ? 'pty' : 'shell-session', shell, cwd), shell }, () =>
        handle.close(),
      )
    } catch (error) {
      await handle.close()
      throw error
    }
    this.processes.set(job.view.id, handle)
    const off = handle.onOutput((chunk) => this.append(job, chunk))
    void handle.exited.then(({ code }) => {
      off()
      job.finish(code)
      this.processes.delete(job.view.id)
      this.shells.delete(job.view.id)
    })
    if (!pty) this.shells.set(job.view.id, new PersistentShell(handle, shell))
    return copy(job)
  }
  async startPersistent(
    command: string,
    cwd: string | undefined,
    ctx: ToolContext,
    shell: ShellName = ctx.platform.shell === 'powershell' ? 'pwsh' : 'bash',
    sessionId?: string,
  ): Promise<ShellJobView> {
    const call = `${owner(ctx)}\0${ctx.session.toolUseId}`
    const prior = this.calls.get(call)
    if (prior) return copy(this.get(ctx, prior))
    let session = sessionId
      ? this.get(ctx, sessionId)
      : [...this.table(ctx).values()].find(
          (job) =>
            job.view.kind === 'shell-session' && job.view.shell === shell && job.view.status === 'running',
        )
    if (!session)
      session = this.get(ctx, (await this.openTerminal(ctx, shell, cwd ?? ctx.cwd, undefined, false)).id)
    const transport = this.shells.get(session.view.id)
    if (!transport || session.view.status !== 'running')
      throw new Error('shell session is closed or is not a persistent shell')
    if (transport.busy) throw new Error('SHELL_BUSY: wait for the running command before sending another')
    const job = this.add(
      ctx,
      { ...this.view('shell', command, session.view.cwd), shell, sessionId: session.view.id },
      async () => {
        await this.kill(ctx, session!.view.id)
      },
    )
    this.calls.set(call, job.view.id)
    void transport
      .run(command, cwd, (chunk) => this.append(job, chunk))
      .then(
        ({ code, cwd: next }) => {
          if (next) {
            session!.view.cwd = next
            job.view.cwd = next
          }
          job.finish(code)
        },
        (error: unknown) => {
          this.append(job, { stream: 'stderr', text: String(error) })
          job.finish(null)
        },
      )
    return copy(job)
  }
  list(ctx: JobOwner): ShellJobView[] {
    return [...(this.sessions.get(owner(ctx))?.values() ?? [])].map(copy)
  }
  completions(ctx: JobOwner): ShellJobView[] {
    return [...(this.notifications.get(owner(ctx)) ?? [])]
  }
  async syncChildren(
    ctx: JobOwner & Pick<ToolContext, 'cwd'> & { subagent?: ToolContext['subagent'] },
    port?: SessionChildJobs,
  ): Promise<void> {
    const controls =
      port ??
      (ctx.subagent?.list
        ? {
            list: async () =>
              Promise.all(
                (await ctx.subagent!.list!()).map(async (child) => {
                  if (child.text !== undefined) return child
                  const snapshot = await ctx.subagent!.collect(child.id, { wait: false })
                  return { ...child, ...(snapshot.text !== undefined ? { text: snapshot.text } : {}) }
                }),
              ),
            cancel: async (id: string) => {
              await ctx.subagent!.cancel(id)
            },
          }
        : undefined)
    if (!controls) return
    for (const child of await controls.list()) {
      const jobs = this.table(ctx),
        id = `child:${child.id}`
      let job = jobs.get(id)
      if (!job)
        job = this.add(ctx, { ...this.view('child', child.providerId, ctx.cwd), id }, async () => {
          if (!controls.cancel) throw new Error('child cancellation needs an effect service')
          await controls.cancel(child.id)
        })
      if (controls.cancel) job.stop = () => controls.cancel!(child.id)
      job.view.stdout = child.text?.slice(-MAX_OUTPUT) ?? job.view.stdout
      if (['completed', 'failed', 'cancelled'].includes(child.status)) {
        if (child.status === 'cancelled') job.view.status = 'killed'
        job.finish(child.status === 'completed' ? 0 : -1)
      }
    }
  }
  async wait(
    ctx: JobOwner & Pick<ToolContext, 'signal'> & Partial<Pick<ToolContext, 'cwd' | 'subagent'>>,
    id: string,
    ms: number,
  ): Promise<ShellJobView> {
    ctx.signal.throwIfAborted()
    const job = this.get(ctx, id)
    if (job.view.status !== 'running' || ms <= 0) return copy(job)
    if (job.view.kind === 'child' && ctx.cwd && ctx.subagent) {
      const deadline = Date.now() + ms
      do {
        await this.syncChildren({ session: ctx.session, cwd: ctx.cwd, subagent: ctx.subagent })
        if (job.view.status !== 'running') return copy(job)
        await this.wait(
          { session: ctx.session, signal: ctx.signal },
          id,
          Math.min(50, Math.max(0, deadline - Date.now())),
        )
      } while (Date.now() < deadline)
      return copy(job)
    }
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
      void job.done.then(finish)
    })
  }
  async kill(ctx: JobOwner, id: string): Promise<ShellJobView> {
    const job = this.get(ctx, id)
    if (job.view.status === 'running') {
      job.view.status = 'killed'
      try {
        await job.stop()
        job.finish(-1)
      } catch (error) {
        job.view.status = 'running'
        throw error
      }
    }
    return copy(job)
  }
  async send(ctx: JobOwner, id: string, text: string): Promise<void> {
    const job = this.get(ctx, id)
    if (job.view.kind !== 'pty' || job.view.status !== 'running') throw new Error('job is not a running PTY')
    if (Buffer.byteLength(text) > 65536) throw new Error('terminal input exceeds 64KiB')
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
    for (const [ownerKey, jobs] of this.sessions) {
      if (lane === undefined ? !ownerKey.startsWith(`${key}\0`) : ownerKey !== `${key}\0${lane}`) continue
      this.closing.add(ownerKey)
      await Promise.allSettled([...(this.starting.get(ownerKey) ?? [])])
      const failures = await Promise.allSettled(
        [...jobs.values()]
          .filter((job) => job.view.status === 'running' && job.view.kind !== 'child')
          .map(async (job) => {
            job.view.status = 'killed'
            try {
              await job.stop()
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
      this.notifications.delete(ownerKey)
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
      await Promise.resolve()
      try {
        for (const key of this.sessions.keys()) await this.closeSession(key.split('\0')[0]!)
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
