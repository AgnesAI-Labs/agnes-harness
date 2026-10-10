import { rpcError, type RpcError } from '@agnes/protocol'

export function isWorkerBootBlocked(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    (error as { data?: { code?: unknown } }).data?.code === 'WORKER_BOOT_BLOCKED'
  )
}

/** Consecutive deterministic pre-hello refusals, shared by every acquirer of a worker identity. */
export class WorkerBootFailures {
  epoch = 0
  private readonly failures = new Map<string, { code: string; count: number }>()
  private readonly resetListeners = new Set<() => void>()

  blocked(key: string): RpcError | undefined {
    const failure = this.failures.get(key)
    if (!failure || failure.count < 3) return
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

  record(key: string, code: string | undefined, epoch: number): void {
    if (epoch !== this.epoch) return
    if (!code) {
      this.failures.delete(key)
      return
    }
    const previous = this.failures.get(key)
    this.failures.set(key, { code, count: previous?.code === code ? previous.count + 1 : 1 })
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
