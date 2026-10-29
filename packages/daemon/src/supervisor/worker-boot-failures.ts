import {
  publicErrorContract,
  publicErrorReason,
  publicRejectionRpc,
  type RpcError,
  rpcError,
} from '@agnes/protocol'
import { workerBootFailureCode } from '@agnes/worker-runtime'

// Keep actionable RPC codes while the in-process keeper still recognizes a latched refusal.
const blockedRefusals = new WeakSet<object>()

export function isWorkerBootBlocked(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (blockedRefusals.has(error) ||
      (error as { data?: { code?: unknown } }).data?.code === 'WORKER_BOOT_BLOCKED')
  )
}

/** Consecutive deterministic pre-hello refusals, shared by every acquirer of a worker identity. */
export class WorkerBootFailures {
  epoch = 0
  private readonly failures = new Map<string, { code: string; reason?: string; count: number }>()
  private readonly resetListeners = new Set<() => void>()

  start(key: string) {
    const epoch = this.epoch
    let refusal: { code: string; reason?: string } | undefined
    return {
      get code() {
        return refusal?.code
      },
      observe(message: unknown) {
        if (!message || typeof message !== 'object') return
        const frame = message as { kind?: unknown; code?: unknown; reason?: unknown }
        if (frame.kind !== 'worker-boot-failure') return
        const code = workerBootFailureCode(frame.code)
        const reason = code ? publicErrorReason({ code, reason: frame.reason }) : undefined
        refusal = code ? { code, ...(reason ? { reason } : {}) } : undefined
      },
      record: () => this.record(key, refusal?.code, epoch, refusal?.reason),
      failure: (error: Error) => this.blocked(key) ?? publicRejectionRpc(refusal) ?? error,
    }
  }

  blocked(key: string): RpcError | undefined {
    const failure = this.failures.get(key)
    if (!failure || failure.count < 3) return
    const refusal = publicRejectionRpc({ code: failure.code, reason: failure.reason })
    if (publicErrorContract(failure.code)?.rpc !== 'INTERNAL_ERROR' && refusal) {
      blockedRefusals.add(refusal)
      return refusal
    }
    return {
      ...rpcError('INTERNAL_ERROR', {
        code: 'WORKER_BOOT_BLOCKED',
        workerKey: key,
        bootCode: failure.code,
        failures: failure.count,
        retryable: false,
      }),
      message: `Worker ${key} boot blocked after ${failure.count} consecutive ${failure.code} failures; change configuration or packages, or explicitly retry.`,
    }
  }

  record(key: string, code: string | undefined, epoch: number, reason?: string): void {
    if (epoch !== this.epoch) return
    if (!code) {
      this.failures.delete(key)
      return
    }
    const previous = this.failures.get(key)
    this.failures.set(key, {
      code,
      ...(reason ? { reason } : {}),
      count: previous?.code === code && previous.reason === reason ? previous.count + 1 : 1,
    })
  }

  succeeded(key: string): void {
    this.failures.delete(key)
  }

  reset(): void {
    this.epoch++
    this.failures.clear()
    for (const listener of this.resetListeners) listener()
  }

  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => {
      this.resetListeners.delete(listener)
    }
  }
}
