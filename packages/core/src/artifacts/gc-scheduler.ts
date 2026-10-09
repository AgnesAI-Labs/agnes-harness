export type ArtifactGcScheduler = Readonly<{
  trigger(): Promise<void>
  close(): Promise<void>
}>

/** Runs once at boot and then at the configured cadence, never overlapping two collections. */
export function createArtifactGcScheduler(
  run: () => Promise<void>,
  input: Readonly<{
    intervalMs: number
    setInterval?: typeof setInterval
    clearInterval?: typeof clearInterval
    onError?: (error: unknown) => void
  }>,
): ArtifactGcScheduler {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 60_000 || input.intervalMs > 3_600_000)
    throw new Error('artifact GC interval must be between one minute and one hour')
  let closed = false
  let pending: Promise<void> | undefined
  const trigger = (): Promise<void> => {
    if (closed) return Promise.resolve()
    pending ??= Promise.resolve()
      .then(run)
      .catch((error) => {
        try {
          input.onError?.(error)
        } catch {
          // A diagnostic callback must not turn a handled GC failure into an unhandled rejection.
        }
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
  const timer = (input.setInterval ?? setInterval)(() => void trigger(), input.intervalMs)
  timer.unref?.()
  void trigger()
  return Object.freeze({
    trigger,
    async close() {
      if (closed) return
      closed = true
      ;(input.clearInterval ?? clearInterval)(timer)
      await pending
    },
  })
}
