import type { Actor } from '@agnes/protocol'
import type { EventInput } from '../types.js'

/**
 * A row the harness itself writes, on a session's lane. Every segment writes rows of this shape and
 * none of them varies it, so it is spelled once: a segment that has to differ says so in `extra`,
 * which keeps the difference visible at the call site instead of hidden in a second spelling.
 */
export function sysEvent(
  o: { actor: Actor; lane: string },
  type: string,
  data: unknown,
  extra: Partial<EventInput> = {},
): EventInput {
  return {
    type,
    origin: 'system',
    trust: 'trusted',
    actor: o.actor,
    lane: o.lane,
    data: data as EventInput['data'],
    ...extra,
  }
}
