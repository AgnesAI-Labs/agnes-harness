import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import { type RuntimePluginSnapshot, sameGenerationSourceIdentity } from '@agnes/package-manager'

/**
 * The same code snapshot is selected under a different verified authority: a relocated source,
 * a changed grant or capability binding. Only a fresh assembly carries that authority. Packages
 * added, removed or updated are code changes, which keep their own in-place or fork rules.
 */
export function sameCodeAuthorityChanged(
  previous: readonly RuntimePluginSnapshot[],
  next: readonly RuntimePluginSnapshot[],
): boolean {
  return previous.some((before) => {
    const after = next.find(
      ({ snapshot }) =>
        snapshot.packageId === before.snapshot.packageId &&
        snapshot.snapshotId === before.snapshot.snapshotId,
    )
    return after !== undefined && !sameGenerationSourceIdentity([before], [after])
  })
}

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
