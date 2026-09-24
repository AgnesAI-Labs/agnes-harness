import type { ResolvedProfile } from '@agnes/host'
import { daemonSocketPaths } from './supervisor/socket-paths.js'

export type DaemonLimits = {
  maxWorkers: number
  workerIdleEvictMs: number
  workerStartupMs: number
  subscribeBufferEvents: number
  subscribeBufferBytes: number
  jobsTickMs: number
  jobsLockMs: number
  jobsMaxStalled: number
  shutdownGraceMs: number
  leaseTtlMs: number
}

export const DEFAULT_LIMITS: DaemonLimits = {
  maxWorkers: 10,
  workerIdleEvictMs: 600_000,
  workerStartupMs: 30_000,
  subscribeBufferEvents: 1000,
  subscribeBufferBytes: 8 * 1024 * 1024,
  jobsTickMs: 1000,
  jobsLockMs: 60_000,
  jobsMaxStalled: 5,
  shutdownGraceMs: 30_000,
  leaseTtlMs: 30_000,
}

// Maps a profile's dotted `limits` keys (its wire/YAML shape) onto the camelCase DaemonLimits field
// they override. Anything not in this table, or not a number, is ignored rather than rejected: a
// profile is allowed to carry limits keys this daemon build does not know about yet.
const LIMIT_KEYS: Record<string, keyof DaemonLimits> = {
  'daemon.max_workers': 'maxWorkers',
  'worker.idle_evict_ms': 'workerIdleEvictMs',
  'worker.startup_ms': 'workerStartupMs',
  'subscribe.buffer_events': 'subscribeBufferEvents',
  'subscribe.buffer_bytes': 'subscribeBufferBytes',
  'jobs.tick_ms': 'jobsTickMs',
  'jobs.lock_ms': 'jobsLockMs',
  'jobs.max_stalled': 'jobsMaxStalled',
  'shutdown.grace_ms': 'shutdownGraceMs',
  'lease.ttl_ms': 'leaseTtlMs',
}

export type Args = {
  profile: string
  home?: string
  workspace?: string
  socket?: string
  ws?: string
  dataDir?: string
  localWebAddr?: string
  localWebOrigin?: string
  command?: 'stop' | 'status'
}

/**
 * Parses `agnesd` argv into the flags `buildConfig` needs plus an optional `stop` / `status`
 * subcommand (dispatched in the 06 plan file). `--profile` is required for every form: even
 * `stop` / `status` need it to find the right `owner.json` under a multi-profile install.
 */
export function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) break
    if (a === 'stop' || a === 'status') {
      out.command = a
      continue
    }
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} needs a value`)
      return v
    }
    switch (a) {
      case '--home':
        out.home = next()
        break
      case '--profile':
        out.profile = next()
        break
      case '--workspace':
        out.workspace = next()
        break
      case '--socket':
        out.socket = next()
        break
      case '--ws':
        out.ws = next()
        break
      case '--data-dir':
        out.dataDir = next()
        break
      case '--web-addr':
        out.localWebAddr = next()
        break
      case '--web-origin':
        out.localWebOrigin = next()
        break
      default:
        throw new Error(`unknown flag ${a}`)
    }
  }
  if (!out.profile) throw new Error('--profile <name> is required')
  return out as Args
}

export type DaemonConfig = {
  profileName: string
  /** The resolved Agnes home. Workers are pinned to it rather than re-resolving one from the
   * environment they inherit, which an embedded launcher may never have pointed at this home. */
  home?: string
  dataDir: string
  socketPath: string
  workersSocketPath: string
  ws?: { addr: string; cert: string; key: string }
  localWeb?: { addr: string; origin: string }
  limits: DaemonLimits
}

/**
 * Turns parsed argv plus a resolved profile into runtime config: short Unix socket paths when
 * needed, paths under `dataDir` otherwise, profile limits overriding DEFAULT_LIMITS, and an
 * optional ws+tls leg when the profile declares one.
 *
 * `ipc` picks the transport shape (`unix` socket vs. Windows named pipe); it comes from the
 * caller, not by reading the OS off the process directly (README 勘误 8 — that's banned in this
 * package; host's `platform` adapter is the one place allowed to know the OS).
 */
export function buildConfig(o: {
  args: Args
  profile: ResolvedProfile
  home: string
  ipc: 'unix' | 'pipe'
}): DaemonConfig {
  const dataDir = o.args.dataDir ?? o.home
  const limits = { ...DEFAULT_LIMITS }
  for (const [k, v] of Object.entries(o.profile.limits ?? {})) {
    const key = LIMIT_KEYS[k]
    if (key && typeof v === 'number') limits[key] = v
  }
  const { socketPath, workersSocketPath } = daemonSocketPaths({
    dataDir,
    ipc: o.ipc,
    ...(o.args.socket !== undefined ? { socket: o.args.socket } : {}),
  })

  // host's `Transport` type (packages/host/src/profile/types.ts) carries a ws-tls leg as
  // `{ kind: 'ws-tls', listen?, tls?: { cert?, key? } }`, not the flat `{ addr, cert, key }` the
  // daemon config wants — so this reshapes it rather than casting past the mismatch. `--ws` on the
  // command line overrides the profile's configured listen address; cert/key always come from the
  // profile since there is no flag for a secret ref. Without both a cert and a key there is nothing
  // usable to listen with, so `ws` is simply omitted rather than published half-configured.
  const wsTransport = o.profile.transports.find((t) => t.kind === 'ws-tls')
  const addr = o.args.ws ?? wsTransport?.listen ?? (wsTransport ? '127.0.0.1:0' : undefined)
  const cert = wsTransport?.tls?.cert
  const key = wsTransport?.tls?.key
  const ws = addr && cert && key ? { addr, cert, key } : undefined

  return {
    profileName: o.profile.name,
    home: o.home,
    dataDir,
    socketPath,
    workersSocketPath,
    ...(ws ? { ws } : {}),
    limits,
  }
}
