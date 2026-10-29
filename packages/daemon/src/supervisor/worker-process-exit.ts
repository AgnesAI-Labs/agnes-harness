import type { ChildProcess } from 'node:child_process'

/** The owning process, rather than its IPC link, determines whether plugin execution has ended. */
export function waitForWorkerExit(child: ChildProcess | undefined, timeoutMs?: number): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const onExit = (): void => finish(true)
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (!exited) child.off('exit', onExit)
      resolve(exited)
    }
    child.once('exit', onExit)
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(false), timeoutMs)
      timer.unref()
    }
  })
}
