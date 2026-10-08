export type ShutdownLadderOptions = {
  stopAccepting: () => Promise<void>
  notify: () => void
  closeWorkers: (graceMs: number, signal: AbortSignal) => Promise<void>
  killWorkers: () => void
  closeSockets: () => Promise<void>
  releaseLock: () => Promise<void>
  graceMs: number
  log?: (message: string) => void
}

/** Audit flushing must run after shutdown, even when shutdown fails. Preserve both errors. */
export async function closeWithAudit(close: () => Promise<void>, flush: () => Promise<void>): Promise<void> {
  const errors: unknown[] = []
  for (const action of [close, flush]) {
    try {
      await action()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'daemon shutdown or audit flush failed')
}

/**
 * Runs every shutdown phase even when an earlier phase fails. Worker draining is the only bounded
 * phase: once its grace expires (or graceful close itself fails), the pool is force-terminated and
 * socket/lock cleanup still gets its turn.
 */
export async function shutdownLadder(options: ShutdownLadderOptions): Promise<void> {
  const step = async (name: string, action: () => void | Promise<void>): Promise<boolean> => {
    try {
      await action()
      return true
    } catch (error) {
      options.log?.(`shutdown ${name} failed: ${String(error)}`)
      return false
    }
  }

  await step('stopAccepting', options.stopAccepting)
  await step('notify', options.notify)

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const drain = new AbortController()
  const workersClosed = await step('closeWorkers', async () => {
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(
        () => {
          timedOut = true
          drain.abort(new Error('worker shutdown grace expired'))
          resolve()
        },
        Math.max(0, options.graceMs),
      )
      timer.unref()
    })
    try {
      await Promise.race([options.closeWorkers(options.graceMs, drain.signal), timeout])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  })
  if (timedOut || !workersClosed) await step('killWorkers', options.killWorkers)

  await step('closeSockets', options.closeSockets)
  await step('releaseLock', options.releaseLock)
}

type SignalTarget = {
  on(signal: NodeJS.Signals, listener: () => void): unknown
  removeListener(signal: NodeJS.Signals, listener: () => void): unknown
}

/** First SIGTERM/SIGINT drains normally; either signal a second time forces exit immediately. */
export function installSignals(
  handler: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  target: SignalTarget = process,
): () => void {
  let fired = false
  let forced = false
  const dispose = (): void => {
    target.removeListener('SIGTERM', onSignal)
    target.removeListener('SIGINT', onSignal)
  }
  const onSignal = (): void => {
    if (fired) {
      forced = true
      dispose()
      exit(130)
      return
    }
    fired = true
    void Promise.resolve()
      .then(handler)
      .then(
        () => {
          dispose()
          if (!forced) exit(0)
        },
        () => {
          dispose()
          if (!forced) exit(1)
        },
      )
  }
  target.on('SIGTERM', onSignal)
  target.on('SIGINT', onSignal)
  return dispose
}
