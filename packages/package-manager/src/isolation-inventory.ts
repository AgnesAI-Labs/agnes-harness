import { selectIsolatedPackages } from '@agnes/package-isolation'
import { type InstalledPackage, readInventory } from './inventory.js'
import { readLock } from './lockfile.js'

type IsolationInventoryProfile = Readonly<{
  name: string
  seams: Record<string, string>
  provider: Readonly<{ package: string; adapters: readonly string[] }>
  adapters: Record<string, unknown>
  extensionIsolation?: Readonly<{ extensions?: Record<string, string> }>
  policy: Readonly<{ capabilityCeiling: readonly string[] }>
  packages: readonly Readonly<{
    id: string
    enabled: boolean
    trust: string
    version: string
    integrity: string
  }>[]
}>
type IsolationInventoryDeps = Readonly<{ profileDir: string; dataDir: string; agnesVersion?: string }>

/** Initial boot only: reuse PackageManager's verified snapshot, never infer trust from a directory. */
export function isolationInventory(
  profile: IsolationInventoryProfile,
  deps: IsolationInventoryDeps,
  dirs: ReadonlyMap<string, string>,
): ReadonlyMap<string, InstalledPackage> {
  if (!Object.values(profile.extensionIsolation?.extensions ?? {}).some((mode) => mode !== 'off'))
    return new Map()
  try {
    const lock = readLock(deps.profileDir, {
      profile: profile.name,
      agnesVersion: deps.agnesVersion ?? '0.0.0',
    })
    if (lock.profile !== profile.name) return new Map()
    const inventory = readInventory(lock, {
      dataDir: deps.dataDir,
      profileDir: deps.profileDir,
      ceiling: profile.policy.capabilityCeiling,
      builtinDirectory: (id) => dirs.get(id),
    })
    return selectIsolatedPackages(profile, inventory.packages, dirs)
  } catch {
    // No verified generic adapter is available. Required manifests remain behind the import barrier.
    return new Map()
  }
}
