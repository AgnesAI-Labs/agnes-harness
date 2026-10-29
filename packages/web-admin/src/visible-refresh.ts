/** Visible admin reads: no timer, one concurrent read, one follow-up for invalidations in flight. */
export function visibleRefresh(
  read: () => Promise<void | boolean>,
  events: readonly string[] = [],
  deferInvalidation = () => false,
  freshForMs: number | (() => number) = 0,
) {
  let lastRead = Number.NEGATIVE_INFINITY
  let stopped = false
  let dirty = false
  /** A caller learned of a change after the read in flight began: that read cannot show it. */
  let again = false
  let pending: Promise<void> | undefined
  const visible = () => document.visibilityState !== 'hidden'
  const request = (): Promise<void> => {
    if (stopped || !visible()) {
      dirty = !stopped
      return Promise.resolve()
    }
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      try {
        do {
          dirty = false
          again = false
          if (stopped || !visible()) break
          lastRead = Number.NEGATIVE_INFINITY
          const succeeded = await read()
          lastRead = succeeded === false ? Number.NEGATIVE_INFINITY : Date.now()
        } while (!stopped && visible() && (again || (dirty && !deferInvalidation())))
      } finally {
        pending = undefined
      }
    })
    return pending
  }
  const invalidate = () => {
    dirty = true
    if (!deferInvalidation()) void request().catch(() => undefined)
  }
  const wake = () => {
    const freshness = typeof freshForMs === 'function' ? freshForMs() : freshForMs
    if (!visible() || pending || (!dirty && Date.now() - lastRead < freshness)) return
    if (deferInvalidation()) dirty = true
    else void request().catch(() => undefined)
  }
  for (const event of events) window.addEventListener(event, invalidate)
  window.addEventListener('online', invalidate)
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  return {
    request,
    /** Like `request`, but a read already in flight is followed by one that starts after this call. */
    reread(): Promise<void> {
      if (pending) again = true
      return request()
    },
    flush: () => (dirty && !deferInvalidation() ? request() : Promise.resolve()),
    dispose() {
      stopped = true
      dirty = false
      for (const event of events) window.removeEventListener(event, invalidate)
      window.removeEventListener('online', invalidate)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    },
  }
}
