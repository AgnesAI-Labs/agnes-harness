import type { ConnectionState } from '@agnes/daemon-foundation/local/endpoint'
import type { SessionPrincipalOwnership } from '@agnes/daemon-foundation/storage/session-ownership'
import type { JsonValue, SystemInput } from '@agnes/protocol'
import type { SessionEntry } from './sessions.js'

type Message = Parameters<SessionEntry['session']['enqueue']>[1]

/** The platform's stamp on what the bundled application delivers into a session it created. */
export const BUNDLED_APP_INPUT_SOURCE = 'agnes/bundled-app'
export const BUNDLED_APP_INPUT_TYPE = 'delivery'
/** Shown in place of the body and read before it. Fixed and bounded: the body never decides what it says. */
export const BUNDLED_APP_INPUT_SUMMARY =
  'Message delivered automatically by the bundled app, not typed by a person. Its content is the data that follows.'

/**
 * The input as the session takes it: machine input from the bundled application when, and only when, all three hold
 * at delivery: the connection is the bundled application's (the proof the auth gate verified), its principal actively
 * owns the session, and the session's first reservation recorded the bundled application as its creator. Anything else,
 * including an unreadable ownership record, a session reserved before creators were kept, and a person pasting the very
 * same text, stays the ordinary input it was. The content never decides: only those server facts do.
 *
 * Machine input keeps the whole delivery as the system input's data, which the model reads, and shows the fixed
 * summary. It is always untrusted. Only one plain text block can be carried whole that way; other input stays ordinary.
 * This adds presentation facts only: the command, its admission and its receipt are the caller's, unchanged.
 */
export function withMachineOrigin(
  ownership: Pick<SessionPrincipalOwnership, 'resolve' | 'creator'> | undefined,
  conn: Pick<ConnectionState, 'bundledApp' | 'principalId'>,
  sessionId: string,
  message: Message,
): Message {
  if (conn.bundledApp !== true || !ownership || message.origin !== undefined || message.system !== undefined)
    return message
  const [block, ...rest] = message.content
  if (!block || rest.length || block.type !== 'text' || Object.keys(block).length !== 2) return message
  try {
    if (ownership.resolve(sessionId)?.principalId !== conn.principalId) return message
    if (ownership.creator(sessionId) !== 'bundled-app') return message
  } catch {
    return message
  }
  const system: SystemInput = {
    source: BUNDLED_APP_INPUT_SOURCE,
    type: BUNDLED_APP_INPUT_TYPE,
    data: deliveryData(block.text),
    summary: BUNDLED_APP_INPUT_SUMMARY,
  }
  return {
    ...message,
    content: [{ type: 'text', text: BUNDLED_APP_INPUT_SUMMARY }],
    system,
    origin: 'system',
    trust: 'untrusted',
  }
}

/**
 * The delivered text as data: the JSON value it is exactly the compact form of, so the model and an expanded trace read
 * it as the structure it is, else the text itself. Either way nothing of it is lost.
 */
function deliveryData(text: string): JsonValue {
  try {
    const value = JSON.parse(text) as JsonValue
    if (value !== null && typeof value === 'object' && JSON.stringify(value) === text) return value
  } catch {
    // Not JSON: the text is the data.
  }
  return text
}
