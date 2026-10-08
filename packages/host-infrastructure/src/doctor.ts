import { accessSync, constants, existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { inspectHome } from '@agnes/host-common/home-layout'
import { verifyLockIntegrity } from '@agnes/host-common/packages/lock-state'
import { readLock } from '@agnes/host-common/packages/lockfile'
import { dataDir as defaultDataDir } from '@agnes/host-common/paths'
import type { DoctorCheck, DoctorResult } from '@agnes/protocol/gen/app-server'
import { createCredentialStore } from './adapters/credential-store.js'
import { createPlatform, probeLinuxSandboxSupport } from './adapters/platform.js'
import { defaultProcessIdentity } from './adapters/process-identity-default.js'
import { type ConfigurationService, createConfigurationService } from './configuration.js'

export type DoctorProbe = () => Promise<Omit<DoctorCheck, 'id' | 'fixHintKey'>>
export type DoctorOptions = {
  home: string
  profile: string
  dataDir?: string
  version?: string
  configuration?: ConfigurationService
  probeAccounts?: boolean
  signal?: AbortSignal
  connection?: () => Promise<boolean>
  sandbox?: () => Promise<boolean>
  /** Test seams return contract-shaped, non-sensitive evidence rather than exception bodies. */
  probes?: Partial<Record<DoctorCheck['id'], DoctorProbe>>
}
const ids = [
  'node',
  'native',
  'home',
  'permissions',
  'credentials',
  'sandbox',
  'connection',
  'disk',
  'accounts',
  'plugins',
  'mcp',
] as const
const severity = (checks: readonly Pick<DoctorCheck, 'status'>[]): DoctorResult['status'] =>
  checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok'

/** Reads metadata only. Contents, symlinks and hard-linked credentials are never opened by this scan. */
function privateTree(path: string, uid: number | undefined, budget = { remaining: 4096 }): boolean {
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
  if (--budget.remaining < 0) return false
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return false
  if (stat.isDirectory()) {
    if ((stat.mode & 0o777) !== 0o700) return false
    return readdirSync(path).every((name) => privateTree(join(path, name), uid, budget))
  }
  return stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
}

/** One shared report for CLI, startup and App Server; failures do not suppress other checks. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const platform = createPlatform()
  const dataDir = options.dataDir ?? defaultDataDir(options.home)
  const config =
    options.configuration ?? createConfigurationService({ home: options.home, profile: options.profile })
  let sandboxReady = false
  const defaults: Record<DoctorCheck['id'], DoctorProbe> = {
    node: async () => ({
      status:
        Number(process.versions.node.split('.')[0]) >= 24 &&
        (Number(process.versions.node.split('.')[0]) > 24 ||
          Number(process.versions.node.split('.')[1]) >= 10)
          ? 'ok'
          : 'fail',
    }),
    native: async () => {
      const native = createRequire(import.meta.url)('@agnes/system-node/native') as { abiVersion?: unknown }
      return {
        status:
          native.abiVersion === 1 && (await defaultProcessIdentity(process.pid, platform)).state === 'alive'
            ? 'ok'
            : 'fail',
      }
    },
    home: async () => ({
      status: inspectHome(options.home, options.profile).state === 'current' ? 'ok' : 'fail',
    }),
    permissions: async () => {
      accessSync(options.home, constants.R_OK | constants.W_OK)
      if (platform.os === 'win32')
        return {
          status: createCredentialStore({ root: options.home }).enforcement.level === 'full' ? 'ok' : 'fail',
        }
      const root = lstatSync(options.home)
      const uid = process.getuid?.()
      const safe =
        root.isDirectory() &&
        !root.isSymbolicLink() &&
        (root.mode & 0o777) === 0o700 &&
        (uid === undefined || root.uid === uid) &&
        ['profiles', join('profiles', options.profile)].every((name) => {
          const stat = lstatSync(join(options.home, name))
          return (
            stat.isDirectory() &&
            !stat.isSymbolicLink() &&
            (stat.mode & 0o777) === 0o700 &&
            (uid === undefined || stat.uid === uid)
          )
        }) &&
        ['secrets', 'auth', 'home-layout.json'].every((name) => privateTree(join(options.home, name), uid)) &&
        ['configuration.json', 'profile.yaml'].every((name) =>
          privateTree(join(options.home, 'profiles', options.profile, name), uid),
        )
      return { status: safe ? 'ok' : 'fail' }
    },
    credentials: async () => {
      const store = createCredentialStore({ root: options.home })
      const snapshot = await config.get()
      return {
        status:
          store.enforcement.level === 'full' &&
          !(snapshot.accounts ?? []).some((a) => a.enabled && !a.credentialConfigured)
            ? 'ok'
            : 'fail',
      }
    },
    sandbox: async () => {
      if (platform.os === 'linux') await probeLinuxSandboxSupport()
      sandboxReady = options.sandbox ? await options.sandbox() : false
      // Full-boundary probe must be supplied by the assembling runtime, never inferred from a binary.
      return { status: sandboxReady ? 'ok' : 'warn' }
    },
    connection: async () => ({ status: options.connection && (await options.connection()) ? 'ok' : 'warn' }),
    disk: async () => {
      let root = options.home
      while (!existsSync(root) && dirname(root) !== root) root = dirname(root)
      const stat = statfsSync(root)
      const availableBytes = Math.max(0, Math.round(stat.bavail * stat.bsize))
      return {
        status:
          availableBytes < 64 * 1024 * 1024 ? 'fail' : availableBytes < 1024 * 1024 * 1024 ? 'warn' : 'ok',
        availableBytes,
        totalBytes: Math.max(0, Math.round(stat.blocks * stat.bsize)),
      }
    },
    accounts: async () => {
      const accounts = (await config.get()).accounts?.filter((a) => a.enabled) ?? []
      if (!accounts.length) return { status: 'warn', count: 0, probed: false }
      if (accounts.some((a) => !a.credentialConfigured))
        return { status: 'fail', count: accounts.length, probed: false }
      if (options.probeAccounts) {
        const timeout = AbortSignal.timeout(45_000)
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
        for (const account of accounts) {
          signal.throwIfAborted()
          const result = await config.test(
            { providerId: account.providerId, accountId: account.accountId, model: account.model },
            signal,
          )
          signal.throwIfAborted()
          if (!result.verified) return { status: 'fail', count: accounts.length, probed: true }
        }
      }
      return { status: 'ok', count: accounts.length, probed: options.probeAccounts === true }
    },
    plugins: async () => {
      const lock = readLock(join(options.home, 'profiles', options.profile), {
        profile: options.profile,
        agnesVersion: options.version ?? '0.0.0',
      })
      verifyLockIntegrity(lock, { dataDir, profile: options.profile })
      return { status: 'ok', count: Object.keys(lock.packages).length }
    },
    mcp: async () => ({ status: sandboxReady ? 'ok' : 'warn' }),
  }
  const checks: DoctorCheck[] = []
  for (const id of ids) {
    options.signal?.throwIfAborted()
    try {
      const result = await (options.probes?.[id] ?? defaults[id])()
      checks.push({ ...result, id, fixHintKey: `doctor.fix.${id}` })
    } catch {
      options.signal?.throwIfAborted()
      checks.push({ id, status: 'fail', fixHintKey: `doctor.fix.${id}` })
    }
  }
  let homeId: string | undefined
  try {
    homeId = inspectHome(options.home, options.profile).instanceId
  } catch {
    /* The home check already records failure. */
  }
  return { checks, status: severity(checks), ...(homeId ? { homeId } : {}) }
}
