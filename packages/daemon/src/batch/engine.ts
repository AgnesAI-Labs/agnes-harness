import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { AGNES_ERRORS, type BatchStatus, type EventEnvelope, type JobSpec } from '@agnes/protocol'
import { enumerateItems } from './enumerate.js'
import { exportBatch, RESULT_FILES } from './export.js'
import { creditsOf, itemPrompt, parseReply, readOutcome, repairPrompt } from './prompt.js'
import {
  type BatchRepo,
  type BatchRow,
  type BatchState,
  clipText,
  ITEM_STATES,
  type ItemRow,
  REPLY_MARK,
} from './repo.js'
import {
  BatchSpecError,
  compileOutputSchema,
  FAIL_FAST_ITEMS,
  inside,
  itemPrincipal,
  itemSessionKey,
  type OutputCheck,
  resolveSpec,
} from './spec.js'

export type BatchJobState = {
  status: string
  error?: string
  /** When the job was written (ms); queue time is counted from here. */
  createdAt?: number
  /** How often the job was reclaimed from a lease that ran out. */
  stalledCounter?: number
}
export type BatchJobsPort = Readonly<{
  enqueue(spec: JobSpec): Promise<void>
  /** Undefined only when the queue has no such job; any other failure is thrown. */
  status(jobId: string): Promise<BatchJobState | undefined>
  cancel(jobId: string): Promise<void>
}>
export type BatchSessionsPort = Readonly<{
  /**
   * Makes the item session ready to be opened by the scheduler: owned by `principalId` and bound to
   * the workspace `root`, which is also its working directory (item paths are relative to it).
   */
  prepare(input: { sessionKey: string; principalId: string; root: string }): Promise<void>
  transcript(sessionKey: string): Promise<readonly EventEnvelope[]>
  /** Closes a settled item session so the worker does not keep it, or its queued title request, alive. */
  release(sessionKey: string): Promise<void>
}>
export type BatchHostPort = Readonly<{
  /**
   * True only while the hook that keeps item sessions to the read tool is active in the host that
   * runs them. Items never run without it: a batch that cannot confirm it fails.
   */
  itemConfinementReady(): Promise<boolean>
}>
export type BatchEngineOptions = Readonly<{
  repo: BatchRepo
  jobs: BatchJobsPort
  sessions: BatchSessionsPort
  host: BatchHostPort
  profileName: string
  clock: () => number
  tickMs: number
  /** How long a call into the item sessions' worker may take (default 60 s). */
  portTimeoutMs?: number
  audit?: (record: unknown) => void
  log?: (message: string) => void
}>
export type BatchBegin = Readonly<{
  batchId: string
  principalId: string
  root: string
  cwd: string
  spec: unknown
  origin?: string
}>

/** Unknown and foreign batches are indistinguishable to the caller. */
export class BatchAccessError extends Error {
  override readonly name = 'BatchAccessError'
  constructor() {
    super('No batch with this id belongs to you.')
  }
}

/** A tool call that is replayed after a crash names the same batch instead of starting a second one. */
export const toolBatchId = (sessionKey: string, toolUseId: string): string =>
  `b${createHash('sha256').update(`${sessionKey}\u0000${toolUseId}`).digest('hex').slice(0, 12)}`
export const newBatchId = (): string => `b${randomBytes(6).toString('hex')}`
/** One durable job per item run: the first run is 0, the repair run 1. */
export const itemJobId = (batchId: string, ordinal: number, repairs: number): string =>
  `batch:${batchId}:${ordinal}:${repairs}`

type JobsServiceLike = {
  enqueue(raw: unknown, context: { local: boolean }): Promise<{ jobId: string }>
  poll(jobId: string): Promise<{
    status: string
    error?: { message: string }
    createdAt?: string
    stalledCounter?: number
  }>
  cancel(jobId: string): Promise<void>
}

export function batchJobsPort(service: JobsServiceLike): BatchJobsPort {
  return {
    enqueue: async (spec) => {
      await service.enqueue(spec, { local: true })
    },
    status: async (jobId) => {
      let job: Awaited<ReturnType<JobsServiceLike['poll']>>
      try {
        job = await service.poll(jobId)
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code === AGNES_ERRORS.SESSION_NOT_FOUND) return undefined
        throw error
      }
      const createdAt = job.createdAt === undefined ? Number.NaN : Date.parse(job.createdAt)
      return {
        status: job.status,
        ...(job.error ? { error: job.error.message } : {}),
        ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        ...(job.stalledCounter !== undefined ? { stalledCounter: job.stalledCounter } : {}),
      }
    },
    cancel: (jobId) => service.cancel(jobId).catch(() => undefined),
  }
}

/** The job queue's limit on a prompt. */
export const MAX_JOB_PROMPT_CHARS = 65_536
/** At most this much of summary.md is read back for a status. */
export const MAX_SUMMARY_READ_BYTES = 64 * 1024
const JOB_ATTEMPTS = 3
const STATUS_SUMMARY_CHARS = 4096
const STATUS_REASON_CHARS = 1024
const STATUS_PATH_CHARS = 4096
/** Calls into the worker that holds item sessions; a call that hangs must not stall every batch. */
const PORT_TIMEOUT_MS = 60_000
/** A job may wait in the queue this many item time limits (at least half an hour) before its item fails. */
const QUEUE_LIMIT_FACTOR = 6
const MIN_QUEUE_LIMIT_MS = 30 * 60_000
/** A confinement check that throws or does not answer this many ticks in a row fails the batch. */
const CONFINEMENT_ATTEMPTS = 3
const UNFINISHED_JOB: ReadonlySet<string> = new Set(['waiting', 'delayed', 'active'])
const CONFINEMENT_MISSING =
  'confinement_unavailable: the hook that limits item sessions to the read tool is not active'

const round = (n: number): number => Math.round(n * 10_000) / 10_000
const message = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof (error as { message?: unknown } | null)?.message === 'string'
      ? (error as { message: string }).message
      : String(error)
const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${clipText(text, max - 1)}…`

/**
 * Waits at most `ms` for a call. A call given up on may still finish later: `onLate` then receives
 * its result, so that whatever it made (a prepared session) can be released.
 */
function bounded<T>(promise: Promise<T>, what: string, ms: number, onLate?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let gaveUp = false
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      gaveUp = true
      reject(new Error(`${what} did not answer within ${ms / 1000} s`))
    }, ms)
    timer.unref?.()
  })
  if (onLate)
    promise.then(
      (value) => {
        if (gaveUp) onLate(value)
      },
      () => undefined,
    )
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * The finished summary.md, read without following links (neither the folder nor the file may lead
 * out of the workspace), without blocking on a pipe planted in its place, and at most 64 KiB of it.
 */
async function readSummary(batch: BatchRow): Promise<string | undefined> {
  try {
    const rootReal = await realpath(batch.root)
    const folder = await realpath(join(batch.root, ...batch.outRel.split('/')))
    if (folder === rootReal || !inside(rootReal, folder)) return undefined
    const path = join(folder, 'summary.md')
    if (!(await lstat(path)).isFile()) return undefined
    // Windows has neither flag; the lstat check above stands in for them there.
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    try {
      if (!(await handle.stat()).isFile()) return undefined
      const buffer = Buffer.alloc(MAX_SUMMARY_READ_BYTES)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      return buffer.subarray(0, length).toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

type Confinement = { kind: 'ok' } | { kind: 'fail' | 'pause'; reason: string }

type Verdict =
  | { kind: 'done'; output: unknown; credits: number }
  | { kind: 'invalid' | 'failed'; error: string; credits: number }
  | { kind: 'repair'; problem: string; credits: number }

/**
 * Runs batches: each item is one durable prompt job in its own item session. Every tick follows the
 * items in flight (settling them from their session's ledger, sending one repair, timing them out),
 * stops a batch on cancel, budget, confinement loss or early failures, starts pending items up to the
 * batch's concurrency, and writes the result files when the batch ends. All state lives in the batch
 * and job tables, so a new engine on the same tables carries on where a stopped one left off.
 */
export class BatchEngine {
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking: Promise<void> = Promise.resolve()
  private busy = false
  private stopped = false
  private resumed = false
  /** When this engine took over; queue time before it (a stopped daemon) is not held against an item. */
  private since = 0
  private sweepNeeded = true
  private confinementFailures = 0
  private lock: Promise<unknown> = Promise.resolve()
  private readonly checks = new Map<string, OutputCheck>()
  private readonly reported = new Map<string, string>()
  /** Jobs found active when this engine took over (by their reclaim count): held by a stopped process. */
  private readonly abandoned = new Map<string, number | undefined>()

  constructor(private readonly o: BatchEngineOptions) {}

  /**
   * Runs the first tick: items left in flight get fresh time limits, jobs a stopped process held are
   * recognised, unfinished clean-ups are completed and the item confinement is checked. The daemon
   * awaits this before it starts the job scheduler, so no batch job is claimed before that.
   */
  async ready(): Promise<void> {
    await this.tick()
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => {
      // A slow tick (a large export) is not queued up behind: the next interval simply skips.
      if (this.busy) return
      this.busy = true
      this.ticking = this.tick()
        .catch((error: unknown) => this.o.log?.(message(error)))
        .finally(() => {
          this.busy = false
        })
    }, this.o.tickMs)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.ticking
  }

  async begin(input: BatchBegin): Promise<BatchStatus> {
    const existing = this.o.repo.get(input.batchId)
    if (existing) return this.view(this.ownedRow(existing, input.principalId))
    const resolved = resolveSpec(input)
    const items = await enumerateItems({
      root: input.root,
      dirAbs: resolved.dirAbs,
      outAbs: resolved.outAbs,
      ...(resolved.spec.ext ? { ext: resolved.spec.ext } : {}),
    })
    if (!items.some((item) => item.skip === undefined))
      throw new BatchSpecError(
        'dir holds no supported files (images: png, jpg, jpeg; text: txt, md, csv, tsv, json, jsonl, log, xml, yaml, yml)',
      )
    const created = this.o.repo.create(
      {
        id: input.batchId,
        principalId: input.principalId,
        root: input.root,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        spec: resolved.spec,
        dirRel: resolved.dirRel,
        outRel: resolved.outRel,
        concurrency: resolved.concurrency,
        itemTimeoutMs: resolved.itemTimeoutMs,
        createdAt: this.o.clock(),
      },
      items,
    )
    const batch = this.o.repo.get(input.batchId) as BatchRow
    // A simultaneous start with the same id got there first.
    if (!created) return this.view(this.ownedRow(batch, input.principalId))
    this.o.audit?.({
      kind: 'batch.started',
      detail: {
        batchId: input.batchId,
        principal: input.principalId,
        origin: input.origin ?? null,
        dir: resolved.dirRel,
        items: items.length,
        concurrency: resolved.concurrency,
        budgetCredits: resolved.spec.budgetCredits ?? null,
        approval: 'none',
      },
    })
    return this.view(batch)
  }

  /**
   * Counts and spend. A finished batch also gets its result files and summary; a running one only
   * with `exportNow`, which writes the files from the table first. Finished files that are missing
   * are written again only on request.
   */
  async status(principalId: string, batchId: string, exportNow = false): Promise<BatchStatus> {
    const batch = this.owned(principalId, batchId)
    if (batch.status === 'running')
      return exportNow
        ? this.view(batch, await exportBatch({ repo: this.o.repo, batch, now: this.o.clock() }))
        : this.view(batch)
    // A summary that does not state the final status is from an export made while the batch ran:
    // the one at its end failed, so the files are not reported as written.
    const summary = await readSummary(batch)
    const status = summary?.split('\n', 3)[2]
    if (status === `- Status: ${batch.status}` || status?.startsWith(`- Status: ${batch.status} (`))
      return this.view(batch, { files: this.files(batch), summary: summary as string })
    if (!exportNow) return this.view(batch)
    return this.view(batch, await exportBatch({ repo: this.o.repo, batch, now: this.o.clock() }))
  }

  async cancel(principalId: string, batchId: string): Promise<BatchStatus> {
    this.owned(principalId, batchId)
    await this.exclusive(async () => {
      const batch = this.o.repo.get(batchId)
      if (batch?.status === 'running') await this.finish(batch, 'cancelled', 'cancelled by request')
    })
    return this.status(principalId, batchId)
  }

  list(principalId: string): BatchStatus[] {
    return this.o.repo.listFor(principalId, 20).map((batch) => this.view(batch))
  }

  async tick(): Promise<void> {
    if (this.stopped) return
    await this.exclusive(async () => {
      if (this.stopped) return
      if (!this.resumed) await this.resume()
      // Asked at most once per tick, and only when some batch has items to run.
      let confinement: Promise<Confinement> | undefined
      const confined = () => (confinement ??= this.checkConfinement())
      for (const batch of this.o.repo.running()) {
        try {
          await this.advance(batch.id, confined)
        } catch (error) {
          this.report(batch.id, error)
        }
      }
      // Only at start, after a batch ended, or after a clean-up failed: not a scan of every old batch.
      if (this.sweepNeeded) {
        this.sweepNeeded = false
        for (const batch of this.o.repo.unsettledFinished()) {
          try {
            await this.cleanUp(batch.id)
          } catch (error) {
            this.sweepNeeded = true
            this.report(batch.id, error)
          }
        }
      }
    })
  }

  /** Ticks, cancels and their clean-up never interleave: a batch is changed by one of them at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn)
    this.lock = run.catch(() => undefined)
    return run
  }

  /**
   * Items in flight when this engine starts were left by a stopped process, which may have been down
   * for longer than their time limit: they get a fresh one instead of timing out at once. A job still
   * active now is held by that process until its lease runs out and the scheduler reclaims it; until
   * then it is not running, so it is treated as queued.
   */
  private async resume(): Promise<void> {
    this.resumed = true
    const now = this.o.clock()
    this.since = now
    for (const batch of this.o.repo.running())
      for (const item of this.o.repo.inflight(batch.id)) {
        if (!item.jobId || !item.sessionKey) continue
        this.o.repo.markRunning(batch.id, item.ordinal, {
          jobId: item.jobId,
          sessionKey: item.sessionKey,
          repairs: item.repairs,
          startedAt: now,
        })
        const job = await this.o.jobs.status(item.jobId).catch(() => undefined)
        if (job?.status === 'active') this.abandoned.set(item.jobId, job.stalledCounter)
      }
  }

  /**
   * `false` fails the batch at once. A check that throws or does not answer pauses the starting of
   * new jobs (nothing is cancelled) and is tried again on the next ticks; only a run of failures
   * fails the batch.
   */
  private async checkConfinement(): Promise<Confinement> {
    try {
      const ready = await bounded(
        this.o.host.itemConfinementReady(),
        'the confinement check',
        this.portTimeout,
      )
      this.confinementFailures = 0
      return ready ? { kind: 'ok' } : { kind: 'fail', reason: CONFINEMENT_MISSING }
    } catch (error) {
      this.confinementFailures++
      const reason = `confinement_unavailable: ${message(error)}`
      return { kind: this.confinementFailures >= CONFINEMENT_ATTEMPTS ? 'fail' : 'pause', reason }
    }
  }

  private get portTimeout(): number {
    return this.o.portTimeoutMs ?? PORT_TIMEOUT_MS
  }

  private async advance(id: string, confined: () => Promise<Confinement>): Promise<void> {
    const now = this.o.clock()
    const before = this.o.repo.get(id)
    if (before?.status !== 'running') return
    const unsettled = this.o.repo.counts(id)
    // Checked before any job is written this tick: no confinement, no new job (a repair included).
    const confinement: Confinement =
      unsettled.pending + unsettled.running > 0 ? await confined() : { kind: 'ok' }
    const send = confinement.kind === 'ok'
    for (const item of this.o.repo.inflight(id)) await this.followSafely(before, item, now, send)
    const batch = this.o.repo.get(id) as BatchRow
    if (confinement.kind === 'fail') return this.finish(batch, 'failed', confinement.reason)
    let counts = this.o.repo.counts(id)
    // A run stopped by its turn budget shows that what is left cannot pay for one item: the budget
    // is spent then too, and items that fail on it do not make the batch a failure.
    const budget = batch.spec.budgetCredits
    const outrun = budget !== undefined && counts.failed > 0 && this.o.repo.hasFailure(id, 'turn_budget')
    if (!outrun && counts.done === 0 && counts.failed + counts.invalid >= FAIL_FAST_ITEMS)
      return this.finish(
        batch,
        'failed',
        `the first ${FAIL_FAST_ITEMS} items all failed (${this.o.repo.commonError(id) ?? 'unknown error'})`,
      )
    if (confinement.kind === 'pause') return this.report(id, confinement.reason)
    // A spent budget stops items from starting; a batch with none left to start simply completes.
    // A remainder that a job would carry as 0 is spent too.
    if (budget !== undefined && (outrun || round(budget - batch.spent) <= 0) && counts.pending > 0) {
      if (counts.running === 0)
        await this.finish(
          batch,
          'budget_exhausted',
          `spent ${round(batch.spent)} of ${budget} credits${outrun ? "; a file's run was stopped by the remaining budget" : ''}`,
        )
      return
    }
    // The batch's concurrency is held here: a job is written only for an item that takes a free slot.
    const free = batch.concurrency - counts.running
    if (free > 0 && counts.pending > 0)
      for (const item of this.o.repo.nextPending(id, free)) await this.admit(batch, item)
    counts = this.o.repo.counts(id)
    if (counts.pending === 0 && counts.running === 0) await this.finish(batch, 'completed')
  }

  private late(batch: BatchRow, item: ItemRow, now: number): boolean {
    return item.startedAt !== undefined && now - item.startedAt > batch.itemTimeoutMs
  }

  private queueLimit(batch: BatchRow): number {
    return Math.max(batch.itemTimeoutMs * QUEUE_LIMIT_FACTOR, MIN_QUEUE_LIMIT_MS)
  }

  /** An item whose outcome cannot be read keeps being tried until its time limit, then fails. */
  private async followSafely(batch: BatchRow, item: ItemRow, now: number, send: boolean): Promise<void> {
    try {
      await this.follow(batch, item, now, send)
    } catch (error) {
      if (!this.late(batch, item, now)) return this.report(`${batch.id}:${item.ordinal}`, error)
      this.settle(batch, item, 'failed', {
        error: `outcome_unavailable: ${message(error)}`,
        credits: await this.credits(item.sessionKey),
      })
    }
  }

  private async admit(batch: BatchRow, item: ItemRow): Promise<void> {
    const prompt = this.firstPrompt(batch, item)
    if (prompt.length > MAX_JOB_PROMPT_CHARS)
      return this.settle(batch, item, 'failed', {
        error: `prompt_too_long: the item prompt has ${prompt.length} characters; a job takes at most ${MAX_JOB_PROMPT_CHARS}`,
      })
    const sessionKey = itemSessionKey(this.o.profileName, batch.id, item.ordinal)
    try {
      await bounded(
        this.o.sessions.prepare({ sessionKey, principalId: itemPrincipal(batch.id), root: batch.root }),
        'the item session',
        this.portTimeout,
        () => this.release(sessionKey),
      )
    } catch (error) {
      return this.settle(batch, item, 'failed', { error: `session_unavailable: ${message(error)}` })
    }
    const jobId = itemJobId(batch.id, item.ordinal, 0)
    // False when the item changed meanwhile (a cancel): then no job is written for it, and the
    // session just prepared is closed rather than left to the worker.
    if (
      !this.o.repo.markRunning(batch.id, item.ordinal, {
        jobId,
        sessionKey,
        repairs: 0,
        startedAt: this.o.clock(),
      })
    )
      return this.release(sessionKey)
    await this.send(batch, { ...item, sessionKey }, jobId, prompt, 0)
  }

  /** Writes an item's job; an item whose job the queue refuses fails instead of being retried forever. */
  private async send(
    batch: BatchRow,
    item: ItemRow,
    jobId: string,
    prompt: string,
    credits?: number,
  ): Promise<void> {
    let failure: string | undefined
    if (prompt.length > MAX_JOB_PROMPT_CHARS) failure = `prompt_too_long: ${prompt.length} characters`
    else
      try {
        await this.o.jobs.enqueue(this.job(batch, jobId, item.sessionKey as string, prompt))
      } catch (error) {
        failure = `enqueue_failed: ${message(error)}`
        // Should the queue have kept the job after all, it must not run for an item that is over.
        await this.o.jobs.cancel(jobId).catch(() => undefined)
      }
    if (failure !== undefined)
      this.settle(batch, item, 'failed', { error: failure, ...(credits !== undefined ? { credits } : {}) })
  }

  private async follow(batch: BatchRow, item: ItemRow, now: number, send: boolean): Promise<void> {
    const { jobId, sessionKey } = item
    if (!jobId || !sessionKey) return this.settle(batch, item, 'failed', { error: 'lost_job' })
    const job = await this.o.jobs.status(jobId)
    if (!job) {
      if (!send) return
      // Recorded as running, but the process stopped before the job was written: write it now, with
      // the same job id (never a second job) and a fresh time limit.
      const prompt =
        item.repairs === 0 ? this.firstPrompt(batch, item) : await this.lostRepairPrompt(batch, item)
      if (
        !this.o.repo.markRunning(batch.id, item.ordinal, {
          jobId,
          sessionKey,
          repairs: item.repairs,
          startedAt: now,
        })
      )
        return
      return this.send(batch, item, jobId, prompt)
    }
    if (UNFINISHED_JOB.has(job.status)) {
      // A job held by a stopped process stays treated as queued until the scheduler reclaims it.
      if (
        this.abandoned.has(jobId) &&
        (job.status !== 'active' || job.stalledCounter !== this.abandoned.get(jobId))
      )
        this.abandoned.delete(jobId)
      if (job.status !== 'active' || this.abandoned.has(jobId)) {
        // Only running time counts toward the item limit: while queued it starts again each tick.
        // The queue wait itself has a separate, generous limit.
        const queuedSince = Math.max(job.createdAt ?? now, this.since)
        if (now - queuedSince > this.queueLimit(batch)) {
          await this.o.jobs.cancel(jobId)
          return this.settle(batch, item, 'failed', {
            error: 'queue_timeout',
            credits: await this.credits(sessionKey),
          })
        }
        if (item.startedAt !== now)
          this.o.repo.markRunning(batch.id, item.ordinal, {
            jobId,
            sessionKey,
            repairs: item.repairs,
            startedAt: now,
          })
        return
      }
      if (!this.late(batch, item, now)) return
      await this.o.jobs.cancel(jobId)
      return this.settle(batch, item, 'failed', { error: 'timeout', credits: await this.credits(sessionKey) })
    }
    if (job.status !== 'completed')
      return this.settle(batch, item, 'failed', {
        error:
          job.status === 'cancelled' && this.late(batch, item, now)
            ? 'timeout'
            : `job_${job.status}${job.error ? `: ${job.error}` : ''}`,
        credits: await this.credits(sessionKey),
      })
    const verdict = this.evaluate(
      batch,
      item,
      await bounded(this.o.sessions.transcript(sessionKey), 'the item ledger', this.portTimeout),
    )
    if (verdict.kind === 'repair') {
      // A repair is a new job: none while the confinement is unconfirmed (the item waits), and none
      // with nothing left of the budget (the answer stands as invalid).
      if (!send) return
      const budget = batch.spec.budgetCredits
      if (budget !== undefined && round(budget - (this.o.repo.get(batch.id)?.spent ?? batch.spent)) <= 0)
        return this.settle(batch, item, 'invalid', {
          error: `budget_exhausted_before_repair: ${verdict.problem}`,
          credits: verdict.credits,
        })
      const repairJob = itemJobId(batch.id, item.ordinal, item.repairs + 1)
      if (
        !this.o.repo.markRunning(batch.id, item.ordinal, {
          jobId: repairJob,
          sessionKey,
          repairs: item.repairs + 1,
          startedAt: now,
        })
      )
        return
      return this.send(
        batch,
        item,
        repairJob,
        repairPrompt(verdict.problem, batch.spec.schema),
        verdict.credits,
      )
    }
    if (verdict.kind === 'done')
      return this.settle(batch, item, 'done', { output: verdict.output, credits: verdict.credits })
    return this.settle(batch, item, verdict.kind, { error: verdict.error, credits: verdict.credits })
  }

  /** What the item session's ledger shows: an accepted answer, a failure, or one repair to ask for. */
  private evaluate(batch: BatchRow, item: ItemRow, transcript: readonly EventEnvelope[]): Verdict {
    const outcome = readOutcome(transcript, item, batch.root)
    if (outcome.kind === 'failed') return { kind: 'failed', error: outcome.error, credits: outcome.credits }
    if (batch.spec.schema === undefined)
      return { kind: 'done', output: { text: outcome.text }, credits: outcome.credits }
    const parsed = parseReply(outcome.text)
    const problem = parsed.ok ? this.check(batch)(parsed.value) : parsed.problem
    if (parsed.ok && problem === undefined)
      return { kind: 'done', output: parsed.value, credits: outcome.credits }
    const reason = problem ?? 'the reply does not match the schema'
    if (item.repairs >= 1)
      return {
        kind: 'invalid',
        error: `invalid_output: ${reason}${REPLY_MARK}${clip(outcome.text, 500)}`,
        credits: outcome.credits,
      }
    return { kind: 'repair', problem: reason, credits: outcome.credits }
  }

  /** The repair prompt of a repair job that was recorded but never written, rebuilt from the ledger. */
  private async lostRepairPrompt(batch: BatchRow, item: ItemRow): Promise<string> {
    let problem = 'the previous reply was not accepted'
    try {
      const transcript = await bounded(
        this.o.sessions.transcript(item.sessionKey as string),
        'the item ledger',
        this.portTimeout,
      )
      const verdict = this.evaluate(batch, { ...item, repairs: 0 }, transcript)
      if (verdict.kind === 'repair') problem = verdict.problem
    } catch {
      // The generic problem still asks for a reply that matches the schema.
    }
    return repairPrompt(problem, batch.spec.schema)
  }

  private firstPrompt(batch: BatchRow, item: ItemRow): string {
    return itemPrompt({
      item: { ordinal: item.ordinal, path: item.path, kind: item.kind },
      template: batch.spec.prompt,
      ...(batch.spec.schema !== undefined ? { schema: batch.spec.schema } : {}),
      ...(batch.spec.maxEdge !== undefined ? { maxEdge: batch.spec.maxEdge } : {}),
    })
  }

  private job(batch: BatchRow, jobId: string, sessionKey: string, prompt: string): JobSpec {
    const budget = batch.spec.budgetCredits
    const spent = this.o.repo.get(batch.id)?.spent ?? batch.spent
    return {
      idempotencyKey: jobId,
      sessionKey,
      payload: { prompt },
      schedule: { kind: 'once' },
      maxAttempts: JOB_ATTEMPTS,
      ...(budget !== undefined ? { budget: round(Math.max(budget - spent, 0)) } : {}),
    }
  }

  private check(batch: BatchRow): OutputCheck {
    let check = this.checks.get(batch.id)
    if (!check) {
      check = compileOutputSchema(batch.spec.schema)
      this.checks.set(batch.id, check)
    }
    return check
  }

  private async credits(sessionKey: string | undefined): Promise<number | undefined> {
    if (!sessionKey) return undefined
    try {
      return creditsOf(
        await bounded(this.o.sessions.transcript(sessionKey), 'the item ledger', this.portTimeout),
      )
    } catch {
      return undefined
    }
  }

  /**
   * Settles an item for good and closes its session (errors ignored, not awaited: a worker that does
   * not answer must not hold the batch up). A repair is recorded with markRunning instead.
   */
  private settle(
    batch: BatchRow,
    item: ItemRow,
    status: 'done' | 'invalid' | 'failed' | 'cancelled',
    result: { output?: unknown; error?: string; credits?: number | undefined },
  ): void {
    const settled = this.o.repo.settle(batch.id, item.ordinal, {
      status,
      ...(result.output !== undefined ? { output: result.output } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.credits !== undefined ? { credits: result.credits } : {}),
    })
    this.reported.delete(`${batch.id}:${item.ordinal}`)
    if (item.jobId) this.abandoned.delete(item.jobId)
    if (settled && item.sessionKey) this.release(item.sessionKey)
  }

  private release(sessionKey: string): void {
    try {
      void this.o.sessions.release(sessionKey).catch(() => undefined)
    } catch {
      // Closing is best effort; an idle session is closed by the worker later anyway.
    }
  }

  /**
   * Records the outcome first, then cleans up. A process that stops in between leaves a finished
   * batch with items still pending or running; the next tick finds it and finishes the clean-up.
   */
  private async finish(
    batch: BatchRow,
    status: Exclude<BatchState, 'running'>,
    reason?: string,
  ): Promise<void> {
    this.o.repo.setStatus(batch.id, status, reason)
    this.sweepNeeded = true
    await this.cleanUp(batch.id)
  }

  private async cleanUp(id: string): Promise<void> {
    const batch = this.o.repo.get(id)
    if (!batch || batch.status === 'running') return
    for (const item of this.o.repo.inflight(id)) {
      if (item.jobId) await this.o.jobs.cancel(item.jobId)
      // What the item already cost (a first turn before its repair, a turn lost to a crash) stays billed.
      this.settle(batch, item, 'cancelled', {
        error: batch.reason ?? batch.status,
        credits: await this.credits(item.sessionKey),
      })
    }
    this.o.repo.cancelPending(id, batch.status === 'completed' ? 'not_started' : batch.status)
    this.checks.delete(id)
    for (const key of this.reported.keys())
      if (key === id || key.startsWith(`${id}:`)) this.reported.delete(key)
    await exportBatch({ repo: this.o.repo, batch: this.o.repo.get(id) ?? batch, now: this.o.clock() }).catch(
      (error: unknown) => this.o.log?.(`batch ${id} export failed: ${message(error)}`),
    )
  }

  /** Logs a problem once until it changes, so a batch that keeps hitting it does not flood the log. */
  private report(key: string, error: unknown): void {
    const text = message(error)
    if (this.reported.get(key) === text) return
    this.reported.set(key, text)
    this.o.log?.(`batch ${key}: ${text}`)
  }

  private owned(principalId: string, batchId: string): BatchRow {
    const batch = this.o.repo.get(batchId)
    if (!batch) throw new BatchAccessError()
    return this.ownedRow(batch, principalId)
  }

  private ownedRow(batch: BatchRow, principalId: string): BatchRow {
    if (batch.principalId !== principalId) throw new BatchAccessError()
    return batch
  }

  private files(batch: BatchRow): string[] {
    return RESULT_FILES.map((name) => `${batch.outRel}/${name}`).filter(
      (path) => path.length <= STATUS_PATH_CHARS,
    )
  }

  private view(batch: BatchRow, extra: { files?: readonly string[]; summary?: string } = {}): BatchStatus {
    const counts = this.o.repo.counts(batch.id)
    const total = ITEM_STATES.reduce((sum, state) => sum + counts[state], 0)
    return {
      batchId: batch.id,
      status: batch.status,
      dir: clip(batch.dirRel || '.', STATUS_PATH_CHARS),
      outDir: clip(batch.outRel, STATUS_PATH_CHARS),
      createdAt: new Date(batch.createdAt).toISOString(),
      updatedAt: new Date(batch.updatedAt).toISOString(),
      counts: { total, ...counts },
      spentCredits: round(batch.spent),
      ...(batch.spec.budgetCredits !== undefined ? { budgetCredits: batch.spec.budgetCredits } : {}),
      ...(batch.reason !== undefined ? { reason: clip(batch.reason, STATUS_REASON_CHARS) } : {}),
      ...(extra.files ? { files: extra.files.filter((path) => path.length <= STATUS_PATH_CHARS) } : {}),
      ...(extra.summary !== undefined ? { summary: clip(extra.summary, STATUS_SUMMARY_CHARS) } : {}),
    }
  }
}
