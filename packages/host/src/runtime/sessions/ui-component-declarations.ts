import { CompositionSessionStore } from '@agnes/host-providers/profile/composition-state'
import { clientModuleRowIdForContribution, RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import { decodeRuntimeTargetArtifact } from '@agnes/plugin-runtime/host'
import type { UiComponentDeclaration } from '@agnes/protocol/gen/extension-manifest'
import { compositionModuleAllowed } from '../profile/composition-visibility.js'

/** No current installation fallback: the durable session pin is the authority for payload schemas. */
export function readUiComponentDeclarations(
  profileDir: string,
  sessionKey: string,
): readonly UiComponentDeclaration[] {
  const store = new RuntimeGenerationSnapshotStore(profileDir)
  const pin = store.session(sessionKey)
  if (!pin) return []
  const generation = store.read(pin.generationId)
  const target = decodeRuntimeTargetArtifact(generation.artifact)
  const selection = new CompositionSessionStore(profileDir).read(sessionKey)?.tree.selection
  return generation.sources.flatMap((source) => {
    if (!source.trusted) return []
    const { snapshot } = source
    const clients = snapshot.contributions.flatMap((entry) =>
      (entry.kind === 'client' || entry.kind === 'extension') && 'client' in entry && entry.client
        ? [
            {
              id: entry.id,
              client: entry.client,
              backendRowId: entry.kind === 'client' ? entry.rowId : undefined,
            },
          ]
        : [],
    )
    return clients.flatMap((entry) => {
      const id = clientModuleRowIdForContribution(
        snapshot.packageId,
        entry.id,
        clients.length,
        entry.client.id ?? entry.id,
      )
      if (
        !target.tree.rows.some((row) => row.id === id && !row.disabled) ||
        !compositionModuleAllowed(selection, {
          id,
          aliases: [entry.id, snapshot.packageId],
          slots: entry.client.slots ?? [],
        })
      )
        return []
      if (
        entry.backendRowId &&
        !target.tree.rows.some((row) => row.id === entry.backendRowId && !row.disabled)
      )
        return []
      return entry.client.intelligentComponents ?? []
    })
  })
}
