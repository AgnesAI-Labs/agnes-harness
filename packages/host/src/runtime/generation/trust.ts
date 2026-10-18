import { existsSync } from 'node:fs'
import { HostError } from '@agnes/host-common/errors'
import { capabilityHash, lockPath, type RuntimePluginSnapshot, readLock } from '@agnes/package-manager'
import type { HostOptions } from '../lifecycle/host.js'

/** Code pins preserve an approved snapshot, never a revoked package grant. Enablement is independent. */
export async function assertGenerationTrust(
  sources: readonly RuntimePluginSnapshot[],
  profileDir: string,
  profile: string,
  agnesVersion: string,
  currentSources?: () => Promise<readonly RuntimePluginSnapshot[]>,
): Promise<void> {
  if (!sources.length) return
  // Explicit source providers (such as isolated author hosts) can own trust without a package
  // lock. Re-read that authority and require the exact binding; archived/boot-time sources do not
  // qualify. Once a lock exists, it is authoritative even if the provider has stale entries.
  const approved = !existsSync(lockPath(profileDir)) && currentSources ? await currentSources() : []
  const lock = readLock(profileDir, { profile, agnesVersion })
  for (const { snapshot, trusted } of sources) {
    const entry = lock.packages[snapshot.packageId]
    if (
      !entry &&
      !existsSync(lockPath(profileDir)) &&
      approved.some(
        (source) =>
          source.trusted &&
          source.snapshot.packageId === snapshot.packageId &&
          source.snapshot.snapshotId === snapshot.snapshotId &&
          source.snapshot.version === snapshot.version &&
          source.snapshot.integrity === snapshot.integrity &&
          source.snapshot.treeIntegrity === snapshot.treeIntegrity &&
          source.snapshot.capabilityHash === snapshot.capabilityHash,
      )
    )
      continue
    // The immutable archive attests its original integrity/capability binding. The current
    // package grant must still be valid, even when an upgrade has changed its reviewed code.
    if (
      !trusted ||
      !entry ||
      entry.state.trusted === null ||
      entry.trustDecision?.integrity !== entry.integrity ||
      entry.trustDecision.capabilityHash !== capabilityHash(entry) ||
      (entry.integrity === snapshot.integrity &&
        (entry.version !== snapshot.version ||
          entry.treeIntegrity !== snapshot.treeIntegrity ||
          entry.trustDecision.capabilityHash !== snapshot.capabilityHash))
    )
      throw new HostError(
        'E_WORKSPACE_UNTRUSTED',
        `E_GENERATION_UNTRUSTED: package ${snapshot.packageId} has no current bound trust decision`,
        { detail: { packageId: snapshot.packageId, generationRestore: true } },
      )
  }
}

/** Let each publisher resolve explicit development reloads as well as installed source identities. */
export function generationSourceReader(
  options: Pick<HostOptions, 'runtimePluginSources' | 'runtimePluginCatalogue' | 'runtimePluginSnapshots'>,
  development: ReadonlyMap<string, RuntimePluginSnapshot>,
) {
  return async () => {
    const available =
      (await options.runtimePluginSources?.()) ??
      options.runtimePluginCatalogue ??
      options.runtimePluginSnapshots ??
      []
    return [
      ...new Map(
        [...available, ...development.values()].map(
          (source) => [`${source.snapshot.packageId}@${source.snapshot.snapshotId}`, source] as const,
        ),
      ).values(),
    ]
  }
}

/** Authoring rechecks the existing generation trust authority even inside an already-open turn. */
export function generationAuthoringAuthority(
  options: Pick<HostOptions, 'profileDir' | 'agnesVersion' | 'runtimePluginSources' | 'pluginManage'>,
  profile: string,
  sourcesFor: (sessionKey: string) => readonly RuntimePluginSnapshot[] | undefined,
) {
  const assertTrust = (sources: readonly RuntimePluginSnapshot[]) =>
    assertGenerationTrust(
      sources,
      options.profileDir,
      profile,
      options.agnesVersion ?? '0.0.0',
      options.runtimePluginSources,
    )
  const bridge = options.pluginManage
  const pluginManage: HostOptions['pluginManage'] =
    bridge &&
    (async (invocation, signal) => {
      signal.throwIfAborted()
      const sources = sourcesFor(invocation.sessionKey)
      if (!sources)
        throw Object.assign(new Error('Authoring generation is unavailable'), {
          code: 'PLUGIN_MANAGEMENT_UNAVAILABLE',
        })
      await assertTrust(sources)
      signal.throwIfAborted()
      return bridge(invocation, signal)
    })
  return { assertTrust, pluginManage }
}
