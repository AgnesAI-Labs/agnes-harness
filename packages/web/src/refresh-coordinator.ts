export const DEFAULT_REFRESH_INTERVAL_MS = 10_000

/** Active invalidations cross a change boundary; polling only joins work already in progress. */
export function createRefreshCoordinator(options: {
  refresh(): Promise<void>
  canPoll(): boolean
  intervalMs?: number
}) {
  const interval = options.intervalMs ?? DEFAULT_REFRESH_INTERVAL_MS
  if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 2_147_483_647)
    throw new RangeError('refresh interval must be an integer between 1000 and 2147483647 ms')
  let stopped = false
  let again = false
  let pending: Promise<void> | undefined

  function request(): Promise<void> {
    if (stopped) return Promise.resolve()
    if (pending) {
      again = true
      return pending
    }
    pending = Promise.resolve().then(async () => {
      try {
        let failure: { error: unknown } | undefined
        do {
          again = false
          failure = undefined
          try {
            await options.refresh()
          } catch (error) {
            failure = { error }
          }
        } while (again && !stopped)
        if (failure) throw failure.error
      } finally {
        pending = undefined
      }
    })
    return pending
  }

  const timer = setInterval(() => {
    if (!stopped && options.canPoll() && !pending) void request().catch(() => undefined)
  }, interval)
  return {
    request,
    stop() {
      stopped = true
      again = false
      clearInterval(timer)
    },
  }
}
