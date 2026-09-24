import { execFile } from 'node:child_process'
import { baseEnvironment } from '../../adapters/exec.js'
import type { PlatformBackend } from '../../adapters/platform.js'
import type { ProcessIdentity } from '../../adapters/process-identity.js'
import { defaultProcessIdentity } from '../../adapters/process-identity-default.js'

type ProcessRow = Readonly<{ pid: number; parentPid: number }>

const MAX_PID = 2_147_483_647
const PROCESS_TABLE_LIMIT = 4 * 1024 * 1024

type IdentityReader = (pid: number, platform: Pick<PlatformBackend, 'os'>) => Promise<ProcessIdentity>
type ProcessSignal = (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
type ProcessTableReader = () => Promise<ProcessRow[]>

function validPid(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_PID
}

function processTable(): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid='],
      { env: baseEnvironment(), timeout: 1_000, maxBuffer: PROCESS_TABLE_LIMIT },
      (error, stdout) => {
        if (error) {
          reject(new Error('fake Computer Use could not inspect the POSIX process tree', { cause: error }))
          return
        }
        const rows: ProcessRow[] = []
        for (const raw of stdout.toString().split('\n')) {
          if (!raw.trim()) continue
          const match = /^\s*([0-9]{1,10})\s+([0-9]{1,10})\s*$/.exec(raw)
          if (!match) {
            reject(new Error('fake Computer Use received a malformed POSIX process table'))
            return
          }
          const pid = Number(match[1])
          const parentPid = Number(match[2])
          if (!validPid(pid) || !Number.isSafeInteger(parentPid) || parentPid < 0 || parentPid > MAX_PID) {
            reject(new Error('fake Computer Use received an invalid POSIX process id'))
            return
          }
          rows.push({ pid, parentPid })
        }
        resolve(rows)
      },
    )
  })
}

export class PosixRootGroupOwner {
  readonly #rootPid: number
  readonly #rootStartId: string
  readonly #platform: Pick<PlatformBackend, 'os'>
  readonly #identity: IdentityReader
  readonly #kill: ProcessSignal
  #signalDelivered = false

  constructor(
    rootPid: number,
    rootStartId: string,
    platform: Pick<PlatformBackend, 'os'>,
    deps: Readonly<{ identity?: IdentityReader; kill?: ProcessSignal }> = {},
  ) {
    this.#rootPid = rootPid
    this.#rootStartId = rootStartId
    this.#platform = platform
    this.#identity = deps.identity ?? defaultProcessIdentity
    this.#kill = deps.kill ?? process.kill
  }

  async alive(): Promise<boolean> {
    const current = await this.#identity(this.#rootPid, this.#platform)
    if (current.state === 'dead') return false
    if (current.state === 'unknown')
      throw new Error(`fake Computer Use cannot verify root process ${this.#rootPid}: ${current.reason}`)
    return current.startId === this.#rootStartId
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    if (!(await this.alive())) return false
    try {
      this.#kill(-this.#rootPid, signal)
      this.#signalDelivered = true
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'ESRCH') return false
        // Darwin may report EPERM once a successfully signalled group contains only an unreaped
        // zombie. The still-matching root identity proves this PGID was not recycled.
        if (error.code === 'EPERM' && this.#signalDelivered) return true
      }
      throw error
    }
  }
}

/**
 * Tracks descendants while their parent relationship is still observable. A detached direct child
 * remains linked by PPID and is therefore captured before the root exits. An arbitrary double-fork
 * can reparent to pid 1 before any userspace snapshot sees it; this fake/P0 helper deliberately does
 * not claim to close that unprovable gap. A production POSIX owner needs a kernel ownership boundary.
 */
export class PosixDescendantTracker {
  readonly #rootPid: number
  readonly #rootStartId: string
  readonly #platform: Pick<PlatformBackend, 'os'>
  readonly #processTable: ProcessTableReader
  readonly #identity: IdentityReader
  readonly #kill: ProcessSignal
  readonly #tracked = new Map<number, string>()

  constructor(
    rootPid: number,
    rootStartId: string,
    platform: Pick<PlatformBackend, 'os'>,
    deps: Readonly<{
      processTable?: ProcessTableReader
      identity?: IdentityReader
      kill?: ProcessSignal
    }> = {},
  ) {
    this.#rootPid = rootPid
    this.#rootStartId = rootStartId
    this.#platform = platform
    this.#processTable = deps.processTable ?? processTable
    this.#identity = deps.identity ?? defaultProcessIdentity
    this.#kill = deps.kill ?? process.kill
  }

  async capture(): Promise<void> {
    // Snapshot first, then validate the tracked seeds. A PID that was reused before this snapshot is
    // removed by the identity check and therefore cannot lend its unrelated children to the closure.
    const rows = await this.#processTable()
    const root = await this.#identity(this.#rootPid, this.#platform)
    if (root.state === 'unknown')
      throw new Error(`fake Computer Use cannot verify root process ${this.#rootPid}: ${root.reason}`)
    const seeds = new Set<number>(
      root.state === 'alive' && root.startId === this.#rootStartId ? [this.#rootPid] : [],
    )
    for (const [pid, startId] of [...this.#tracked]) {
      const current = await this.#identity(pid, this.#platform)
      if (current.state === 'dead' || (current.state === 'alive' && current.startId !== startId)) {
        this.#tracked.delete(pid)
        continue
      }
      if (current.state === 'unknown')
        throw new Error(`fake Computer Use cannot verify tracked descendant ${pid}: ${current.reason}`)
      seeds.add(pid)
    }

    const closure = new Set(seeds)
    // One process-table snapshot can contain an arbitrary-depth tree. Iterate to a fixed point rather
    // than assuming children appear after parents in ps output.
    for (;;) {
      let changed = false
      for (const row of rows)
        if (closure.has(row.parentPid) && !closure.has(row.pid)) {
          closure.add(row.pid)
          changed = true
        }
      if (!changed) break
    }

    closure.delete(this.#rootPid)
    for (const pid of closure) {
      if (this.#tracked.has(pid)) continue
      const identity = await this.#identity(pid, this.#platform)
      if (identity.state === 'dead') continue
      if (identity.state === 'unknown')
        throw new Error(`fake Computer Use cannot identify descendant ${pid}: ${identity.reason}`)
      this.#tracked.set(pid, identity.startId)
    }
  }

  async signal(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
    for (const [pid, startId] of [...this.#tracked]) {
      const identity = await this.#identity(pid, this.#platform)
      if (identity.state === 'dead' || (identity.state === 'alive' && identity.startId !== startId)) {
        this.#tracked.delete(pid)
        continue
      }
      if (identity.state === 'unknown')
        throw new Error(`fake Computer Use cannot verify descendant ${pid}: ${identity.reason}`)
      try {
        this.#kill(pid, signal)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
          this.#tracked.delete(pid)
          continue
        }
        throw error
      }
    }
  }

  async allExited(): Promise<boolean> {
    for (const [pid, startId] of [...this.#tracked]) {
      const identity = await this.#identity(pid, this.#platform)
      if (identity.state === 'dead' || (identity.state === 'alive' && identity.startId !== startId)) {
        this.#tracked.delete(pid)
        continue
      }
      if (identity.state === 'unknown')
        throw new Error(`fake Computer Use cannot verify descendant exit ${pid}: ${identity.reason}`)
      return false
    }
    return true
  }
}
