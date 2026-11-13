import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { RuntimePluginSnapshot } from '@agnes/package-manager'

/** A generation owns its verified provenance; current profile metadata cannot backfill an archive. */
export function generationPackages(profile: ResolvedProfile, sources: readonly RuntimePluginSnapshot[]) {
  // Keep disabled package vocabulary without importing it; retained sessions keep their own code pin.
  const packages = profile.packages
    .filter(
      (pkg) => pkg.trust === 'builtin' || !sources.some((source) => source.snapshot.packageId === pkg.id),
    )
    .map((pkg) => (pkg.trust === 'builtin' ? pkg : { ...pkg, enabled: false }))
  for (const { snapshot } of sources) {
    const previous = profile.packages.find((pkg) => pkg.id === snapshot.packageId)
    packages.push({
      ...previous,
      id: snapshot.packageId,
      version: snapshot.version,
      integrity: snapshot.integrity,
      source: snapshot.source?.ref ?? 'runtime-snapshot',
      trust: 'trusted',
      enabled: true,
    })
  }
  return packages
}
