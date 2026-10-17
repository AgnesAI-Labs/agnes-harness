import { clientModule, type ModuleIdentity } from '@agnes/web-client'
import type { ClientModulesRuntime } from '../src/client-modules/boot.js'
import { apply as conversationPresentation } from '../src/presentations/conversation.js'
import { apply as navigationPresentation } from '../src/presentations/navigation.js'

/** Mount the shipped default experiences through their public module facade. */
export async function mountReleasePresentations(runtime: ClientModulesRuntime): Promise<void> {
  // Release defaults use the same scoped module adapter as installed presentations.
  for (const [packageId, apply, presentationRoles] of [
    ['@agnes/navigation-ui', navigationPresentation, ['navigation']],
    ['@agnes/conversation-ui', conversationPresentation, ['conversation', 'composer']],
  ] as const) {
    const identity: ModuleIdentity = {
      packageId,
      revision: 'fixture-release',
      clientId: packageId.slice('@agnes/'.length),
      presentationRoles,
      slotCatalogVersion: 'dsh-client-slots/v1',
      binding: {
        owner: packageId,
        packageId,
        integrity: `sha256-${'a'.repeat(64)}`,
        profileId: 'local-dev',
        activationId: 'fixture-release',
        lifetime: 'profile',
        availability: 'active',
      },
    }
    await runtime.ctx.plugin(clientModule({ apply }), identity)
  }
}
