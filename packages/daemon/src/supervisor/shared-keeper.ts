import type { WorkerLink } from './worker-link.js'

export type SharedWorkerKeeper = Readonly<{ close(): void }>

/**
 * Keeps the shared business worker up from daemon start, instead of waiting for the first session
 * to ask for it. A failed start or an exit is retried after 1 s, 2 s, ... capped at 30 s, so a
 * worker that cannot start never spins; a worker that stayed up for the cap resets the delay.
 */
export function keepSharedWorker(o: {
  acquire(): Promise<WorkerLink>
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
    if (closed) return
    o.acquire().then(
      (link) => {
        if (closed) return
        const upAt = clock()
        link.onExit(() => {
          if (clock() - upAt >= maxDelayMs) failures = 0
          retry()
        })
      },
      (error: unknown) => {
        if (closed) return
        o.log?.warn(`shared worker did not start: ${String(error)}`)
        retry()
      },
    )
  }

  ensure()
  return Object.freeze({
    close() {
      closed = true
      clearTimeout(timer)
    },
  })
}
