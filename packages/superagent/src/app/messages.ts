// Adapted from dsh-superagent (MIT)
/** Text a worker session is given about a trigger or a ticket input, and the names a ticket's worker session goes by. */
import { key, type Trigger, threadKey } from '../core/index.js'

/** Prefix of the session key of every ticket's worker session. */
const WORKER_KEY_PREFIX = 'superagent:worker:'
/** Returns the session key (`superagent:worker:<ticketId>`) of a ticket's worker session. */
export const workerSessionKey = (ticketId: string): string => `${WORKER_KEY_PREFIX}${ticketId}`
/** Returns the ticket ID for a worker session key, or undefined for any other key. */
export const ticketOfSessionKey = (sessionKey: string): string | undefined =>
  sessionKey.startsWith(WORKER_KEY_PREFIX) ? sessionKey.slice(WORKER_KEY_PREFIX.length) : undefined

/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
export const ASSIGNMENT_CHARS = 1500
export const TRIGGER_CHARS = 600
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
export const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(
  trigger: Trigger,
  link: { source_url?: string; source_url_read?: string },
  note?: string,
  repliesTo?: Trigger,
) {
  return {
    trigger_id: trigger.id,
    from: trigger.actor.id,
    thread: threadKey(trigger.threads[0]!),
    at: trigger.at,
    ...capped(trigger.text, TRIGGER_CHARS, `trigger/${trigger.id}`),
    ...link,
    ...(note ? { routing_note: note } : {}),
    ...(repliesTo
      ? {
          replies_to: {
            trigger_id: repliesTo.id,
            preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160),
          },
        }
      : {}),
  }
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({
  trigger_id: trigger.id,
  from: trigger.actor.id,
  at: trigger.at,
  preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160),
  read: `trigger/${trigger.id}`,
})
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string =>
  `ticket/${ticketId}/input/${key(inputId)}`
