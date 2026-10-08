import type { BundleCatalog, ResolvedComposition } from '@agnes/host-common/profile/composition'
import type { LiveCompositionSession } from '@agnes/host-providers/profile/composition-state'
import type { Host, HostSession } from '../host.js'
import { compositionToolGroups } from './composition-visibility.js'

/** Both legacy and composition Hosts publish the resolver's actual session facts. */
export function describeCapabilitySession(
  host: Host,
  session: HostSession,
  tree: ResolvedComposition,
  bundles?: BundleCatalog,
): LiveCompositionSession {
  const capabilities = host.sessionCapabilities!(session.key)
  return {
    sessionKey: session.key,
    ...(capabilities.codePin.generationId ? { generationId: capabilities.codePin.generationId } : {}),
    compositionHash: tree.hash,
    preset: capabilities.preset,
    bundles: tree.bundles,
    capabilities,
    toolGroups: compositionToolGroups(session.currentTools(), tree, bundles),
    providers: {
      loop: capabilities.loop.value,
      modelAdapters: [...capabilities.selectedModelAdapters],
      compaction: capabilities.compaction.engine ? { engine: capabilities.compaction.engine } : null,
      persistence: { provider: capabilities.persistence.provider },
      sandbox: { provider: capabilities.sandbox.provider },
    },
  }
}
