/** Cancel waiting, without allowing a late completion to continue the handshake. */
export function untilAborted<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason
      return start()
    })
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    pending.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}
