import type { ResolvedProfile } from '@agnes/host-common/profile/types'
import type { SkillRuntimeInput } from '@agnes/host-extensions/resources/skills'
import { compileRunPlan, seamSelectionsOf } from '@agnes/host-providers/assemble/run-plan'
import {
  generationResourcesDigest,
  type RuntimeGenerationSnapshotStore,
  type RuntimePluginSnapshot,
} from '@agnes/package-manager'
import { encodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { Host, HostOptions } from '../lifecycle/host.js'
import { GenerationReuseMode, reusableSnapshot } from './process-liveness.js'
import { captureGenerationResources } from './resources.js'
import { targetRows } from './target-code.js'

/** Captures the complete build inputs before choosing a reusable archive or creating a new one. */
export function createGenerationSnapshotter(deps: {
  profile(): ResolvedProfile
  options: HostOptions
  store: RuntimeGenerationSnapshotStore
  headKey: string
  preparedRows: ReadonlyMap<string, Parameters<Host['extensionRows']['prepare']>[0]>
  host(): Host
  failed(): Iterable<string>
}) {
  const { profile, options, store, headKey, preparedRows, host, failed } = deps
  return async (
    target: Parameters<Host['applyRuntimeTarget']>[0],
    sources: readonly RuntimePluginSnapshot[],
    skills: SkillRuntimeInput | undefined,
    extensionRows?: readonly ReturnType<Host['extensionRows']['prepare']>[],
    reuse = GenerationReuseMode.None,
  ) => {
    const currentProfile = profile()
    const runPlan = compileRunPlan({
      profile: currentProfile,
      ...(options.agnesVersion === undefined ? {} : { agnesVersion: options.agnesVersion }),
    })
    const compatibility = runPlan.processFacets.digest,
      packages = [
        ...currentProfile.packages
          .filter((pkg) => pkg.trust === 'builtin' && pkg.enabled !== false)
          .map((pkg) => ({ id: pkg.id, version: pkg.version })),
        ...sources.map((source) => ({ id: source.snapshot.packageId, version: source.snapshot.version })),
      ],
      resources = captureGenerationResources(
        skills,
        [...preparedRows.values()].filter((row) =>
          targetRows(target).some(
            (targetRow) => !targetRow.disabled && targetRow.id === `ext:${row.extensionId}`,
          ),
        ),
        (extensionRows ?? host().extensionRows.current()).map((row) => row.id),
      ),
      seams = seamSelectionsOf(runPlan)
    const expected = {
      artifactDigest: encodeRuntimeTargetArtifact(target).digest,
      compatibility,
      packages,
      resourcesDigest: generationResourcesDigest(resources),
      seams,
    }
    const reused = reusableSnapshot(store, headKey, expected, reuse, failed())
    return reused ?? store.createAsync(target, sources, compatibility, packages, resources, seams)
  }
}
