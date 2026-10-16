import { createHash } from 'node:crypto'
import type { PluginWakeBinding } from '@agnes/host-extensions/profile/wakes'
import type { BoundWakeEnqueueParams, BoundWakeReceipt } from '@agnes/protocol'
import { inspectJsonData, jcs, rpcError, validateAgainst } from '@agnes/protocol'
import { BoundWakeEnqueueParams as EnqueueSchema } from '@agnes/protocol/gen/extension-service'
import type { JobRow, JobsRepo } from './repo.js'

export type BoundWakeTarget = { binding: PluginWakeBinding; active: boolean }
/** A narrow producer port over the ordinary durable jobs queue; no arbitrary prompt/command. */
export class BoundWakeService {
  constructor(
    private readonly deps: {
      repo: JobsRepo
      profileHash: string
      clock(): number
      resolve(bindingId: string, credential: unknown): Promise<BoundWakeTarget>
    },
  ) {}
  async enqueue(raw: BoundWakeEnqueueParams, credential: unknown): Promise<BoundWakeReceipt> {
    const checked = inspectJsonData(raw, 65536)
    if (!checked.ok || !validateAgainst(EnqueueSchema, checked.value).ok) throw rpcError('INVALID_PARAMS')
    const input = JSON.parse(jcs(checked.value)) as BoundWakeEnqueueParams
    const { binding, active } = await this.deps.resolve(input.target.bindingId, credential)
    const wakeId = `wake:${createHash('sha256')
      .update(jcs({ owner: binding.producerOwner, bindingId: binding.bindingId, key: input.idempotencyKey }))
      .digest('hex')}`
    const previous = this.deps.repo.get(wakeId)
    const now = this.deps.clock()
    this.deps.repo.insert({
      idempotencyKey: wakeId,
      sessionKey: binding.sessionId,
      profileHash: previous?.profileHash ?? this.deps.profileHash,
      payload: {
        pluginNotification: {
          bindingId: binding.bindingId,
          event: input.event,
          delivery: input.delivery ?? 'next-turn',
        },
      },
      schedule: { kind: 'once' },
      status: active ? 'waiting' : 'completed',
      attempts: 0,
      maxAttempts: 8,
      backoffMs: 1000,
      delayUntil: now,
      stalledCounter: 0,
      protected: true,
      ...(active ? {} : { result: { reason: 'refused', code: 'TARGET_REVOKED' } }),
      createdAt: now,
      updatedAt: now,
    })
    return this.read(wakeId, credential)
  }
  async read(wakeId: string, credential: unknown): Promise<BoundWakeReceipt> {
    if (typeof wakeId !== 'string' || !/^wake:[a-f0-9]{64}$/.test(wakeId)) throw rpcError('INVALID_PARAMS')
    const row = this.deps.repo.get(wakeId)
    if (!row || !('pluginNotification' in row.payload)) throw rpcError('CAPABILITY_DENIED')
    await this.deps.resolve(row.payload.pluginNotification.bindingId, credential)
    const result = row.result as { reason?: string; code?: string } | undefined
    return {
      wakeId,
      state:
        result?.reason === 'delivered'
          ? 'delivered'
          : result?.reason === 'refused' || ['dead', 'failed', 'cancelled'].includes(row.status)
            ? 'refused'
            : 'queued',
      ...(result?.code ? { code: result.code } : {}),
    }
  }
}

/** Scheduler dispatch holds its existing activation barrier through validation and input commit. */
export async function deliverBoundWake(
  job: JobRow,
  signal: AbortSignal,
  deps: {
    requireTarget(bindingId: string): Promise<PluginWakeBinding>
    deliver(
      binding: PluginWakeBinding,
      commandId: string,
      event: { name: string; summary: string; data?: import('@agnes/protocol').JsonValue },
      signal: AbortSignal,
    ): Promise<number>
  },
): Promise<{ reason: string; seq?: number; code?: string }> {
  if (!('pluginNotification' in job.payload)) throw rpcError('INVALID_PARAMS')
  const payload = job.payload.pluginNotification
  let binding: PluginWakeBinding
  try {
    binding = await deps.requireTarget(payload.bindingId)
  } catch (error) {
    if ((error as { data?: { code?: string } })?.data?.code === 'CAPABILITY_DENIED')
      return { reason: 'refused', code: 'TARGET_REVOKED' }
    throw error
  }
  if (binding.sessionId !== job.sessionKey) return { reason: 'refused', code: 'TARGET_CHANGED' }
  signal.throwIfAborted()
  try {
    // Delivery always falls back to next-turn. A notification never becomes a user approval.
    const seq = await deps.deliver(binding, job.idempotencyKey, payload.event, signal)
    return { reason: 'delivered', seq }
  } catch (error) {
    const code = (error as { data?: { code?: string } })?.data?.code
    if (['CAPABILITY_DENIED', 'SESSION_NOT_FOUND', 'WAKE_TARGET_REVOKED'].includes(code ?? ''))
      return { reason: 'refused', code: 'TARGET_REVOKED' }
    throw error
  }
}
