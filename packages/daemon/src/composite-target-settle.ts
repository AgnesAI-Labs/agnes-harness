import type { CompositeTargetStore } from './storage/composite-target-store.js'

export type SettleOptions = Readonly<{
  timeoutMs: number
  intervalMs?: number
  /** False when nothing can reach a worker any more, so waiting would only be waiting. */
  deliverable?: () => boolean
  workerGeneration?: () => number | undefined
  signal?: AbortSignal
}>

export type SettleResult = 'converged' | 'failed' | 'superseded' | 'undeliverable' | 'aborted' | 'timeout'

const DEFAULT_INTERVAL_MS = 100

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits for the fate of a target that was just published: confirmed by a worker, failed (and possibly
 * already put back), or replaced. Never throws; running out of time is an answer too.
 */
export async function settle(
  store: CompositeTargetStore,
  digest: string,
  options: SettleOptions,
): Promise<SettleResult> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const desired = store.desired()?.digest
    const ack = store.acknowledged()
    const generation = options.workerGeneration?.()
    if (
      desired === digest &&
      ack?.digest === digest &&
      (options.workerGeneration === undefined || (generation !== undefined && ack.generation === generation))
    )
      return 'converged'
    if (store.lastFailure()?.digest === digest || store.revertedFrom(digest) !== undefined) return 'failed'
    if (desired !== digest) return 'superseded'
    if (options.deliverable && !options.deliverable()) return 'undeliverable'
    if (options.signal?.aborted) return 'aborted'
    if (Date.now() >= deadline) return 'timeout'
    await pause(Math.min(interval, Math.max(1, deadline - Date.now())))
  }
}

/** Waits until nothing published is still waiting to be confirmed, or gives up. */
export async function idle(store: CompositeTargetStore, options: SettleOptions): Promise<void> {
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    const generation = options.workerGeneration?.()
    if (
      !store.pending(generation) &&
      !(options.workerGeneration !== undefined && generation === undefined && store.desired())
    )
      return
    if (options.deliverable && !options.deliverable()) return
    if (options.signal?.aborted) return
    if (Date.now() >= deadline) return
    await pause(Math.min(interval, Math.max(1, deadline - Date.now())))
  }
}
