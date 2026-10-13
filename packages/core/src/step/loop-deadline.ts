import { CoreError } from '@agnes/core-common/types'

/**
 * A driver that ignores both its signal and `cancel()` would hold the run lane and `close()` for ever.
 * The deadline is an idle window, not a total: it re-arms while the ledger keeps advancing or the run
 * is waiting on a person, and only a driver that has done neither for `idleMs` is declared stuck.
 * `expire` cancels and revokes the driver's scope so the next run builds a fresh one, and the step
 * fails with an error that names the loop.
 */
export async function withLoopDeadline<T>(input: {
  loop: Readonly<{ id: string; version: string }>
  idleMs: number
  /** Changes whenever the run makes durable progress. */
  progress(): number
  /** True while the run is waiting on a human decision, which must never count against the driver. */
  waitingOnHuman(): boolean
  run(): Promise<T>
  expire(): void
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let mark = input.progress()
  const expired = new Promise<never>((_, reject) => {
    // Not the injected timers: those drive the writer lease, which a held-lease test freezes.
    const arm = () => {
      timer = setTimeout(() => {
        const seen = input.progress()
        if (input.waitingOnHuman() || seen !== mark) {
          mark = seen
          arm()
          return
        }
        input.expire()
        reject(
          new CoreError(
            'E_LOOP_TIMEOUT',
            `loop ${input.loop.id}@${input.loop.version} made no progress for ${input.idleMs} ms`,
            { loop: input.loop.id, idleMs: input.idleMs },
          ),
        )
      }, input.idleMs)
    }
    arm()
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
