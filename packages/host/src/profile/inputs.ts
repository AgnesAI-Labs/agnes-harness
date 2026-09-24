import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGH_DIR } from '@agnes/protocol'
import { parse as parseYaml } from 'yaml'
import { lockState } from '../packages/lock-state.js'
import { lockPath, readLock } from '../packages/lockfile.js'
import { mergeIsolation } from './isolation.js'
import type { LockState, ProfileInputs, RuntimeProfileManifest } from './types.js'

/**
 * Inputs needed to load one profile's boot layers.
 *
 * `configuration` is supplied by the Host configuration service. It belongs in the user layer so
 * every Host client resolves the same effective profile. The local YAML layer remains a separate
 * layer because the profile resolver owns its current trust decision for that layer.
 */
export type ConfigurationProfileInputsOptions = {
  home: string
  cwd: string
  profile: string
  agnesVersion: string
  /** Test seam: an explicit lock wins over the profile's own agnes-lock.json. */
  lock?: LockState
  /** Host configuration overlay; it never contains a credential value. */
  configuration?: Partial<RuntimeProfileManifest>
}

function checkProfileName(name: string): string {
  if (name === '' || name === '.' || name === '..' || /[/\\]/.test(name))
    throw new Error(`profile name ${name} is not a single path segment`)
  return name
}

function readYamlIf<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined

  let document: unknown
  try {
    document = parseYaml(readFileSync(file, 'utf8'))
  } catch (cause) {
    // Keep the message stable for the CLI wrapper while retaining the parser failure as its cause.
    throw new Error(`${file} is not valid yaml`, { cause })
  }
  if (document === null || document === undefined) return undefined
  if (typeof document !== 'object' || Array.isArray(document)) throw new Error(`${file} is not a mapping`)
  return document as T
}

function mergeConfiguration(
  profile: string,
  user: RuntimeProfileManifest | undefined,
  configuration: Partial<RuntimeProfileManifest> | undefined,
): RuntimeProfileManifest | undefined {
  if (user === undefined && configuration === undefined) return undefined

  // Configuration owns its keys in the user layer, while adapters are a shared namespace. A
  // shallow spread here would erase user storage/fs/exec/platform adapters whenever configuration
  // only supplies the secrets adapter path.
  const merged = {
    ...(user ?? { name: profile }),
    ...(configuration ?? {}),
  } as RuntimeProfileManifest
  if (user?.adapters !== undefined || configuration?.adapters !== undefined) {
    merged.adapters = {
      ...(user?.adapters ?? {}),
      ...(configuration?.adapters ?? {}),
    }
  }
  const isolation = mergeIsolation(user?.extensionIsolation, configuration?.extensionIsolation)
  if (isolation) merged.extensionIsolation = isolation
  return merged
}

/**
 * Read the profile layers shared by CLI and daemon boot.
 *
 * The returned object deliberately contains inputs only; resolution and validation remain in the
 * Host profile resolver. Callers that expose CLI errors should translate the ordinary Errors from
 * this function into their own BootError/UsageError types at that boundary.
 */
export async function readConfigurationProfileInputs(
  options: ConfigurationProfileInputsOptions,
): Promise<ProfileInputs> {
  const profile = checkProfileName(options.profile)
  const profileDir = join(options.home, 'profiles', profile)
  const user = readYamlIf<RuntimeProfileManifest>(join(profileDir, 'profile.yaml'))
  const local = readYamlIf<Partial<RuntimeProfileManifest>>(join(options.cwd, AGH_DIR, 'profile.local.yaml'))

  // A supplied lock is a test seam and wins over the profile's lockfile. If no lockfile exists,
  // leave the lock key absent so the resolver sees the same empty-lock fallback as CLI boot.
  const projected =
    options.lock === undefined && existsSync(lockPath(profileDir))
      ? lockState(readLock(profileDir, { profile, agnesVersion: options.agnesVersion }), { profileDir })
      : undefined
  const lock = options.lock ?? projected?.lock
  const userLayer = mergeConfiguration(profile, user, options.configuration)

  return {
    builtin: profile,
    ...(userLayer === undefined ? {} : { user: userLayer }),
    ...(local === undefined ? {} : { local }),
    ...(lock === undefined ? {} : { lock }),
    ...(projected?.workspaceOverlay === undefined ? {} : { workspaceOverlay: projected.workspaceOverlay }),
  }
}
