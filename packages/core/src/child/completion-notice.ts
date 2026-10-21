import { hasChildControl } from '@agnes/core-child-control/child/store'
import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { sha256Hex } from '@agnes/core-common/request/hash'
import type { SystemInput } from '@agnes/protocol'
import type { SessionImpl } from '../step/session.js'
import { childResultCollected, childResultSequence } from './collected-result.js'
import { recordedChildRole } from './roles.js'

export const CHILD_COMPLETION_SOURCE = 'agnes/child'
export const CHILD_COMPLETED = 'child-completed'

const MAX_RESULT_CHARS = 4000
const MAX_SUMMARY_RESULT_CHARS = 1200
const MAX_LABEL_CHARS = 120

type ChildOutcome = 'completed' | 'failed' | 'cancelled'

export function childCompletionId(childKey: string, outcome: ChildOutcome, endSeq?: number): string {
  const identity = endSeq === undefined ? `terminal:${outcome}` : `${endSeq}:${outcome}`
  const id = `${CHILD_COMPLETED}:${childKey}:${identity}`
  return id.length <= 128 ? id : `${CHILD_COMPLETED}:${sha256Hex(id)}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The child's last assistant text and why its last turn ended, read from durable rows. */
async function childOutcome(
  parent: SessionImpl,
  record: ChildTaskRecord,
): Promise<{ text: string; endReason?: string; endSeq: number }> {
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
}

/**
 * `data` is `{ childKey, status, continuable?, result?, truncated?, credits? }`. `status` is the child's
 * durable terminal state, or `budget_stopped` when it failed because its turn ended on a budget or step cap.
 */
export async function childCompletionInput(
  parent: SessionImpl,
  record: ChildTaskRecord,
  outcome: ChildOutcome,
  options: ChildCompletionOptions = {},
): Promise<{ system: SystemInput; commandId: string; resultSeq: number }> {
  const { text, endReason, endSeq } = await childOutcome(parent, record)
  const status =
    outcome === 'failed' && (endReason === 'budget' || endReason === 'max_steps')
      ? ('budget_stopped' as const)
      : outcome
  const role = await recordedChildRole(parent, record.childKey)
  const label = clip(
    role
      ? (role.title['zh-CN'] ?? role.title.en)
      : record.inputText.trim().split('\n', 1)[0] || record.childKey,
    MAX_LABEL_CHARS,
  )
  const result = text.trim()
  const truncated = result.length > MAX_RESULT_CHARS
  const shown = clip(result, MAX_SUMMARY_RESULT_CHARS)
  const lead = options.continuable
    ? `Background child ${record.childKey} (${label}) finished its turn and is idle; it still accepts messages.`
    : `Background child ${record.childKey} (${label}) ${status.replace('_', ' ')}.`
  const tail =
    result.length > MAX_SUMMARY_RESULT_CHARS
      ? ' Call subagent_collect with its childKey for the full output.'
      : ''
  const system: SystemInput = {
    source: CHILD_COMPLETION_SOURCE,
    type: CHILD_COMPLETED,
    data: {
      childKey: record.childKey,
      ...(role ? { role } : {}),
      status,
      ...(options.continuable ? { continuable: true } : {}),
      ...(result ? { result: clip(result, MAX_RESULT_CHARS), truncated } : {}),
      ...(options.credits === undefined ? {} : { credits: options.credits }),
    },
    summary: `${role ? `Handled by ${clip(role.title.en, MAX_LABEL_CHARS)} / 由 ${label} 处理. ` : ''}${result ? `${lead} Result:\n${shown}${tail}` : lead}`,
    presentation: { kind: 'child-completed', status, label },
  }
  // A terminal notice is keyed by the durable outcome alone: the child's last turn/end may still land
  // after a cancel, so a ledger-derived sequence would differ between live delivery and recovery.
  return {
    system,
    resultSeq: await childResultSequence(parent, record),
    commandId: childCompletionId(record.childKey, outcome, options.continuable ? endSeq : undefined),
  }
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
      skipIf: () => childResultCollected(parent, record.childKey, commandId, resultSeq),
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
    await deliverChildCompletion(parent, row, row.state as ChildOutcome).catch(() => undefined)
  }
}
