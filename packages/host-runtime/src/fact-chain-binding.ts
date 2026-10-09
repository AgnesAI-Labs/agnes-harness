import { CompositionSessionStore } from '@agnes/host-providers/profile/composition-state'
import { RuntimeGenerationSnapshotStore } from '@agnes/package-manager'
import type { FactChainNode } from '@agnes/protocol'

/** Read existing historical records without assembling a Host, importing code or repinning a session. */
export function readFactChainBinding(
  profileDir: string,
  sessionKey: string,
  generationId: string | null,
): FactChainNode[] {
  const nodes: FactChainNode[] = []
  const binding = new CompositionSessionStore(profileDir).read(sessionKey)
  if (binding)
    nodes.push({
      id: `composition:${binding.tree.hash}`,
      kind: 'composition',
      compositionHash: binding.tree.hash,
      bundles: [...binding.tree.bundles].slice(0, 128),
    })
  // A current session pin may have migrated. Only a call-time generation is eligible here.
  if (generationId) {
    const generation = new RuntimeGenerationSnapshotStore(profileDir).read(generationId)
    if (generation.sources.length > 128) throw new Error('Fact-chain generation exceeds metadata bound')
    nodes.push({
      id: `generation:${generationId}`,
      kind: 'generation',
      generationId,
      packages: generation.sources.map(({ snapshot }) => ({
        packageId: snapshot.packageId,
        version: snapshot.version,
        snapshotId: snapshot.snapshotId,
        integrity: snapshot.integrity,
        treeIntegrity: snapshot.treeIntegrity,
      })),
    })
  }
  return nodes
}
