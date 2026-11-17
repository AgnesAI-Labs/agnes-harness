import { BUNDLED_APP_CLIENT_PREFIX } from '@agnes/daemon-foundation/local/bundled-app'
import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { SessionEntry } from './sessions.js'

type Message = Parameters<SessionEntry['session']['enqueue']>[1]

/**
 * The input with the display-only fact that the bundled application delivered it, when, and only when, all three hold
 * at delivery: the connection is the bundled application's (the proof the auth gate verified for its client id), its
 * principal actively owns the session, and the session's first reservation recorded the bundled application as its
 * creator. Anything else, including an unreadable ownership record, a session reserved before creators were kept, and a
 * person pasting the very same text, is returned as it came. The content never decides: only those server facts do.
 *
 * The fact only lets a reader tell an app's delivery from a person's message. The input keeps its trust, its place in
 * the queue and what the model reads, and its command, admission and receipt are the caller's, unchanged.
 */
export function withDeliveredBy(
  ownership: Pick<SessionPrincipalOwnership, 'resolve' | 'creator'> | undefined,
  conn: Pick<ConnectionState, 'bundledApp' | 'principalId' | 'clientId'>,
  sessionId: string,
  message: Message,
): Message {
  if (conn.bundledApp !== true || !ownership || !conn.clientId.startsWith(BUNDLED_APP_CLIENT_PREFIX))
    return message
  const appId = conn.clientId.slice(BUNDLED_APP_CLIENT_PREFIX.length)
  if (!appId || appId.length > 256) return message
  try {
    if (ownership.resolve(sessionId)?.principalId !== conn.principalId) return message
    if (ownership.creator(sessionId) !== 'bundled-app') return message
  } catch {
    return message
  }
  return { ...message, deliveredBy: { kind: 'bundled-app', appId } }
}
