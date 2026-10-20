/** Event-driven reads: coalesce changes during a read and defer work until the view is visible. */
export function createRefreshCoordinator(options: { refresh(): Promise<void>; canRefresh(): boolean }) {
  let stopped = false
  let again = false
  let pending: Promise<void> | undefined

  function request(): Promise<void> {
    if (stopped || !options.canRefresh()) return Promise.resolve()
    if (pending) {
      again = true
      return pending
    }
    pending = Promise.resolve().then(async () => {
      try {
        if (stopped || !options.canRefresh()) return
        let failure: { error: unknown } | undefined
        do {
          again = false
          failure = undefined
          try {
            await options.refresh()
          } catch (error) {
            failure = { error }
          }
        } while (again && !stopped && options.canRefresh())
        if (failure) throw failure.error
      } finally {
        pending = undefined
      }
    })
    return pending
  }

  return {
    request,
    stop() {
      stopped = true
      again = false
    },
  }
}

/** Runs `run` once, `settleMs` after the first request of a burst; requests within that wait join it. */
export function coalesceBurst(run: () => void, settleMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    request(): void {
      timer ??= setTimeout(() => {
        timer = undefined
        run()
      }, settleMs)
    },
    stop(): void {
      clearTimeout(timer)
      timer = undefined
    },
  }
}
