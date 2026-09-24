import { type JobSpec, type JobStatus, rpcError, toRpcError, validateJobSpec } from '@agnes/protocol'
import type { JobsPort } from '../local/ports.js'
import type { JobsRepo } from './repo.js'
import { nextRunAt } from './schedule.js'

type JobsServiceOptions = {
  repo: JobsRepo
  profileHash: string
  clock: () => number
  protectedNames?: (spec: JobSpec) => boolean
  onCancel?: (jobId: string) => void
}
type JobResult = Exclude<JobStatus['result'], undefined>

export class JobsService implements JobsPort {
  constructor(private readonly options: JobsServiceOptions) {}

  async enqueue(raw: unknown, context: { local: boolean }): Promise<{ jobId: string }> {
    const validated = validateJobSpec(raw)
    if (!validated.ok) throw toRpcError(validated.errors)
    const spec = validated.value
    const isProtected = spec.protected === true || this.options.protectedNames?.(spec) === true
    if (isProtected && !context.local) {
      throw rpcError('CAPABILITY_DENIED', { reason: 'protected jobs are local-only' })
    }

    const now = this.options.clock()
    let delayUntil: number | null
    try {
      delayUntil = nextRunAt(spec.schedule, now)
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', {
        reason: error instanceof Error ? error.message : 'invalid job schedule',
      })
    }
    if (delayUntil === null) {
      throw rpcError('SEMANTIC_REJECTED', { reason: 'cron never matches within 366 days' })
    }

    this.options.repo.insert({
      idempotencyKey: spec.idempotencyKey,
      sessionKey: spec.sessionKey,
      profileHash: this.options.profileHash,
      payload: spec.payload,
      schedule: spec.schedule,
      status: 'waiting',
      attempts: 0,
      maxAttempts: spec.maxAttempts ?? 3,
      backoffMs: 1_000,
      delayUntil,
      stalledCounter: 0,
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      protected: isProtected,
      createdAt: now,
      updatedAt: now,
    })
    return { jobId: spec.idempotencyKey }
  }

  async sessionKey(jobId: string): Promise<string | undefined> {
    return this.options.repo.get(jobId)?.sessionKey
  }

  async poll(jobId: string): Promise<JobStatus> {
    const job = this.options.repo.get(jobId)
    if (!job) throw rpcError('SESSION_NOT_FOUND', { jobId })
    return {
      jobId,
      status: job.status,
      attempts: job.attempts,
      delayUntil: job.delayUntil,
      ...(job.leaseUntil !== undefined ? { leaseUntil: job.leaseUntil } : {}),
      stalledCounter: job.stalledCounter,
      ...(job.result !== undefined ? { result: job.result as JobResult } : {}),
      ...(job.error !== undefined
        ? { error: { code: job.status === 'dead' ? 'JOB_DEAD' : 'JOB_FAILED', message: job.error } }
        : {}),
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.updatedAt).toISOString(),
    }
  }

  async cancel(jobId: string): Promise<void> {
    const active = this.options.repo.get(jobId)?.status === 'active'
    const result = this.options.repo.cancel(jobId)
    if (result === 'not-found') throw rpcError('SESSION_NOT_FOUND', { jobId })
    if (result === 'cancelled' && active) this.options.onCancel?.(jobId)
  }
}
