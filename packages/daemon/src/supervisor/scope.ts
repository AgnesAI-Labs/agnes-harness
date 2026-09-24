import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  agnesHome,
  type ConfigurationService,
  createConfigurationService,
  createPlatform,
  dataDir as defaultDataDir,
  expandHome,
  HostError,
  type ResolvedProfile,
  readConfigurationProfileInputs,
  resolveProfile,
} from '@agnes/host'

/** Inputs shared by every local daemon consumer (start, status, stop and clients). */
export type DaemonScopeOptions = {
  env?: Readonly<Record<string, string | undefined>>
  cwd?: string
  home?: string
  profile?: string
  workspace?: string
  dataDir?: string
  configuration?: ConfigurationService
  agnesVersion?: string
  now?: string
  /** Compatibility for maintenance commands addressing a directory before its profile exists. */
  allowMissingProfile?: boolean
  /** Explicitly derive a daemon scope around a corrupt package lock without reading or replacing it. */
  allowPackageRecovery?: boolean
  /** Recovery boot may resolve the Host profile without an unreadable package lock. */
  ignorePackageLock?: boolean
}

/** The canonical identity and filesystem locations of one local daemon scope. */
export type DaemonScope = Readonly<{
  home: string
  profile: string
  workspace: string
  dataDir: string
  profileDir: string
  daemonDir: string
  profileFile: string
  ownerPath: string
  discoveryPath: string
  webCredentialPath: string
  /** Stable, non-secret identity for the complete resolved local scope. */
  scopeID: string
}>

export class DaemonScopeError extends Error {
  override name = 'DaemonScopeError'
}

function nonempty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

function profileName(value: string): string {
  if (value === '' || value === '.' || value === '..' || /[/\\]/.test(value))
    throw new DaemonScopeError(`profile name ${value} is not a single path segment`)
  return value
}

/**
 * Resolve an absolute path while preserving paths that have not been created yet. Existing
 * symlink ancestors are resolved, so two launchers that spell the same data directory through
 * different aliases still select one owner lock and one discovery record.
 */
export async function canonicalPath(input: string, base = process.cwd()): Promise<string> {
  const absolute = resolve(base, input)
  const missing: string[] = []
  let cursor = absolute
  while (true) {
    try {
      const resolved = await realpath(cursor)
      return join(resolved, ...missing.reverse())
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new DaemonScopeError(`cannot resolve path ${input}`)
      const parent = dirname(cursor)
      if (parent === cursor) return absolute
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

function scopeDigest(value: Pick<DaemonScope, 'home' | 'profile' | 'dataDir'>): string {
  // The fields are written in a fixed order, avoiding a second JSON canonicalizer dependency at
  // this boundary. The digest is an identity label, never an authentication credential.
  return `sha256-${createHash('sha256')
    .update(JSON.stringify([value.home, value.profile, value.dataDir]))
    .digest('hex')}`
}

function makeScope(paths: {
  home: string
  profile: string
  workspace: string
  dataDir: string
}): DaemonScope {
  const profileDir = join(paths.home, 'profiles', paths.profile)
  const daemonDir = join(paths.dataDir, 'daemon')
  const scopeID = scopeDigest(paths)
  return Object.freeze({
    ...paths,
    profileDir,
    daemonDir,
    profileFile: join(daemonDir, 'profile.json'),
    ownerPath: join(daemonDir, 'owner.json'),
    discoveryPath: join(daemonDir, 'discovery.json'),
    webCredentialPath: join(daemonDir, 'web-credential.json'),
    scopeID,
  })
}

async function profileForScope(
  input: Pick<
    DaemonScopeOptions,
    'home' | 'profile' | 'workspace' | 'dataDir' | 'configuration' | 'ignorePackageLock'
  > & {
    env?: Readonly<Record<string, string | undefined>>
    osHome: string
    agnesVersion: string
    now: string
  },
): Promise<{
  profile: ResolvedProfile
  home: string
  workspace: string
  configuration: ConfigurationService
}> {
  const home = await canonicalPath(input.home as string)
  const profile = profileName(input.profile as string)
  const workspace = await canonicalPath(input.workspace as string)
  const configuration = input.configuration ?? createConfigurationService({ home, profile })
  const inputs = await readConfigurationProfileInputs({
    home,
    cwd: workspace,
    profile,
    agnesVersion: input.agnesVersion,
    configuration: await configuration.profileInput(),
    ...(input.ignorePackageLock ? { lock: { packages: {} } } : {}),
  })

  // The daemon scope is the first owner of the data path. Resolve the profile with the selected
  // path inserted into the user layer so the resulting profile hash attests to the same canonical
  // path that owner/discovery/control use. A profile without an explicit dataDir now gets the same
  // home/data default host's paths module computes -- the two used to disagree, silently.
  const rawDataDir = input.dataDir ?? inputs.user?.dataDir ?? defaultDataDir(home)
  // AGH_HOME is the configuration root, while `~` in a profile keeps its normal shell meaning:
  // the operating-system home. This matters for legacy profiles that already refer to
  // `~/.agnes/secrets` when a caller selects a custom AGH_HOME.
  const dataDir = await canonicalPath(expandHome(rawDataDir, input.osHome), workspace)
  const cacheDir = await canonicalPath(
    expandHome(inputs.user?.cacheDir ?? join(home, 'cache'), input.osHome),
    workspace,
  )
  const user = {
    ...(inputs.user ?? {}),
    name: profile,
    dataDir,
    cacheDir,
  }
  const resolved = await resolveProfile(
    { ...inputs, user },
    {
      platform: createPlatform().snapshot(),
      agnesVersion: input.agnesVersion,
      now: input.now,
      homeDir: input.osHome,
    },
  )
  return { profile: resolved, home, workspace, configuration }
}

/**
 * Resolve the same Host profile and scope used by the daemon executable and local clients.
 * Precedence is explicit option, nonempty environment value, then the documented local default.
 */
export async function resolveDaemonScope(options: DaemonScopeOptions = {}): Promise<DaemonScope> {
  const env = options.env ?? process.env
  const osHome = nonempty(env.HOME) ?? homedir()
  const profileValue = options.profile ?? nonempty(env.AGNES_PROFILE) ?? 'local-dev'
  const workspaceValue = options.workspace ?? options.cwd ?? process.cwd()
  // agnesHome refuses a relative AGH_HOME rather than resolving it against process.cwd(); an
  // explicit `options.home` bypasses it entirely, same as it always bypassed the default before.
  const home = await canonicalPath(options.home ?? agnesHome(env))
  const profile = profileName(profileValue)
  const workspace = await canonicalPath(workspaceValue)
  if (options.dataDir !== undefined)
    return makeScope({
      home,
      profile,
      workspace,
      dataDir: await canonicalPath(expandHome(options.dataDir, osHome), workspace),
    })
  try {
    const profileInput = {
      env,
      home,
      profile,
      workspace,
      osHome,
      ...(options.configuration ? { configuration: options.configuration } : {}),
      agnesVersion: options.agnesVersion ?? '0.0.0',
      now: options.now ?? new Date().toISOString(),
    }
    let resolved: Awaited<ReturnType<typeof profileForScope>>
    try {
      resolved = await profileForScope(profileInput)
    } catch (error) {
      if (!(options.allowPackageRecovery && error instanceof HostError && error.code === 'E_LOCK_MISMATCH'))
        throw error
      resolved = await profileForScope({ ...profileInput, ignorePackageLock: true })
    }
    return makeScope({
      home: resolved.home,
      profile: resolved.profile.name,
      workspace: resolved.workspace,
      dataDir: await canonicalPath(resolved.profile.dataDir),
    })
  } catch (error) {
    if (!options.allowMissingProfile || !String(error).includes('no builtin template')) throw error
    // `agnesd status/stop` historically accepted an arbitrary profile label while addressing the
    // AGH_HOME directory. Preserve that maintenance compatibility when no profile exists yet.
    return makeScope({ home, profile, workspace, dataDir: home })
  }
}

/** Resolve the Host profile associated with an already resolved scope. */
export async function resolveDaemonProfile(
  scope: DaemonScope,
  options: Pick<
    DaemonScopeOptions,
    'configuration' | 'agnesVersion' | 'now' | 'env' | 'ignorePackageLock'
  > = {},
): Promise<{ profile: ResolvedProfile; configuration: ConfigurationService }> {
  const resolved = await profileForScope({
    home: scope.home,
    profile: scope.profile,
    workspace: scope.workspace,
    dataDir: scope.dataDir,
    osHome: nonempty(options.env?.HOME) ?? homedir(),
    ...(options.env ? { env: options.env } : {}),
    ...(options.configuration ? { configuration: options.configuration } : {}),
    ...(options.ignorePackageLock ? { ignorePackageLock: true } : {}),
    agnesVersion: options.agnesVersion ?? '0.0.0',
    now: options.now ?? new Date().toISOString(),
  })
  return { profile: resolved.profile, configuration: resolved.configuration }
}
