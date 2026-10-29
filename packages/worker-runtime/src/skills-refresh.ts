import { assertHostPublication, type Host } from '@agnes/host'
import { RELEASE_DEFAULTS } from '@agnes/package-manager'
import type { WorkerResourceState } from '@agnes/resource-control-worker'

/** Re-publish the Skills row from a freshly bootstrapped resource generation. */
export async function refreshSkills(
  host: Host,
  input: WorkerResourceState['skillResources'] | undefined,
): Promise<void> {
  // Existing test hosts still implement the older worker facade; production Host supplies the row
  // method. Both currently route to the same single Skills row, never to managed.loadEmbedded.
  if (typeof host.refreshSkillRow === 'function') {
    assertHostPublication(await host.refreshSkillRow(input))
    return
  }
  const status = await host.reloadEcosystemExtension(
    RELEASE_DEFAULTS.skillExtension,
    input ? { skillResources: input } : {},
  )
  if (!status.loaded)
    throw new Error(`agnes/skills reload failed: ${status.error?.message ?? 'unknown error'}`)
}
