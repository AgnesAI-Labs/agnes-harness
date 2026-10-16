import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import type { SpawnedSurfaceProcess, SurfaceSpawnOptions } from '../surfaces/local-runtime.js'

/** A live guardian owns the process group until every ordinary descendant has received KILL. */
export function spawnManagedPosix(
  executable: string,
  argv: readonly string[],
  options: SurfaceSpawnOptions,
): SpawnedSurfaceProcess {
  const guardian = createRequire(import.meta.url).resolve('@agnes/daemon-surfaces/managed-process')
  const child = spawn(executable, [guardian, ...argv], {
    ...options,
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const events = new EventEmitter()
  let exitCode: number | null = null
  let signalCode: NodeJS.Signals | null = null
  let report: { code: number | null; signal: NodeJS.Signals | null } | undefined
  let exited = false
  child.on('message', (message) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'exit' &&
      'code' in message &&
      (message.code === null || typeof message.code === 'number') &&
      'signal' in message &&
      (message.signal === null || typeof message.signal === 'string')
    )
      report = { code: message.code, signal: message.signal as NodeJS.Signals | null }
  })
  child.once('error', (error) => events.emit('error', error))
  child.once('exit', (code, signal) => {
    exited = true
    exitCode = report?.code ?? code
    signalCode = report?.signal ?? signal
    events.emit('exit', exitCode, signalCode)
  })
  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    get exitCode() {
      return exitCode
    },
    get signalCode() {
      return signalCode
    },
    once: events.once.bind(events),
    removeListener: events.removeListener.bind(events),
    kill(signal) {
      if (exited || !child.pid) return false
      if (signal === 'SIGTERM') {
        if (child.connected)
          child.send({ type: 'stop' }, (error) => {
            if (error && !exited && child.pid) {
              try {
                process.kill(-child.pid, 'SIGKILL')
              } catch {
                /* The guardian may have just exited. */
              }
            }
          })
        else process.kill(-child.pid, 'SIGKILL')
      } else process.kill(-child.pid, signal)
      return true
    },
  }
}
