/** One UI poll at a time, paused while hidden. Focus and visibility share the same catch-up read. */
export function visiblePoll(read: () => Promise<void>, interval: number): () => void {
  let stopped = false
  let pending = false
  let queued = false
  let epoch = 0
  let readingEpoch = 0
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const visible = () => document.visibilityState !== 'hidden'
  const request = () => {
    if (stopped || !visible()) return
    clearTimeout(timer)
    if (pending) {
      // A request begun before hiding cannot replace the catch-up on return.
      again ||= readingEpoch !== epoch
      return
    }
    pending = true
    again = false
    readingEpoch = epoch
    const finish = () => {
      pending = false
      if (stopped || !visible()) return
      if (again) {
        again = false
        request()
      } else timer = setTimeout(request, interval)
    }
    void Promise.resolve()
      .then(() => {
        if (!stopped && visible()) return read()
      })
      .then(finish, finish)
  }
  const wake = () => {
    if (!visible()) {
      epoch++
      clearTimeout(timer)
      return
    }
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      request()
    })
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
  request()
  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', wake)
    window.removeEventListener('focus', wake)
  }
}
