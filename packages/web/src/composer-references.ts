import type { Session } from '@agnes/sdk/browser'
import { createComposerReferences } from '@agnes/web-units'

/** Lazy session admission gives a new draft the same backend authority as a sent message. */
export function composerReferences(session: () => Promise<Session>, changed: () => void) {
  return createComposerReferences(async (query) => (await session()).searchReferences(query), changed)
}
