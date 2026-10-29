import type { OwnerLedgerPage, OwnerLedgerPort, OwnerLedgerQuery } from '@agnes/extension-api'
import { type Actor, type JsonValue, rpcError } from '@agnes/protocol'
import { FEEDBACK_EVENT, FEEDBACK_GROWTH_EVENT, type FeedbackAuthority } from './contract.js'

const NAMES = new Map<string, string>([
  ['item', FEEDBACK_EVENT],
  ['growth', FEEDBACK_GROWTH_EVENT],
])

function denied(): never {
  throw rpcError('CAPABILITY_DENIED', { reason: 'FEEDBACK_APPEND_FORBIDDEN' })
}

/**
 * Reserved-event face of the platform append gate. Relative names only: a provider cannot
 * choose the envelope family, the session, or the actor. The authority implementation
 * re-checks ownership and stamps system/trusted.
 */
export function createFeedbackLedger(
  authority: FeedbackAuthority,
  sessionId: string | undefined,
  actor: Actor,
): OwnerLedgerPort {
  const family = (name: string): string => {
    const type = NAMES.get(name)
    if (!type) denied()
    return type
  }
  return Object.freeze({
    async scanOwn(query: OwnerLedgerQuery): Promise<OwnerLedgerPage> {
      if (!sessionId || !query?.names?.length) denied()
      const types = query.names.map((name) => family(name))
      const events = await authority.scan(sessionId, types)
      const asOfSeq = events.length > 0 ? events[events.length - 1]!.seq : 0
      return { events, asOfSeq }
    },
    async appendOwn(name: string, data: JsonValue): Promise<number> {
      if (!sessionId) denied()
      const type = family(name)
      if (!data || typeof data !== 'object' || Array.isArray(data)) denied()
      return authority.append(sessionId, type, data as Record<string, unknown>, actor)
    },
  })
}
