export function deadlineScope(parent: AbortSignal, ms: number) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent.reason)
  const timer = setTimeout(
    () => controller.abort(new DOMException('Judgment deadline', 'TimeoutError')),
    Math.max(0, ms),
  )
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
      controller.abort()
    },
  }
}

/** Attach rejection handling even if cancellation won before this promise was handed back. */
export function within<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Judgment cancelled'))
    pending.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        signal.aborted ? abort() : resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}
