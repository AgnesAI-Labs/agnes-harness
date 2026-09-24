import type { Assembled } from './assemble.js'
import type { AuditSink } from './audit.js'

/**
 * The teardown a half-finished assembly owes, and the one a finished host owes at shutdown. Every
 * layer that comes up pushes its own close here, so unwinding is the reverse of assembly by
 * construction rather than by a second list somebody has to keep in step.
 *
 * It lives beside the close sequence rather than inside the assembly layer because the two share it:
 * an assembly that fails halfway and a host that closes cleanly run the same stack.
 */
export class Rollback {
  private readonly stack: Array<{ label: string; fn: () => Promise<void> | void }> = []
  push(label: string, fn: () => Promise<void> | void): void {
    this.stack.push({ label, fn })
  }
  /**
   * Idempotent: the stack is drained as it runs, so a second call is a no-op, not a second teardown.
   *
   * `timeoutMs` bounds each entry separately. A teardown that never settles is a failing teardown -
   * the kernel's close awaits every session it holds, so one session that will not close would
   * otherwise strand the seams, the exec children and the sqlite handle underneath it for the life
   * of the process, which is the same stranding the catch below exists to prevent. Unbounded when
   * the caller passes nothing, which is the assembly-failure path: there the layers are still
   * half-built and nobody is waiting on a deadline.
   */
  async unwind(opts: { timeoutMs?: number } = {}): Promise<string[]> {
    const failed: string[] = []
    for (let entry = this.stack.pop(); entry !== undefined; entry = this.stack.pop()) {
      // One failing teardown must not strand the layers under it, so each is caught and the label
      // reported rather than thrown.
      try {
        await (opts.timeoutMs === undefined ? entry.fn() : deadline(entry.fn(), opts.timeoutMs))
      } catch {
        failed.push(entry.label)
      }
    }
    return failed
  }
}

/**
 * Rejects when `ms` elapses first. The work is not cancelled - nothing here can cancel it - it is
 * abandoned, and the timer is cleared either way so a bounded wait cannot hold the event loop open.
 */
async function deadline(work: Promise<void> | void, ms: number): Promise<void> {
  const w = Promise.resolve(work)
  // An abandoned teardown that rejects later would otherwise be an unhandled rejection, reported
  // against whatever happened to be running at the time.
  w.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      w,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error('teardown did not settle')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type Closeable = { close(): Promise<void> }

/**
 * The close order lives in one place: the rollback stack the assembly built. Everything brought up
 * pushed its teardown there in order - adapters, seams with a close(), the kernel, and later the
 * extension host - so unwinding it is the reverse of assembly.
 *
 * The deadline is on the session/reconciliation drain and on nothing else. It used to cover the drain and the
 * rollback together, which made the forced branch skip the teardown entirely: the one case the
 * branch exists for - a session close that never settles - was the one case in which the sqlite
 * handle, the exec children and every seam stayed open for the life of the process. Forcing a close
 * means giving up on waiting in the caller, not permission to dispose live runtime state, so the
 * rollback is unwound in the background only after both drains settle.
 *
 * The extension host is not disposed here as well as on the stack: doing both is how a clean
 * shutdown disposed it twice.
 */
export async function closeHost(
  a: Assembled,
  sessions: Set<Closeable>,
  opts: {
    timeoutMs: number
    audit: AuditSink
    pendingOpenings?: readonly Promise<void>[]
    beforeRollback?: () => Promise<void>
  },
): Promise<void> {
  // Seal reconciliation synchronously with Host admission. Its drain runs alongside session close,
  // then joins before rollback can dispose the ordinary tree it may still be loading or applying.
  let reconciliationFailed = false
  const reconciliationDrain = a.ordinaryReconciliation.close().catch(() => {
    reconciliationFailed = true
  })
  const sessionDrain = (async (): Promise<void> => {
    await Promise.allSettled(opts.pendingOpenings ?? [])
    // Start every close before awaiting any one of them. A stuck session must not prevent its
    // siblings from receiving their own abort/close signal and releasing their workspace leases.
    await Promise.all(
      [...sessions].map(async (s) => {
        try {
          await s.close()
        } catch (e) {
          opts.audit.write({
            kind: 'session.close_failed',
            detail: { message: e instanceof Error ? e.message : String(e) },
          })
        }
      }),
    )
  })()
  const drain = Promise.all([sessionDrain, reconciliationDrain]).then(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>((res) => {
    timer = setTimeout(() => res('timeout'), opts.timeoutMs)
  })
  const forced = (await Promise.race([drain.then(() => 'drained' as const), deadline])) === 'timeout'
  clearTimeout(timer)
  const finish = async (): Promise<void> => {
    const failed: string[] = []
    let error: string | undefined
    if (reconciliationFailed) failed.push('ordinary-reconciliation')
    if (opts.beforeRollback)
      try {
        await opts.beforeRollback()
      } catch {
        failed.push('before-rollback')
      }
    try {
      failed.push(...(await a.rollback.unwind({ timeoutMs: opts.timeoutMs })))
    } catch (e) {
      failed.push('teardown')
      error = e instanceof Error ? e.message : String(e)
    }
    opts.audit.write({
      kind: 'host.closed',
      detail: { forced, sessions: sessions.size, failed, ...(error === undefined ? {} : { error }) },
    })
    await opts.audit.close?.()
  }
  if (!forced) return finish()
  // A timeout bounds close() for the caller; it is not permission to tear the workspace and lower
  // layers out from under a still-running session. Finish in the background after the drain proves
  // the kernel/session layer is quiescent.
  void drain.then(finish, finish).catch(() => undefined)
}
