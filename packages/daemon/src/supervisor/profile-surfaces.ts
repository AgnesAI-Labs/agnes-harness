import type { NoticeSink } from '@agnes/daemon-foundation/local/notice'
import { createSurfaceArtifactResolver } from '@agnes/daemon-surfaces/surfaces/artifact-resolver'
import { createSurfaceController } from '@agnes/daemon-surfaces/surfaces/controller'
import { createSurfaceSecretResolver } from '@agnes/daemon-surfaces/surfaces/secret-resolver'
import type { InstalledInventory } from '@agnes/package-manager'

/** Profile-bound lifecycle hints share the existing authorized package invalidation channel. */
export function createProfileSurfaceController(
  profile: string,
  inventory: InstalledInventory,
  resolveSecret: (ref: string) => string,
  notices: NoticeSink,
) {
  let revision = 0
  return createSurfaceController({
    artifacts: createSurfaceArtifactResolver(inventory),
    secrets: createSurfaceSecretResolver(resolveSecret),
    onChange: () =>
      notices.emit('packages_changed', {
        detail: { profile, revision: `surfaces:${++revision}`, reason: 'resources' },
      }),
  })
}
