import { isWorkerBootBlocked } from './worker-boot-failures.js'
import type { WorkerLink } from './worker-link.js'

export type SharedWorkerKeeper = Readonly<{ close(): void }>

/**
 * Keeps the shared business worker up from daemon start, instead of waiting for the first session
 * to ask for it. A failed start or an exit is retried after 1 s, 2 s, ... capped at 30 s, so a
 * transient failure keeps backing off; deterministic boot refusals stop until inputs change.
 * A worker that stayed up for the cap resets the delay.
 */
export function keepSharedWorker(o: {
  acquire(): Promise<WorkerLink>
  onRetry?: (listener: () => void) => () => void
  clock?: () => number
  log?: Pick<Console, 'warn'>
  minDelayMs?: number
  maxDelayMs?: number
}): SharedWorkerKeeper {
  const clock = o.clock ?? Date.now
  const minDelayMs = o.minDelayMs ?? 1000
  const maxDelayMs = o.maxDelayMs ?? 30_000
  let closed = false
  let failures = 0
  let pending = false
  let watching = false
  let wakeRequested = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const retry = () => {
    if (closed) return
    const delay = Math.min(maxDelayMs, minDelayMs * 2 ** failures)
    failures++
    timer = setTimeout(ensure, delay)
    timer.unref?.()
  }

  function ensure(): void {
    timer = undefined
    if (closed || pending || watching) return
    pending = true
    o.acquire().then(
      (link) => {
        pending = false
        wakeRequested = false
        if (closed) return
        watching = true
        const upAt = clock()
        link.onExit(() => {
          watching = false
          if (clock() - upAt >= maxDelayMs) failures = 0
          retry()
        })
      },
      (error: unknown) => {
        pending = false
        if (closed) return
        o.log?.warn(
          `shared worker did not start: ${isWorkerBootBlocked(error) ? String((error as { message?: unknown }).message ?? 'WORKER_BOOT_BLOCKED') : String(error)}`,
        )
        if (wakeRequested) {
          wakeRequested = false
          ensure()
          return
        }
        if (!isWorkerBootBlocked(error)) retry()
      },
    )
  }

  const offRetry = o.onRetry?.(() => {
    failures = 0
    clearTimeout(timer)
    timer = undefined
    if (pending) wakeRequested = true
    else ensure()
  })
  ensure()
  return Object.freeze({
    close() {
      closed = true
      offRetry?.()
      clearTimeout(timer)
    },
  })
}
