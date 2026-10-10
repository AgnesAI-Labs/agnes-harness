import { existsSync } from 'node:fs'
import { HostError } from '@agnes/host-common/errors'
import { capabilityHash, lockPath, readLock, type RuntimePluginSnapshot } from '@agnes/package-manager'

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
          source.snapshot.integrity === snapshot.integrity &&
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
        entry.trustDecision.capabilityHash !== snapshot.capabilityHash)
    )
      throw new HostError(
        'E_WORKSPACE_UNTRUSTED',
        `E_GENERATION_UNTRUSTED: package ${snapshot.packageId} has no current bound trust decision`,
        { detail: { packageId: snapshot.packageId, generationRestore: true } },
      )
  }
}
