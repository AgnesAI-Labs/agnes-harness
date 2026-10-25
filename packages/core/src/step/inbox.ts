import type { EventInput } from '@agnes/core-common/types'
import type { Inbox, InboxItem } from '@agnes/core-ledger/reduce/shapes'
import type { Actor, ContentBlock, SystemInput } from '@agnes/protocol'

export type EnqueueMsg = {
  /** Backend cancellation for attachment admission; never persisted. */
  signal?: AbortSignal
  /** Atomic admission for a continuation: refuse when another input is already pending. */
  ifEmpty?: boolean
  content: ContentBlock[]
  system?: SystemInput
  actor: Actor
  commandId?: string
  admissionId?: string
  kind?: 'prompt' | 'steer' | 'follow_up'
  titleLocale?: 'en' | 'zh-CN'
  trust?: 'trusted' | 'untrusted'
  /** Backend-owned provenance; system inputs are always untrusted. Never accepted from RPC payloads. */
  origin?: 'principal' | 'system'
  /** Replaces `budget.per_request_cap` for the one next turn opened by this inbox item. The value
   * is ledger-bound to the item and turn, so worker recovery cannot lose or leak it. */
  budget?: number
  /** Enforce the override as a durable total turn ceiling, with no approval escalation. */
  hardBudget?: boolean
  /** Caps the model steps of the one next turn opened by this item; lowers, never raises, the preset's. */
  maxSteps?: number
}

/**
 * The actor attribute a client sets on an input when no person attends the turn it opens (`agh -p`,
 * `agh run`, `runHeadless`). It only takes capability away, so it is honoured from any origin.
 */
export const UNATTENDED_ACTOR_ATTR = { key: 'interaction', value: 'unattended' } as const

export function unattendedInput(actor: Pick<Actor, 'attrs'> | undefined): boolean {
  return actor?.attrs?.[UNATTENDED_ACTOR_ATTR.key] === UNATTENDED_ACTOR_ATTR.value
}

/** Reference text is external evidence even when embedded in an authenticated human prompt. */
export function inputTainted(item: Pick<InboxItem, 'content' | 'trust' | 'origin'>): boolean {
  return (
    item.origin === 'system' ||
    item.trust === 'untrusted' ||
    item.content.some((block) => block.type === 'text' && block.reference !== undefined)
  )
}
export function inputMessageEvents(item: InboxItem, lane: string): EventInput[] {
  const untrusted = item.origin === 'system' || item.trust === 'untrusted'
  const human = untrusted ? [] : item.content.filter((block) => !(block.type === 'text' && block.reference))
  const external = untrusted
    ? item.content
    : item.content.filter((block) => block.type === 'text' && block.reference)
  const message = (
    content: ContentBlock[],
    origin: 'principal' | 'system',
    trust: 'trusted' | 'untrusted',
  ): EventInput => ({
    type: 'user/message',
    origin,
    trust,
    actor: item.actor,
    lane,
    data: {
      content,
      kind: item.kind ?? 'prompt',
      ...(origin === 'system' && item.system ? { system: item.system } : {}),
      ...(item.titleLocale ? { titleLocale: item.titleLocale } : {}),
    },
  })
  return [
    ...(human.length ? [message(human, 'principal', 'trusted')] : []),
    ...(external.length ? [message(external, 'system', 'untrusted')] : []),
  ]
}

export type InboxBudgetOverride = { itemId: string; creditsCap: number; hard?: true }
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
