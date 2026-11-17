import type { ResolvedPackage, ResolvedProfile } from '@agnes/host-common/profile/types'
import {
  type PluginGenerationSnapshot,
  type RuntimePluginSnapshot,
  sameGenerationSourceIdentity,
} from '@agnes/package-manager'
import type { Host } from '../lifecycle/host.js'

type Served = ReadonlyMap<string, Readonly<{ snapshot: PluginGenerationSnapshot; host: Host }>>
type Scope = Readonly<{
  host: () => Host | undefined
  building?: PluginGenerationSnapshot
  boot?: readonly ResolvedPackage[]
}>

/**
 * Optional host grants check a row against the verified package entry of the generation that
 * selected its snapshot, the entry a fresh container is built with. A container reads the
 * generations it serves (`live`) and the candidate it is mounting in place, so a package enabled or
 * updated after the container was built is checked as a fresh container would check it, and a
 * generation retired from the container no longer grants.
 */
export function generationGrants(profile: ResolvedProfile, live: Served) {
  const verified = new WeakMap<PluginGenerationSnapshot, readonly ResolvedPackage[]>()
  const mounting = new Map<Host, PluginGenerationSnapshot>()
  const packagesOf = (generation: PluginGenerationSnapshot): readonly ResolvedPackage[] => {
    let packages = verified.get(generation)
    if (!packages) {
      packages = Object.freeze(
        generationPackages(profile, generation.sources).map((pkg) => Object.freeze(pkg)),
      )
      verified.set(generation, packages)
    }
    return packages
  }
  const lookup =
    (scope: Scope) =>
    (packageId: string, snapshotId: string): ResolvedPackage | undefined => {
      const host = scope.host()
      const candidate = host ? mounting.get(host) : scope.building
      // Newest first: the candidate being mounted, then the published generations of this container.
      const served = [
        ...(candidate ? [candidate] : []),
        ...[...live.values()]
          .filter((generation) => host !== undefined && generation.host === host)
          .map(({ snapshot }) => snapshot)
          .reverse(),
      ]
      // The boot container keeps its boot profile until it serves its first generation.
      if (!served.length) return scope.boot?.find((pkg) => pkg.id === packageId)
      const generation = served.find(({ sources }) =>
        sources.some(
          ({ snapshot }) => snapshot.packageId === packageId && snapshot.snapshotId === snapshotId,
        ),
      )
      return generation && packagesOf(generation).find((pkg) => pkg.id === packageId)
    }
  return {
    /** The lookup of the boot container, which has no generation until it publishes one. */
    boot: (packages: readonly ResolvedPackage[], host: () => Host | undefined) =>
      lookup({ host, boot: packages }),
    /** What a container assembled from `snapshot` is given; `adopt` names it once it exists. */
    container(snapshot: PluginGenerationSnapshot, dirs?: ReadonlyMap<string, string>) {
      let adopted: Host | undefined
      const packageDirs = new Map(dirs)
      for (const { snapshot: source } of snapshot.sources) packageDirs.set(source.packageId, source.directory)
      return {
        packages: generationPackages(profile, snapshot.sources),
        packageDirs,
        generationPackage: lookup({ host: () => adopted, building: snapshot }),
        adopt: (host: Host) => (adopted = host),
      }
    },
    /** Runs an in-place publication whose rows are granted against `candidate` while they mount. */
    async mounting<T>(host: Host, candidate: PluginGenerationSnapshot, apply: () => Promise<T>) {
      mounting.set(host, candidate)
      try {
        return await apply()
      } finally {
        mounting.delete(host)
      }
    },
  }
}

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
