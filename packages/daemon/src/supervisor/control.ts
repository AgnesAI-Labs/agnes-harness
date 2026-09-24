import { connect } from 'node:net'
import { defaultProcessIdentity, type ProcessIdentity } from '@agnes/host'
import type { Args } from '../config.js'
import { type DaemonDiscoveryReadOptions, readDaemonDiscovery } from './discovery.js'
import { type Owner, readOwner } from './owner-record.js'
import { resolveDaemonScope } from './scope.js'
import { publishWindowsStopRequest } from './stop-request.js'

export type StopDaemonResult = 'stopped' | 'not-running' | 'timeout'

export class DaemonControlError extends Error {
  override name = 'DaemonControlError'
}

export type DaemonStatus = {
  running: boolean
  owner?: Owner
  socketReachable?: boolean
}

export type DaemonStatusOptions = {
  connect?: (path: string) => Promise<boolean>
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  identityTimeoutMs?: number
  socketTimeoutMs?: number
}

export type StopDaemonOptions = {
  kill?: (pid: number, signal: NodeJS.Signals) => void
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  identityTimeoutMs?: number
  waitMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

async function processIdentity(
  pid: number,
  query: (pid: number) => Promise<ProcessIdentity>,
  timeoutMs: number,
): Promise<ProcessIdentity> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => query(pid)),
      new Promise<ProcessIdentity>((resolve) => {
        timer = setTimeout(() => resolve({ state: 'unknown', reason: 'identity deadline' }), timeoutMs)
        timer.unref()
      }),
    ])
  } catch {
    return { state: 'unknown', reason: 'identity query failed' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function matches(owner: Owner, identity: ProcessIdentity): boolean {
  return identity.state === 'alive' && identity.startId === owner.processStartId
}

function sameOwner(left: Owner, right: Owner): boolean {
  return (
    left.pid === right.pid &&
    left.processStartId === right.processStartId &&
    left.generation === right.generation
  )
}

function probeSocket(path: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path)
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(reachable)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Read-only daemon liveness. Identity is checked against the process start id in owner.json, so a
 * reused PID is stale rather than live. An unverifiable process is reported running fail-closed:
 * callers guarding package mutation must not treat EPERM/unsupported identity lookup as permission
 * to write underneath a possibly-live daemon. */
export async function daemonStatus(
  dataDir: string,
  options: DaemonStatusOptions = {},
): Promise<DaemonStatus> {
  const owner = await readOwner(dataDir)
  if (!owner) return { running: false }
  const identity = await processIdentity(
    owner.pid,
    options.processIdentity ?? defaultProcessIdentity,
    options.identityTimeoutMs ?? 1000,
  )
  if (identity.state === 'dead') return { running: false }
  if (identity.state === 'alive' && identity.startId !== owner.processStartId) return { running: false }
  const reachable = await (options.connect ?? ((path) => probeSocket(path, options.socketTimeoutMs ?? 1000)))(
    owner.socketPath,
  )
  return { running: true, owner, socketReachable: reachable }
}

/**
 * Ask the exact process recorded by owner.json to shut down. PID liveness alone is deliberately
 * insufficient: the process start id and owner generation are checked again immediately before
 * SIGTERM, closing the common stale-file/PID-reuse window. Unknown identity is a refusal, never an
 * excuse to signal an arbitrary PID, and this command never escalates to SIGKILL.
 */
export async function stopDaemon(
  dataDir: string,
  options: StopDaemonOptions = {},
): Promise<StopDaemonResult> {
  const query = options.processIdentity ?? defaultProcessIdentity
  const identityTimeoutMs = options.identityTimeoutMs ?? 1000
  const owner = await readOwner(dataDir)
  if (!owner) return 'not-running'

  const first = await processIdentity(owner.pid, query, identityTimeoutMs)
  if (first.state === 'dead' || (first.state === 'alive' && !matches(owner, first))) return 'not-running'
  if (first.state === 'unknown') throw new DaemonControlError('daemon process identity unavailable')

  const current = await readOwner(dataDir)
  if (!current || !sameOwner(owner, current))
    throw new DaemonControlError('daemon owner changed before shutdown signal')
  const confirmed = await processIdentity(owner.pid, query, identityTimeoutMs)
  if (confirmed.state === 'dead' || (confirmed.state === 'alive' && !matches(owner, confirmed)))
    return 'not-running'
  if (confirmed.state === 'unknown')
    throw new DaemonControlError('daemon process identity unavailable before shutdown signal')

  try {
    const windows = process.platform === 'win32' // guards-allow-platform: Windows requests the daemon's graceful shutdown instead of SIGTERM.
    if (windows && !options.kill) publishWindowsStopRequest(dataDir, owner)
    else (options.kill ?? ((pid, signal) => process.kill(pid, signal)))(owner.pid, 'SIGTERM')
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
      return 'stopped'
    throw new DaemonControlError('failed to signal daemon')
  }

  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (options.waitMs ?? 35_000)
  const pollMs = options.pollMs ?? 100
  while (now() < deadline) {
    const identity = await processIdentity(owner.pid, query, identityTimeoutMs)
    if (identity.state === 'dead' || (identity.state === 'alive' && !matches(owner, identity)))
      return 'stopped'
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())))
  }
  return 'timeout'
}

export type DaemonControlCommandOptions = {
  env?: Readonly<Record<string, string | undefined>>
  write?: (text: string) => void
  stop?: typeof stopDaemon
  status?: typeof daemonStatus
  scope?: typeof resolveDaemonScope
  discovery?: typeof readDaemonDiscovery
  processIdentity?: (pid: number) => Promise<ProcessIdentity>
  identityTimeoutMs?: number
}

/** Dispatch the two non-starting agnesd commands. Null means the caller should start the daemon. */
export async function runDaemonControl(
  args: Args,
  options: DaemonControlCommandOptions = {},
): Promise<number | null> {
  if (!args.command) return null
  const env = options.env ?? process.env
  const scope = await (options.scope ?? resolveDaemonScope)({
    env,
    ...(args.home !== undefined ? { home: args.home } : {}),
    ...(args.profile !== undefined ? { profile: args.profile } : {}),
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    ...(args.dataDir !== undefined ? { dataDir: args.dataDir } : {}),
    allowMissingProfile: true,
  })
  const dataDir = scope.dataDir
  // A descriptor is the daemon's generation-bound statement of which profile/home owns this data
  // directory. Validate it before maintenance can signal or report a live daemon; if an older
  // installation has only owner.json, retain the owner-only compatibility path below.
  const discoveryOptions: DaemonDiscoveryReadOptions = {
    ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
    ...(options.identityTimeoutMs !== undefined ? { identityTimeoutMs: options.identityTimeoutMs } : {}),
  }
  await (options.discovery ?? readDaemonDiscovery)(scope, discoveryOptions)
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  if (args.command === 'stop') {
    const result = options.stop
      ? await options.stop(dataDir)
      : await stopDaemon(dataDir, {
          ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
          ...(options.identityTimeoutMs !== undefined
            ? { identityTimeoutMs: options.identityTimeoutMs }
            : {}),
        })
    write(`${result}\n`)
    return result === 'timeout' ? 1 : 0
  }
  const status = options.status
    ? await options.status(dataDir)
    : await daemonStatus(dataDir, {
        ...(options.processIdentity ? { processIdentity: options.processIdentity } : {}),
        ...(options.identityTimeoutMs !== undefined ? { identityTimeoutMs: options.identityTimeoutMs } : {}),
      })
  write(`${JSON.stringify(status)}\n`)
  return status.running ? 0 : 1
}
