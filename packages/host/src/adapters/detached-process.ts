import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { OwnedDetachedProcess } from '@agnes/system-node'
import { createWindowsDetachedProcess } from '@agnes/system-node/process-detached'
import { createPlatform } from './platform.js'

class WindowsDetachedChild extends EventEmitter {
  readonly pid: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  private requestedSignal: NodeJS.Signals | null = null
  private released = false
  private timer: ReturnType<typeof setInterval>
  constructor(private readonly owned: OwnedDetachedProcess) {
    super()
    this.pid = owned.pid
    this.timer = setInterval(() => this.observe(), 25)
  }
  private observe(): void {
    let code: number | null
    try {
      code = this.owned.exitCode()
    } catch (error) {
      clearInterval(this.timer)
      this.emit('error', error)
      return // Keep the handle for the caller's failed-start cleanup.
    }
    if (code === null) return
    this.signalCode = this.requestedSignal
    this.exitCode = this.signalCode === null ? code : null
    try {
      this.release()
    } catch (error) {
      this.emit('error', error)
      return
    }
    this.emit('exit', this.exitCode, this.signalCode)
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (signal !== 'SIGTERM' && signal !== 'SIGKILL')
      throw Object.assign(new Error('Unsupported detached process signal'), { code: 'EINVAL' })
    if (this.exitCode !== null || this.signalCode !== null) return false
    if (this.released)
      throw Object.assign(new Error('Detached process ownership released'), { code: 'E_PROCESS_CLOSED' })
    if (this.owned.exitCode() !== null) return false
    this.owned.terminate()
    this.requestedSignal = signal
    return true
  }
  unref(): this {
    this.timer.unref()
    return this
  }
  release(): void {
    clearInterval(this.timer)
    if (!this.released) {
      this.owned.close()
      this.released = true
    }
  }
}
export type DetachedChild = {
  readonly pid?: number | undefined
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  unref(): unknown
}

/** Independent background process; callers retain ownership until readiness/cleanup is settled. */
export function spawnDetachedProcess(
  executable: string,
  argv: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): DetachedChild {
  if (createPlatform().os !== 'win32')
    return spawn(executable, argv, { ...options, detached: true, stdio: 'ignore' })
  const owned = createWindowsDetachedProcess(executable, argv, options)
  try {
    return new WindowsDetachedChild(owned)
  } catch (error) {
    try {
      owned.terminate()
    } finally {
      owned.close()
    }
    throw error
  }
}
/** Node's ChildProcess owns its native watcher; only the Windows adapter needs explicit release. */
export function releaseDetachedProcess(child: DetachedChild | undefined): void {
  if (child instanceof WindowsDetachedChild) child.release()
}
