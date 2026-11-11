import type { Actor } from '@agnes/protocol'
import type { SessionImpl } from './session.js'
import { childInputActor } from './turn-restore.js'

/**
 * Attributes on the actor of the input that opened the session. Only the backend mints them on a
 * plugin-managed session's first input, a child's first input carries its parent's, and each one
 * only takes capability away.
 */
export const OPENING_INPUT_ATTRS = {
  experienceExcluded: { key: 'experience', value: 'excluded' },
  memoryWritesOff: { key: 'memoryWrites', value: 'off' },
} as const

async function openingAttrs(s: SessionImpl): Promise<Record<string, unknown> | undefined> {
  const [first] = await s.scan({ type: 'user/message', lane: s.lane, limit: 1 })
  return (first?.actor as { attrs?: Record<string, unknown> } | undefined)?.attrs
}

export async function openedWith(
  s: SessionImpl,
  attr: (typeof OPENING_INPUT_ATTRS)[keyof typeof OPENING_INPUT_ATTRS],
): Promise<boolean> {
  return (await openingAttrs(s))?.[attr.key] === attr.value
}

/**
 * Whether the session was opened with memory writes off. Every durable memory writer checks it: the
 * memory port a tool call gets, a memory-file approval, a save to the workspace or user memory, and
 * the renewal of a saved entry. Entries kept only in the session's own ledger are not memory writes.
 */
export function memoryWritesOff(s: SessionImpl): Promise<boolean> {
  return openedWith(s, OPENING_INPUT_ATTRS.memoryWritesOff)
}

/**
 * The actor for a child's input. A child whose ledger starts from its parent's history already opens
 * with the parent's first input; a role child starts a fresh ledger, so its input carries every
 * restriction the parent opened with.
 */
export async function childFirstInputActor(parent: SessionImpl, child: SessionImpl): Promise<Actor> {
  const actor = childInputActor(parent, child.d.actor)
  if (child.d.log.parent !== undefined) return actor
  const opened = await openingAttrs(parent)
  let attrs = actor.attrs
  for (const attr of Object.values(OPENING_INPUT_ATTRS))
    if (opened?.[attr.key] === attr.value) attrs = { ...attrs, [attr.key]: attr.value }
  return attrs === actor.attrs ? actor : { ...actor, attrs }
}
