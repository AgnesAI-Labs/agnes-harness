import { hasChildControl, requireChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import type { SystemInput } from '@agnes/protocol'
import { bestEffort } from '../best-effort.js'
import type { SessionImpl } from '../step/session.js'
import { childResultCollected, childResultSequence } from './collected-result.js'
import { type ChildEnd, childEnd, childFailureSuffix, clipText as clip } from './failure.js'
import { retiredCompletionIdentity } from './idle-retirement-fact.js'
import { childBatchCounts } from './recap-snapshot.js'
import { recordedChildRole } from './roles.js'

export const CHILD_COMPLETION_SOURCE = 'agnes/child'
export const CHILD_COMPLETED = 'child-completed'

const MAX_RESULT_CHARS = 4000
const MAX_SUMMARY_RESULT_CHARS = 1200
const MAX_LABEL_CHARS = 120
/** `SystemInput.summary` in the session schema. */
const MAX_SUMMARY_CHARS = 2048

type ChildOutcome = 'completed' | 'failed' | 'cancelled'

export function childCompletionId(childKey: string, outcome: ChildOutcome, endSeq?: number): string {
  const identity = endSeq === undefined ? `terminal:${outcome}` : `${endSeq}:${outcome}`
  const id = `${CHILD_COMPLETED}:${childKey}:${identity}`
  return id.length <= 128 ? id : `${CHILD_COMPLETED}:${sha256Hex(id)}`
}

/** The child's last assistant text and why its last turn ended, read from durable rows. */
async function childOutcome(
  parent: SessionImpl,
  record: ChildTaskRecord,
): Promise<{ text: string; endReason?: string; endSeq: number; end: ChildEnd }> {
  const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
  const [message, end] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, {
      type: 'assistant/message',
      fromSeq,
      order: 'desc',
      limit: 1,
    }),
    parent.d.log.storage.scan(record.childKey, { type: 'turn/end', fromSeq, order: 'desc', limit: 1 }),
  ])
  const endReason = (end[0]?.data as { reason?: string } | undefined)?.reason
  const content = (message[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content
  return {
    endSeq: end[0]?.seq ?? 0,
    text: (content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(''),
    ...(endReason ? { endReason } : {}),
    end: childEnd(end[0]?.data),
  }
}

/**
 * Background children are the ones a tool started for the parent to read later. Awaited forks and
 * loop-owned children report through their caller, so the effect id of their creation says no.
 */
export function isBackgroundChild(parent: SessionImpl, record: ChildTaskRecord): boolean {
  const effect = record.creationId.slice(`${parent.key}:${parent.lane}:`.length)
  return effect.length > 0 && !effect.startsWith('direct:') && !effect.startsWith('loop-child-')
}

export type ChildCompletionOptions = {
  credits?: number
  /** The child went idle after a turn and still accepts messages; it has not ended. */
  continuable?: boolean
  /** What the factory kept of the failed last turn; without it the child's ledger is read. */
  end?: ChildEnd | undefined
}

async function batchFacts(parent: SessionImpl) {
  const { idle, hasIncompleteWork, ...counts } = await childBatchCounts(parent)
  const { completed, total, waitingApproval, running, paused, disconnected, failed } = counts
  const settled = completed + idle
  const line = `[Batch State: completed=${settled}/${total}, waiting_approval=${waitingApproval}, running=${running}, paused=${paused}, disconnected=${disconnected}, failed=${failed}]`
  const warning = 'DO NOT report overall batch completion; unresolved subtasks remain.'
  return {
    suffix: hasIncompleteWork ? `\n${line}\n${warning}` : `\n${line}`,
    data: {
      batchState: { ...counts, completed: settled, hasIncompleteWork },
      pendingApprovalsCount: waitingApproval,
      activeSiblingsCount: running,
      pausedCount: paused,
      disconnectedCount: disconnected,
    },
  }
}

export async function childCompletionInput(
  parent: SessionImpl,
  record: ChildTaskRecord,
  outcome: ChildOutcome,
  options: ChildCompletionOptions = {},
): Promise<{ system: SystemInput; commandId: string; resultSeq: number }> {
  const { text, endReason, endSeq, end } = await childOutcome(parent, record)
  const status =
    outcome === 'failed' && (endReason === 'budget' || endReason === 'max_steps')
      ? ('budget_stopped' as const)
      : outcome
  const error = status === 'failed' ? (options.end ?? end).error : undefined
  const role = await recordedChildRole(parent, record.childKey)
  const label = clip(
    role
      ? (role.title['zh-CN'] ?? role.title.en)
      : record.inputText.trim().split('\n', 1)[0] || record.childKey,
    MAX_LABEL_CHARS,
  )
  const batch = await batchFacts(parent)
  const summaryLimit = MAX_SUMMARY_CHARS - batch.suffix.length
  const result = text.trim()
  const truncated = result.length > MAX_RESULT_CHARS
  const handled = role ? `Handled by ${clip(role.title.en, MAX_LABEL_CHARS)} / 由 ${label} 处理. ` : ''
  const lead = options.continuable
    ? `Background child ${record.childKey} (${label}) finished its turn and is idle; it still accepts messages.`
    : `Background child ${record.childKey} (${label}) ${status.replace('_', ' ')}${childFailureSuffix(error ? { error } : {})}.`
  // The result gives way first: who ended and why must fit the summary limit whole.
  const more = ' Call subagent_collect with its childKey for the full output.'
  const head = `${handled}${lead} Result:\n`
  const room = Math.min(MAX_SUMMARY_RESULT_CHARS, summaryLimit - head.length - more.length)
  const summary =
    clip(
      !result
        ? `${handled}${lead}`
        : room < 1
          ? `${handled}${lead}${more}`
          : `${head}${clip(result, room)}${result.length > room ? more : ''}`,
      summaryLimit,
    ) + batch.suffix
  const system: SystemInput = {
    source: CHILD_COMPLETION_SOURCE,
    type: CHILD_COMPLETED,
    data: {
      ...batch.data,
      childKey: record.childKey,
      ...(role ? { role } : {}),
      status,
      ...(options.continuable ? { continuable: true } : {}),
      ...(error ? { error } : {}),
      ...(result ? { result: clip(result, MAX_RESULT_CHARS), truncated } : {}),
      ...(options.credits === undefined ? {} : { credits: options.credits }),
    },
    summary,
    presentation: { kind: 'child-completed', status, label },
  }
  // A terminal notice is keyed by the durable outcome alone: the child's last turn/end may still land
  // after a cancel, so a ledger-derived sequence would differ between live delivery and recovery.
  const resultSeq = await childResultSequence(parent, record)
  const retiredId =
    outcome === 'completed' && !options.continuable
      ? await retiredCompletionIdentity(parent, record, resultSeq)
      : undefined
  return {
    system,
    resultSeq,
    commandId:
      retiredId ?? childCompletionId(record.childKey, outcome, options.continuable ? endSeq : undefined),
  }
}

/** True when `commandId` was already queued either standalone or inside a coalesced `child-batch-completed` item. */
async function childCompletionDelivered(parent: SessionImpl, commandId: string): Promise<boolean> {
  for await (const rows of scanPages((query) => parent.scan(query), {
    type: 'inbox',
    lane: parent.lane,
    toSeq: parent.lastSeq,
  })) {
    for (const row of rows) {
      if (row.origin !== 'system' || row.trust !== 'trusted') continue
      for (const item of (row.data as Inbox).items) {
        if (item.origin !== 'system' || item.system?.source !== CHILD_COMPLETION_SOURCE) continue
        if (item.commandId === commandId) return true
        if (item.system.type !== 'child-batch-completed') continue
        const children = (item.system.data as { children?: { commandId?: string }[] } | null)?.children
        if (children?.some((child) => child.commandId === commandId)) return true
      }
    }
  }
  return false
}

/**
 * Exactly one wakeup per uncollected result: the commandId dedupes against the parent's inbox history, so the live
 * path, a retried close and the recovery scan converge. A closed parent cannot take it; recovery
 * delivers it the next time the parent opens.
 */
export async function deliverChildCompletion(
  parent: SessionImpl,
  record: ChildTaskRecord,
  outcome: ChildOutcome,
  options: ChildCompletionOptions = {},
): Promise<void> {
  if (parent.closingOrClosed || !isBackgroundChild(parent, record)) return
  const { system, commandId, resultSeq } = await childCompletionInput(parent, record, outcome, options)
  await parent.enqueue(
    'next-turn',
    {
      content: [{ type: 'text', text: system.summary }],
      system,
      actor: parent.d.actor,
      commandId,
      kind: 'follow_up',
      trust: 'untrusted',
      origin: 'system',
    },
    {
      dedupeByCommandId: true,
      skipIf: async () =>
        (await childResultCollected(parent, record.childKey, commandId, resultSeq)) ||
        (await childCompletionDelivered(parent, commandId)),
    },
  )
}

/** A revision identifies one occurrence. Retried delivery dedupes, a later recurrence can wake the parent. */
export async function deliverChildStateNotice(
  parent: SessionImpl,
  record: ChildTaskRecord,
  state: 'waiting_approval' | 'disconnected' | 'paused',
  detail?: string,
): Promise<void> {
  if (parent.closingOrClosed || !isBackgroundChild(parent, record)) return
  const { childKey, stateRevision } = record
  const batch = await batchFacts(parent)
  const text = detail ? clip(detail, MAX_SUMMARY_RESULT_CHARS) : ''
  const lead = `Background child ${childKey} is ${state}.${text ? ` ${text}` : ''}`
  const summary = clip(lead, MAX_SUMMARY_CHARS - batch.suffix.length) + batch.suffix
  const commandId = `child-state:${sha256Hex(JSON.stringify([childKey, stateRevision, state]))}`
  const system: SystemInput = {
    source: CHILD_COMPLETION_SOURCE,
    type: 'child-state',
    summary,
    data: { ...batch.data, childKey, state, ...(text ? { detail: text } : {}) },
  }
  await parent.enqueue(
    'next-turn',
    {
      content: [{ type: 'text', text: summary }],
      system,
      actor: parent.d.actor,
      commandId,
      kind: 'follow_up',
      trust: 'untrusted',
      origin: 'system',
    },
    {
      dedupeByCommandId: true,
      skipIf: async () => {
        const current = await requireChildControl(parent.d.log.storage).lookupByKey(childKey)
        return current?.state !== state || current.stateRevision !== stateRevision
      },
    },
  )
}

/** Delivers the notices a crash or a closed parent left undelivered. */
export async function recoverChildCompletions(parent: SessionImpl): Promise<void> {
  const storage = parent.d.log.storage
  if (!hasChildControl(storage)) return
  const rows = await storage.listByParent(parent.key).catch(() => [])
  for (const row of rows) {
    if (row.creationPhase !== 'committed' || !isTerminalChildState(row.state)) continue
    await deliverChildCompletion(parent, row, row.state as ChildOutcome).catch(
      bestEffort(parent.d.logger, 'child-completion-recovery'),
    )
  }
}
