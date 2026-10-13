import { CoreError } from '@agnes/core-common/types'
import { armTimeout } from '@agnes/core-effects/effects/wrap'

/**
 * A driver that ignores both its signal and `cancel()` would hold the run lane and `close()` for ever.
 * The deadline is an idle window, not a total: only time in which the driver itself is silent counts.
 * It re-arms while the run shows progress, and it does not run at all while the run waits on work
 * whose end the platform owns. A driver that has done neither for `idleMs` is declared stuck:
 * `expire` cancels and revokes the driver's scope so the next run builds a fresh one, and the step
 * fails with an error that names the loop.
 */
export async function withLoopDeadline<T>(input: {
  loop: Readonly<{ id: string; version: string }>
  idleMs: number
  /** Changes whenever the run shows a sign of life: a ledger row, a model event, a wait that ended. */
  progress(): number
  /** True while the run waits on a person, a child agent, a tool inside its own timeout or a platform timer. */
  waiting(): boolean
  run(): Promise<T>
  expire(): void
}): Promise<T> {
  let disarm: (() => void) | undefined
  let mark = input.progress()
  const expired = new Promise<never>((_, reject) => {
    // Not the injected timers: those drive the writer lease, which a held-lease test freezes.
    const arm = () => {
      disarm = armTimeout(() => {
        const seen = input.progress()
        if (input.waiting() || seen !== mark) {
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
    disarm?.()
  }
}
