/** Visible admin reads: no timer, one concurrent read, one follow-up for invalidations in flight. */
export function visibleRefresh(
  read: () => Promise<void>,
  events: readonly string[] = [],
  deferInvalidation = () => false,
) {
  let stopped = false
  let dirty = false
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
          if (stopped || !visible()) break
          await read()
        } while (dirty && !stopped && visible() && !deferInvalidation())
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
    if (!visible()) {
      dirty = true
      return
    }
    // Visibility and focus commonly describe the same return to the page. Join an
    // in-flight read; only a real invalidation should require another read after it.
    if (deferInvalidation()) dirty = true
    else void request().catch(() => undefined)
  }
  for (const event of events) window.addEventListener(event, invalidate)
  window.addEventListener('online', invalidate)
  window.addEventListener('focus', wake)
  document.addEventListener('visibilitychange', wake)
  return {
    request,
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
