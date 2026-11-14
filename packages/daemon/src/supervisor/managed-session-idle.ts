/**
 * Where held managed inputs learn that a session can take one. Both turn-running paths report the
 * moment they clear a session's activity: the per-connection prompt and follow-up runner (owner Web
 * and SDK prompts, queued follow-ups, send-now), and the daemon's own follow-up runner (managed,
 * webhook and channel-interaction turns). A chain of follow-ups reports once, after its last turn.
 * `started` marks the point the daemon accepts connections, so a startup sweep can open sessions.
 *
 * Listeners run on a later tick, never inside the hook that cleared the activity, and a listener's
 * failure never reaches that hook.
 */
export interface IdleSignal {
  notify(sessionId: string): void
  onIdle(listener: (sessionId: string) => void): () => void
  /** A listener added after `started` still runs once, on a later tick. */
  onStartup(listener: () => void): () => void
  started(): void
}

const later = (work: () => unknown) =>
  setImmediate(() => {
    try {
      void Promise.resolve(work()).catch(report)
    } catch (error) {
      report(error)
    }
  })

const report = (error: unknown) =>
  console.error(`Managed session idle listener failed: ${String((error as Error)?.message ?? error)}`)

export function createIdleSignal(): IdleSignal {
  const idle = new Set<(sessionId: string) => void>()
  const startup = new Set<() => void>()
  let isStarted = false
  return {
    notify(sessionId) {
      // A listener removed before its tick, as at shutdown, is not called.
      for (const listener of idle) later(() => idle.has(listener) && listener(sessionId))
    },
    onIdle(listener) {
      idle.add(listener)
      return () => void idle.delete(listener)
    },
    onStartup(listener) {
      startup.add(listener)
      if (isStarted) later(() => startup.has(listener) && listener())
      return () => void startup.delete(listener)
    },
    started() {
      if (isStarted) return
      isStarted = true
      for (const listener of startup) later(() => startup.has(listener) && listener())
    },
  }
}

/**
 * Held managed inputs move on when their session reports idle, once after startup, and on a slow
 * sweep for turns that report no idle (bound-wake deliveries, manual compaction). Sweeps never overlap.
 * `stop` runs as shutdown starts, before workers drain and abort their turns: an idle report or a sweep
 * from then on would read gates that are going away, so none reaches the engine, and the engine closes.
 */
export function driveOwnerInputs(
  idle: Pick<IdleSignal, 'onIdle' | 'onStartup'>,
  engine: { advance(sessionId: string): Promise<void>; sweep(): Promise<void>; close?(): void },
  intervalMs: number,
): { stop(): void; dispose(): void } {
  let sweeping: Promise<void> | undefined
  const sweep = () => {
    sweeping ??= engine.sweep().finally(() => {
      sweeping = undefined
    })
    return sweeping
  }
  const offIdle = idle.onIdle((sessionId) => engine.advance(sessionId))
  const offStartup = idle.onStartup(sweep)
  const timer = setInterval(() => void sweep().catch(report), intervalMs)
  timer.unref?.()
  const stop = () => {
    offIdle()
    offStartup()
    clearInterval(timer)
    engine.close?.()
  }
  return { stop, dispose: stop }
}
