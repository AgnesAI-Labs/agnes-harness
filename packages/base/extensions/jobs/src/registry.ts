import { type ChildProcess, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { resolve as resolvePath } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ToolContext } from '@agnes/extension-api'

export interface ShellJobView {
  id: string
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
}
interface Job {
  view: ShellJobView
  child: ChildProcess
  done: Promise<ShellJobView>
  settled: boolean
}
const MAX_JOBS = 128
const MAX_OUTPUT = 4 * 1024 * 1024
const owner = (ctx: ToolContext) => `${ctx.session.key}\0${ctx.session.lane}`

/** Process-owned jobs survive tool/turn completion, never Host restart. Only confined argv launches. */
export class ShellJobs {
  private readonly sessions = new Map<string, Map<string, Job>>()
  async start(command: string, cwd: string, ctx: ToolContext): Promise<ShellJobView> {
    const windows = process.platform === 'win32' // guards-allow-platform: POSIX process-group availability
    if (windows) throw new Error('background jobs require a process-group backend; unavailable on Windows')
    ctx.signal.throwIfAborted()
    cwd = resolvePath(ctx.cwd, cwd)
    // A custom cwd needs its own policy check; confinement is tied to this invocation's workspace.
    if (cwd !== ctx.cwd && (await ctx.fs.stat(cwd)).kind !== 'dir')
      throw new Error('job cwd must be a readable directory')
    // confine accepts executable argv; shell sentinel expansion belongs only to ctx.exec.
    const argv = await ctx.sandbox.confine(['sh', '-c', command])
    ctx.signal.throwIfAborted()
    if (!argv.length) throw new Error('host did not resolve the confined shell')
    const key = owner(ctx)
    let jobs = this.sessions.get(key)
    if (!jobs) {
      jobs = new Map()
      this.sessions.set(key, jobs)
    }
    const prior = jobs.get(ctx.session.toolUseId)
    if (prior) return { ...prior.view }
    if (jobs.size >= MAX_JOBS) {
      const oldest = [...jobs].find(([, j]) => j.settled)
      if (!oldest) throw new Error('session job limit reached; kill a running job first')
      jobs.delete(oldest[0])
    }
    const id = randomUUID()
    const view: ShellJobView = {
      id,
      command,
      cwd,
      status: 'running',
      code: null,
      stdout: '',
      stderr: '',
      truncated: false,
    }
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let resolve!: (v: ShellJobView) => void
    const done = new Promise<ShellJobView>((r) => {
      resolve = r
    })
    const job: Job = { view, child, done, settled: false }
    jobs.set(ctx.session.toolUseId, job)
    let captured = 0
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
    const collect = (field: 'stdout' | 'stderr', bytes: Buffer) => {
      const available = Math.max(0, MAX_OUTPUT - captured)
      view[field] += decoders[field].write(bytes.subarray(0, available))
      captured += Math.min(available, bytes.length)
      if (bytes.length > available) view.truncated = true
    }
    child.stdout?.on('data', (b) => collect('stdout', b))
    child.stderr?.on('data', (b) => collect('stderr', b))
    const finish = (code: number | null) => {
      if (job.settled) return
      job.settled = true
      view.stdout += decoders.stdout.end()
      view.stderr += decoders.stderr.end()
      view.code = code
      if (view.status !== 'killed') view.status = code === 0 ? 'completed' : 'failed'
      resolve({ ...view })
    }
    child.once('error', (error) => {
      view.stderr += error.message
      finish(null)
    })
    child.once('close', finish)
    // Wait for actual launch. A spawn error is never advertised as a running job.
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    if (ctx.signal.aborted) {
      this.killJob(job)
      ctx.signal.throwIfAborted()
    }
    return { ...view }
  }
  list(ctx: ToolContext): ShellJobView[] {
    return [...(this.sessions.get(owner(ctx))?.values() ?? [])].map((j) => ({ ...j.view }))
  }
  private get(ctx: ToolContext, id: string): Job {
    const job = [...(this.sessions.get(owner(ctx))?.values() ?? [])].find((j) => j.view.id === id)
    if (!job) throw new Error('JOB_NOT_FOUND: job is not owned by this session/lane')
    return job
  }
  async wait(ctx: ToolContext, id: string, ms: number): Promise<ShellJobView> {
    const job = this.get(ctx, id)
    if (job.settled || ms <= 0) return { ...job.view }
    return new Promise((resolve, reject) => {
      const finish = (v: ShellJobView) => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abort)
        resolve(v)
      }
      const abort = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', abort)
        reject(ctx.signal.reason ?? new Error('cancelled'))
      }
      const timer = setTimeout(() => finish({ ...job.view }), ms)
      ctx.signal.addEventListener('abort', abort, { once: true })
      if (ctx.signal.aborted) abort()
      void job.done.then(finish)
    })
  }
  private killJob(job: Job): void {
    if (job.settled) return
    job.view.status = 'killed'
    if (job.child.pid) {
      try {
        process.kill(-job.child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  async kill(ctx: ToolContext, id: string): Promise<ShellJobView> {
    const j = this.get(ctx, id)
    this.killJob(j)
    return j.done
  }
  async closeSession(key: string, lane?: string): Promise<void> {
    for (const [ownerKey, jobs] of this.sessions) {
      if (lane === undefined ? !ownerKey.startsWith(`${key}\0`) : ownerKey !== `${key}\0${lane}`) continue
      for (const job of jobs.values()) this.killJob(job)
      await Promise.all([...jobs.values()].map((j) => j.done))
      this.sessions.delete(ownerKey)
    }
  }
  async dispose(): Promise<void> {
    for (const key of this.sessions.keys()) await this.closeSession(key.split('\0')[0] as string)
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
        void registry.dispose()
      },
      { once: true },
    )
  }
  return jobs
}

export const standaloneShellJobs = new ShellJobs()
