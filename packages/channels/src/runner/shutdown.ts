import type { Runner } from './runner.js'

type Signal = 'SIGINT' | 'SIGTERM'
type SignalSource = {
  on(signal: Signal, listener: () => void): unknown
  off(signal: Signal, listener: () => void): unknown
}

export type ShutdownHandle = {
  trigger(signal: string): void
  dispose(): void
}

/** Installs the two-rung service shutdown policy without owning process.exit in tests. */
export function installShutdown(
  runner: Pick<Runner, 'stop' | 'stopIntake'>,
  options: {
    drainMs: number
    exit(code: number): void
    signals?: Signal[]
    signalSource?: SignalSource
  },
): ShutdownHandle {
  const source = options.signalSource ?? process
  const signals: Signal[] = [...new Set<Signal>(options.signals ?? ['SIGTERM', 'SIGINT'])]
  let count = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let exited = false
  let handlers: ReadonlyArray<readonly [Signal, () => void]> = []

  const exitOnce = (code: number): void => {
    if (disposed || exited) return
    exited = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const [signal, handler] of handlers) source.off(signal, handler)
    handlers = []
    options.exit(code)
  }

  const trigger = (_signal: string): void => {
    if (disposed || exited) return
    count++
    if (count >= 2) {
      exitOnce(130)
      return
    }

    runner.stopIntake()
    timer = setTimeout(() => exitOnce(0), Math.max(0, options.drainMs))
    timer.unref?.()
    void Promise.resolve()
      .then(() => runner.stop({ drainMs: options.drainMs }))
      .then(
        () => exitOnce(0),
        () => exitOnce(0),
      )
  }

  handlers = signals.map((signal) => {
    const handler = (): void => trigger(signal)
    source.on(signal, handler)
    return [signal, handler] as const
  })

  return {
    trigger,
    dispose() {
      if (disposed) return
      disposed = true
      for (const [signal, handler] of handlers) source.off(signal, handler)
      handlers = []
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}
