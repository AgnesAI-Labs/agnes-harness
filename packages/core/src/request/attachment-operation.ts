/** Bound a provider call even when it ignores cancellation; late failures remain observed. */
export function attachmentOperation<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    const done = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        done()
        resolve(value)
      },
      (error) => {
        done()
        reject(error)
      },
    )
    if (signal.aborted) {
      done()
      abort()
    }
  })
}
