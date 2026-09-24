import { realpathSync } from 'node:fs'

type Profile = Readonly<{
  seams: Record<string, string>
  provider: Readonly<{ package: string; adapters: readonly string[] }>
  adapters: Record<string, unknown>
  packages: readonly Readonly<{
    id: string
    enabled: boolean
    trust: string
    version: string
    integrity: string
  }>[]
}>
type Installed = Readonly<{
  id: string
  entry: Readonly<{ version: string; integrity: string }>
  directory: string | null
  trusted: boolean
  enabled: boolean
  contributions: readonly Readonly<{ kind: string }>[]
  blockers: readonly unknown[]
}>

/** Select only inventory rows that can run outside the Host process without widening trust. */
export function selectIsolatedPackages<T extends Installed>(
  profile: Profile,
  inventory: readonly T[],
  dirs: ReadonlyMap<string, string>,
): ReadonlyMap<string, T> {
  const eligible = new Map<string, T>()
  const assembly = new Set([
    ...Object.values(profile.seams),
    profile.provider.package,
    ...profile.provider.adapters,
    ...Object.values(profile.adapters).filter((value): value is string => typeof value === 'string'),
  ])
  for (const row of inventory) {
    const pkg = profile.packages.find(
      (candidate) => candidate.id === row.id && candidate.enabled && candidate.trust === 'trusted',
    )
    const dir = dirs.get(row.id)
    if (
      assembly.has(row.id) ||
      !pkg ||
      !dir ||
      !row.directory ||
      !row.enabled ||
      !row.trusted ||
      row.blockers.length ||
      row.entry.version !== pkg.version ||
      row.entry.integrity !== pkg.integrity ||
      realpathSync(row.directory) !== realpathSync(dir) ||
      row.contributions.some(
        (contribution) => contribution.kind !== 'extension' && contribution.kind !== 'surface',
      )
    )
      continue
    eligible.set(row.id, row)
  }
  return eligible
}
