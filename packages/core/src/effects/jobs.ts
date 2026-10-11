import type { JobInfo, JobOutput } from '@agnes/extension-api'
import { CoreError } from '../types.js'
import type { SandboxProcess, SandboxSeam } from './seams.js'

/** How many of a session's background jobs may run at once. */
export const MAX_RUNNING_JOBS = 8
/** The most recent output kept per job, in characters; older output is dropped and counted. */
export const JOB_OUTPUT_KEEP = 1024 * 1024
/** The longest a single output read may wait for something new. */
export const MAX_JOB_WAIT_MS = 60_000

type Job = {
  info: JobInfo
  process: SandboxProcess
  /** The kept tail of the output, and the offset of its first character in all output so far. */
  buffer: string
  base: number
  /** Where the last read ended. */
  cursor: number
  wake: Set<() => void>
}

/**
 * A session's background jobs: processes started to outlive the tool call that started them. The
 * session owns them; `stopAll` is how it stops them when it closes, and nothing here survives the
 * process that holds the registry.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>()
  private serial = 0
  private closed = false

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Jobs whose process is still running; a session with any is not idle. */
  running(): number {
    let n = 0
    for (const job of this.jobs.values()) if (job.info.status === 'running') n++
    return n
  }

  async start(
    sandbox: Pick<SandboxSeam, 'start'>,
    cmd: string[],
    opts: { cwd: string; command: string; env?: Record<string, string> },
  ): Promise<JobInfo> {
    if (this.closed) throw new CoreError('E_JOB_UNAVAILABLE', 'the session is closing; no job can start')
    if (!sandbox.start)
      throw new CoreError('E_JOB_UNAVAILABLE', 'this workspace cannot run a background process')
    if (this.running() >= MAX_RUNNING_JOBS)
      throw new CoreError(
        'E_JOB_LIMIT',
        `${MAX_RUNNING_JOBS} background jobs are already running; stop one before starting another`,
      )
    const process = await sandbox.start(cmd, { cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) })
    const id = `job-${++this.serial}`
    const job: Job = {
      info: {
        id,
        command: opts.command,
        cwd: opts.cwd,
        status: 'running',
        startedAt: this.clock().toISOString(),
      },
      process,
      buffer: '',
      base: 0,
      cursor: 0,
      wake: new Set(),
    }
    this.jobs.set(id, job)
    process.onOutput((text) => {
      job.buffer += text
      if (job.buffer.length > JOB_OUTPUT_KEEP) {
        const cut = job.buffer.length - JOB_OUTPUT_KEEP
        job.buffer = job.buffer.slice(cut)
        job.base += cut
      }
      this.notify(job)
    })
    void process.done.then(({ code }) => {
      if (job.info.status === 'running') {
        job.info.status = 'exited'
        if (code !== null) job.info.code = code
      }
      this.notify(job)
    })
    // A start races the session closing: a job admitted while it closed is stopped, not kept.
    if (this.closed) await this.stop(id)
    return { ...job.info }
  }

  async output(id: string, opts: { since?: number; waitMs?: number } = {}): Promise<JobOutput> {
    const job = this.get(id)
    const total = () => job.base + job.buffer.length
    const since = Math.max(0, Math.min(opts.since ?? job.cursor, total()))
    const waitMs = Math.max(0, Math.min(opts.waitMs ?? 0, MAX_JOB_WAIT_MS))
    if (waitMs > 0 && since >= total() && job.info.status === 'running')
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          job.wake.delete(done)
          resolve()
        }
        const timer = setTimeout(done, waitMs)
        job.wake.add(done)
      })
    const from = Math.max(since, job.base)
    job.cursor = total()
    return {
      ...job.info,
      text: job.buffer.slice(from - job.base),
      next: job.cursor,
      dropped: from - since,
    }
  }

  async stop(id: string): Promise<JobInfo> {
    const job = this.get(id)
    if (job.info.status === 'running') job.info.status = 'stopped'
    // Stopping a job that already ended is harmless; the executor stopped what it left behind.
    await job.process.stop()
    this.notify(job)
    return { ...job.info }
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].map((job) => ({ ...job.info }))
  }

  /** Stops every job and refuses new ones from then on. */
  async stopAll(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.jobs.keys()].map((id) => this.stop(id)))
  }

  private get(id: string): Job {
    const job = this.jobs.get(id)
    if (!job)
      throw new CoreError(
        'E_JOB_UNKNOWN',
        `no background job ${JSON.stringify(id)} in this session; jobs end when the session that started them closes`,
      )
    return job
  }

  private notify(job: Job): void {
    for (const wake of [...job.wake]) wake()
  }
}
