import type { WorkerLink } from './worker-link.js'

/** The pool owns single-flight admission. Speculation only changes who retries its failure. */
export class SharedWorkerPrewarm {
  private pending: Promise<WorkerLink> | undefined

  constructor(private readonly acquire: () => Promise<WorkerLink>) {}

  foreground(): Promise<WorkerLink> {
    const pending = this.acquire()
    const speculative = pending === this.pending
    return pending.catch((error: unknown) => {
      if (!speculative) throw error
      return this.acquire()
    })
  }

  background(): Promise<WorkerLink> {
    const pending = this.acquire()
    this.pending = pending
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined
      })
      .catch(() => undefined)
    return pending
  }
}

/** Keep the existing shared-worker exemption; unused resource helpers retain ordinary eviction. */
export function evictIdleWorkers(
  slots: Iterable<
    [
      string,
      {
        link?: Pick<WorkerLink, 'alive' | 'close'> | undefined
        sessions: ReadonlySet<string>
        lastUsed: number
        intentionalExit?: boolean
      },
    ]
  >,
  now: number,
  idleMs: number,
  busy: (sessionKey: string) => boolean,
): number {
  let n = 0
  for (const [k, s] of slots)
    if (
      // Kept up from daemon start for MCP connections and Skill scans, not just for sessions.
      k !== '@shared' &&
      s.link?.alive &&
      [...s.sessions].every((sessionKey) => !busy(sessionKey)) &&
      !busy(k) &&
      now - s.lastUsed > idleMs
    ) {
      s.intentionalExit = true
      s.link.close('idle')
      n++
    }
  return n
}
