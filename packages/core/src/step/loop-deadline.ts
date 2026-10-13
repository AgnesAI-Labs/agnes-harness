import { CoreError } from '@agnes/core-common/types'

/**
 * A driver that ignores both its signal and `cancel()` would hold the run lane and `close()` for ever.
 * The deadline stops the wait: `expire` cancels and revokes the driver's scope so the next run builds a
 * fresh one, and the step fails with an error that names the loop.
 */
export async function withLoopDeadline<T>(input: {
  loop: Readonly<{ id: string; version: string }>
  timeoutMs: number
  run(): Promise<T>
  expire(): void
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    // Not the injected timers: those drive the writer lease, which a held-lease test freezes.
    timer = setTimeout(() => {
      input.expire()
      reject(
        new CoreError(
          'E_LOOP_TIMEOUT',
          `loop ${input.loop.id}@${input.loop.version} did not finish a step within ${input.timeoutMs} ms`,
          { loop: input.loop.id, timeoutMs: input.timeoutMs },
        ),
      )
    }, input.timeoutMs)
  })
  const stepped = input.run()
  // A step that settles after the deadline has nothing left to report to.
  stepped.catch(() => undefined)
  try {
    return await Promise.race([stepped, expired])
  } finally {
    clearTimeout(timer)
  }
}
