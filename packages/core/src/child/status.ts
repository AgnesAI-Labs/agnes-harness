import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import type { ChildStatus } from '@agnes/core-effects/effects/tool-context'
import type { SessionImpl } from '../step/session.js'
import { childResultSequence } from './collected-result.js'
import { childCompletionId } from './completion-notice.js'
import { childExecutionReceipt } from './execution-receipt.js'
import { type ChildEnd, lastChildEnd } from './failure.js'
import { retiredCompletionIdentity } from './idle-retirement-fact.js'

export function snapshotFromRecord(record: ChildTaskRecord): ChildStatus {
  const terminal = record.state === 'completed' || record.state === 'failed' || record.state === 'cancelled'
  return {
    state:
      record.state === 'failed' || record.state === 'cancelled' ? 'error' : terminal ? 'done' : 'running',
    lastSeq: 0,
    ...(record.state === 'cancelled' ? { cancelled: true as const } : {}),
    ...(terminal
      ? {
          completionId: childCompletionId(
            record.childKey,
            record.state as 'completed' | 'failed' | 'cancelled',
          ),
        }
      : {}),
  }
}

/** `end` is what the factory kept of the child's last turn; without it the ledger is read. */
export async function snapshotFromLedger(
  parent: SessionImpl,
  record: ChildTaskRecord,
  end?: ChildEnd,
): Promise<ChildStatus> {
  const base = snapshotFromRecord(record)
  try {
    const fromSeq = (record.boundarySeq + 1) as typeof record.boundarySeq
    const tail = await parent.d.log.storage.scan(record.childKey, { fromSeq, order: 'desc', limit: 1 })
    const msgs = await parent.d.log.storage.scan(record.childKey, {
      fromSeq,
      type: 'assistant/message',
      order: 'desc',
      limit: 1,
    })
    const content = (msgs[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
      ?.content
    const text = (content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    const completionSeq = base.completionId
      ? await childResultSequence(parent, record, tail[0]?.seq ?? 0)
      : undefined
    const completionId =
      completionSeq === undefined
        ? undefined
        : ((await retiredCompletionIdentity(parent, record, completionSeq)) ?? base.completionId)
    return {
      ...base,
      ...(record.state === 'failed' ? (end ?? (await lastChildEnd(parent, record))) : {}),
      ...(completionId && completionSeq !== undefined ? { completionId, completionSeq } : {}),
      lastSeq: tail[0]?.seq ?? base.lastSeq,
      ...(text ? { text } : {}),
      receipt: await childExecutionReceipt(parent, record),
    }
  } catch {
    return base
  }
}

/** Capture one completed result identity, so collecting it cannot acknowledge a later resident turn. */
export async function snapshotFromLive(
  parent: SessionImpl,
  record: ChildTaskRecord,
  snapshot: {
    state: 'ready' | 'running' | 'done' | 'error' | 'cancelled'
    lastSeq: number
    idle: boolean
    /** What the run kept of a failed last turn. */
    end?: ChildEnd | undefined
  },
): Promise<ChildStatus> {
  const { state, lastSeq, idle } = snapshot
  const terminal = state === 'done' || state === 'error' || state === 'cancelled'
  const query = { fromSeq: record.boundarySeq + 1, toSeq: lastSeq, order: 'desc' as const, limit: 1 }
  const [messages, completionSeq] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, { ...query, type: 'assistant/message', limit: 1 }),
    terminal || idle ? childResultSequence(parent, record, lastSeq) : 0,
  ])
  const content = (messages[0]?.data as { content?: Array<{ type?: string; text?: string }> } | undefined)
    ?.content
  const text = (content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  const retiredId =
    state === 'done' ? await retiredCompletionIdentity(parent, record, completionSeq) : undefined
  return {
    state: state === 'error' || state === 'cancelled' ? 'error' : state === 'done' ? 'done' : 'running',
    lastSeq,
    ...(state === 'error' ? snapshot.end : state === 'cancelled' ? { cancelled: true as const } : {}),
    ...(idle ? { idle: true } : {}),
    ...(text ? { text } : {}),
    ...(terminal || idle
      ? {
          completionSeq,
          completionId:
            retiredId ??
            childCompletionId(
              record.childKey,
              state === 'cancelled' ? 'cancelled' : state === 'error' ? 'failed' : 'completed',
              idle ? completionSeq : undefined,
            ),
        }
      : {}),
    receipt: await childExecutionReceipt(parent, record),
  }
}
