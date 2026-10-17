import { type Context, Service } from '@agnes/cordis'
import type { ClientModuleRosterRow } from '@agnes/protocol/gen/package-admin'

/** Presentation-only host seats. Roster rows come from the authenticated host, never UI payloads. */
export interface PresentationHost {
  navigation?: import('./presentation-ports.js').NavigationPresentationPort
  conversation?: import('./presentation-ports.js').ConversationPresentationPort
  composer?: import('./presentation-ports.js').ComposerPresentationPort
  revealConversation?(): void
  focusApproval?(): void
  listComponents?(sessionId: string): Promise<readonly ClientModuleRosterRow[]>
  subscribeComponents?(listener: () => void): () => void
}
export class PresentationService extends Service {
  constructor(
    ctx: Context,
    readonly host: PresentationHost = {},
  ) {
    super(ctx, 'presentation')
  }
}
