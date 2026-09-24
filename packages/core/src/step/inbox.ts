import type { Actor, ContentBlock } from '@agnes/protocol'
import type { Inbox, InboxItem } from '../reduce/shapes.js'
import type { EventInput } from '../types.js'

export type EnqueueMsg = {
  content: ContentBlock[]
  actor: Actor
  commandId?: string
  admissionId?: string
  kind?: 'prompt' | 'steer' | 'follow_up'
  trust?: 'trusted' | 'untrusted'
  /** Replaces `budget.per_request_cap` for the one next turn opened by this inbox item. The value
   * is ledger-bound to the item and turn, so worker recovery cannot lose or leak it. */
  budget?: number
}

export type InboxBudgetOverride = { itemId: string; creditsCap: number }
export type TurnBudgetOverride = InboxBudgetOverride & { turn: number }

export const INBOX_BUDGET_EVENT = 'x/core/inbox-budget'
export const TURN_BUDGET_EVENT = 'x/core/turn-budget'

export function budgetOverrideEvent(
  type: typeof INBOX_BUDGET_EVENT | typeof TURN_BUDGET_EVENT,
  actor: Actor,
  data: InboxBudgetOverride | TurnBudgetOverride,
): EventInput {
  return {
    type,
    origin: 'system',
    trust: 'trusted',
    actor,
    data,
    ignorable: true,
  }
}

/** The inbox is one register cell holding the whole queue, so every write replaces it entire. */
export function inboxEvent(lane: string, actor: Actor, value: Inbox): EventInput {
  return { type: 'inbox', register: 'inbox', lane, origin: 'system', trust: 'trusted', actor, data: value }
}

/**
 * Takes the first item for a target without writing anything: the caller decides which transaction
 * the removal belongs in, and both callers put it in the same batch as the message it becomes.
 */
export function claimFrom(
  inbox: Inbox | undefined,
  target: InboxItem['target'],
): { item: InboxItem; rest: Inbox } | null {
  const items = inbox?.items ?? []
  const idx = items.findIndex((i) => i.target === target)
  if (idx === -1) return null
  return { item: items[idx] as InboxItem, rest: { items: items.filter((_, i) => i !== idx) } }
}

export const TRIGGER: Record<NonNullable<EnqueueMsg['kind']>, 'prompt' | 'steer' | 'follow_up'> = {
  prompt: 'prompt',
  steer: 'steer',
  follow_up: 'follow_up',
}
