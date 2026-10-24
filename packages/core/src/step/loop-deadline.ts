import { CoreError } from '@agnes/core-common/types'
import { armTimeout } from '@agnes/core-effects/effects/wrap'
import type { LoopDriver, LoopStepOutcome } from '@agnes/extension-api'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from './session.js'

const DEFAULT_LOOP_STEP_IDLE_MS = 30 * 60_000

/**
 * What the current driver scope has in flight: the port calls `close()` waits for, the waits whose
 * end the platform owns, and the signs of life that never reach the ledger.
 */
export class LoopScope {
  private readonly operations = new Set<() => void>()
  private readonly waits = new Set<symbol>()
  private activity = 0
  private expired = false
  private revoked = false

  get alive(): boolean {
    return !this.revoked
  }

  assertAlive(): void {
    if (this.revoked) throw new CoreError('E_CLOSED', 'Loop execution scope STOPPED: revoked')
  }

  /** Registers a port call; the returned function ends it, and so does revoking the scope. */
  own(end: () => void): () => void {
    this.assertAlive()
    const finish = () => {
      if (this.operations.delete(finish)) end()
    }
    this.operations.add(finish)
    return finish
  }

  /** A sign of life that never reaches the ledger, such as a streamed model event. */
  note(): void {
    this.activity++
  }

  /**
   * Marks a wait whose end the platform owns: a child agent, a tool inside its own timeout, a
   * platform timer. The step deadline does not run during it, and its end counts as activity.
   */
  beginWait(): () => void {
    this.assertAlive()
    const wait = Symbol()
    this.waits.add(wait)
    return () => {
      if (this.waits.delete(wait)) this.activity++
    }
  }

  get progress(): number {
    return this.activity
  }

  get waiting(): boolean {
    return this.waits.size > 0
  }

  /** The revoked scope owns nothing any more: close must not wait on calls it left hanging. */
  expire(): void {
    this.expired = true
    this.revoke()
  }

  /** Cancellation revokes pending ports without turning a user stop into an idle timeout error. */
  revoke(): void {
    this.revoked = true
    for (const finish of [...this.operations]) finish()
    this.waits.clear()
  }

  /** Whether the deadline revoked the scope since this was last asked. */
  takeExpired(): boolean {
    const expired = this.expired
    this.expired = false
    return expired
  }
}

/**
 * The window is never shorter than a model request's own timeout: a request may be silent that long
 * before its first event. Tool calls and the other platform-owned waits suspend the window instead.
 */
function loopStepIdleMs(s: SessionImpl): number {
  const silent = s.preset.model.timeoutMs
  return s.d.loopStepTimeoutMs === undefined
    ? Math.max(DEFAULT_LOOP_STEP_IDLE_MS, silent + 60_000)
    : Math.max(s.d.loopStepTimeoutMs, silent)
}

/** One driver step of `s` under its idle deadline. */
export function stepWithinLoopDeadline(s: SessionImpl, driver: LoopDriver): Promise<LoopStepOutcome> {
  return withLoopDeadline({
    loop: s.loop,
    idleMs: loopStepIdleMs(s),
    progress: () => s.lastSeq + s.loopScope.progress,
    waiting: () => s.decisions.waiting > 0 || s.loopScope.waiting,
    signal: s.ac.signal,
    cancel: () => {
      s.decisions.revokeScope()
      s.loopScope.revoke()
    },
    run: () => driver.step(s.ac.signal),
    expire: () => {
      s.decisions.revokeScope()
      s.ac.abort()
      s.loopScope.expire()
      void Promise.resolve()
        .then(() => driver.cancel())
        .catch(bestEffort(s.d.logger, 'expired-loop-cancel'))
    },
  })
}

/**
 * A driver that ignores both its signal and `cancel()` would hold the run lane and `close()` for ever.
 * The deadline is an idle window, not a total: only time in which the driver itself is silent counts.
 * It re-arms while the run shows progress, and it does not run at all while the run waits on work
 * whose end the platform owns. A driver that has done neither for `idleMs` is declared stuck:
 * `expire` cancels and revokes the driver's scope so the next run builds a fresh one, and the step
 * fails with an error that names the loop.
 * A user abort instead starts a fixed five-second drain window, unaffected by activity or waiting;
 * exceeding it revokes pending ports and returns control to the turn's cancellation closer.
 */
export async function withLoopDeadline<T>(input: {
  loop: Readonly<{ id: string; version: string }>
  idleMs: number
  /** Changes whenever the run shows a sign of life: a ledger row, a model event, a wait that ended. */
  progress(): number
  /** True while the run waits on a person, a child agent, a tool inside its own timeout or a platform timer. */
  waiting(): boolean
  /** User cancellation has a separate fixed drain window, including while platform work is pending. */
  signal?: AbortSignal
  cancel?(): void
  run(): Promise<T>
  expire(): void
}): Promise<T> {
  let disarm: (() => void) | undefined
  let onAbort = () => {}
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
    onAbort = () => {
      disarm?.()
      disarm = armTimeout(() => {
        input.cancel?.()
        reject(new CoreError('E_CLOSED', 'Loop step did not settle after cancellation'))
      }, 5000)
    }
    if (input.signal?.aborted) onAbort()
    else {
      input.signal?.addEventListener('abort', onAbort, { once: true })
      arm()
    }
  })
  const stepped = input.run()
  // A step that settles after the deadline has nothing left to report to.
  stepped.catch(() => undefined)
  try {
    return await Promise.race([stepped, expired])
  } finally {
    disarm?.()
    input.signal?.removeEventListener('abort', onAbort)
  }
}
