export interface JudgmentScheduler {
  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T>
  dispose(): void
}

/** The slot remains occupied until actual work settles, including after cancellation. */
export function createJudgmentScheduler(limit: number): JudgmentScheduler {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid judgment concurrency')
  let active = 0
  let closed = false
  const queue = new Set<() => void>()
  const pump = () => {
    for (const start of queue) {
      if (!closed && active >= limit) break
      start()
    }
  }
  return {
    run<T>(signal: AbortSignal, work: () => Promise<T>) {
      return new Promise<T>((resolve, reject) => {
        const cancel = () => {
          queue.delete(start)
          signal.removeEventListener('abort', cancel)
          reject(signal.reason ?? new Error('Judgment scheduler closed'))
        }
        const start = () => {
          if (closed || signal.aborted) return cancel()
          queue.delete(start)
          signal.removeEventListener('abort', cancel)
          active++
          Promise.resolve()
            .then(work)
            .then(resolve, reject)
            .finally(() => {
              active--
              pump()
            })
        }
        if (closed || signal.aborted) return cancel()
        queue.add(start)
        signal.addEventListener('abort', cancel, { once: true })
        pump()
      })
    },
    dispose() {
      closed = true
      pump()
    },
  }
}
