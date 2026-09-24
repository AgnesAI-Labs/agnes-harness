import { SIGNAL_EXIT_CODES, type SignalName } from '../errors.js'

export type SignalCtl = { cancel(): Promise<void>; close(): Promise<void> }
export type SignalOptions = {
  graceMs: number
  exit: (code: number) => void
  proc?: NodeJS.EventEmitter
  log?: (line: string) => void
  /**
   * Told which signal arrived, before the cancel it triggers. A turn cancelled by a signal ends as
   * `aborted`, and `aborted` alone does not say which code to leave with -- so the run has to learn
   * the signal from here rather than assume the Ctrl-C one.
   */
  onSignal?: (signal: SignalName) => void
}

/**
 * Three rungs, in the order an operator expects: the first signal asks the turn to stop and gives
 * shutdown a bounded grace, the grace running out exits anyway, and a second signal exits at once.
 *
 * The second rung is the one worth having: without it a shutdown that hangs -- a seam that will not
 * close, a socket that will not drain -- swallows every further Ctrl-C, and the only way out is a
 * kill from another terminal.
 *
 * Returns the uninstaller. It is a return value rather than a lifetime tied to the process because
 * the same ladder is installed around a single `-p` run, and leaving the handlers behind after that
 * run would keep the process listening on signals nothing is left to answer.
 */
export function installSignalLadder(ctl: SignalCtl, o: SignalOptions): () => void {
  const proc = o.proc ?? process
  let armed = false
  const handlers = new Map<string, () => void>()
  for (const sig of Object.keys(SIGNAL_EXIT_CODES) as SignalName[]) {
    const code = SIGNAL_EXIT_CODES[sig]
    const h = (): void => {
      if (armed) {
        o.log?.(`second signal ${sig}: exiting now`)
        o.exit(code)
        return
      }
      armed = true
      o.onSignal?.(sig)
      // The grace timer and the shutdown finishing are two ways to reach the same exit, and only the
      // first of them counts. Without this a shutdown that overran the grace exited twice -- once
      // when the timer fired and again when it eventually finished -- which in production is
      // harmless only because process.exit does not return, and is a real double report anywhere the
      // exit is a function. The second-signal rung below deliberately does not go through here: its
      // whole purpose is to leave when an exit already announced has not taken effect.
      let left = false
      const leave = (c: number): void => {
        if (left) return
        left = true
        o.exit(c)
      }
      const timer = setTimeout(() => {
        o.log?.(`shutdown exceeded ${o.graceMs} ms`)
        leave(code)
      }, o.graceMs)
      void (async () => {
        try {
          // Cancel first and close second, and neither is allowed to skip the other: a cancel that
          // throws still owes the close, and a close that throws still owes the exit.
          await ctl.cancel().catch(() => undefined)
          await ctl.close().catch(() => undefined)
        } finally {
          clearTimeout(timer)
          leave(code)
        }
      })()
    }
    handlers.set(sig, h)
    proc.on(sig, h)
  }
  return () => {
    for (const [sig, h] of handlers) proc.off(sig, h)
  }
}
