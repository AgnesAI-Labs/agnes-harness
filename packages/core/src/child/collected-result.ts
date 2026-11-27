import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import type { JsonValue, SystemInput } from '@agnes/protocol'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'
import { childCompletionId } from './completion-notice.js'
import { childFailureSuffix, clipText } from './failure.js'

const COLLECTED = 'x/core/child-result-collected'

export type BatchChildEntry = Record<string, JsonValue> & {
  childKey?: string
  commandId?: string
  resultSeq?: number
  status?: string
  label?: string
  summary?: string
  continuable?: boolean
  omitClosingText?: boolean
  error?: { code?: string; message?: string }
  handoff?: JsonValue
}

function batchChildSummary(child: BatchChildEntry): string {
  if (typeof child.summary === 'string' && child.summary) return child.summary
  const key = typeof child.childKey === 'string' && child.childKey ? child.childKey : 'child'
  if (child.omitClosingText === true) return `Child ${key} reported to its parent.`
  const status = typeof child.status === 'string' && child.status ? child.status : 'completed'
  const label = typeof child.label === 'string' && child.label ? ` (${child.label})` : ''
  const error =
    status === 'failed' &&
    child.error &&
    typeof child.error === 'object' &&
    !Array.isArray(child.error) &&
    typeof child.error.code === 'string' &&
    typeof child.error.message === 'string'
      ? childFailureSuffix({ error: { code: child.error.code, message: child.error.message } })
      : ''
  const lead =
    child.continuable === true
      ? `Background child ${key}${label} finished its turn and is idle; it still accepts messages.`
      : `Background child ${key}${label} ${status.replace('_', ' ')}${error}.`
  const handoff =
    typeof child.handoff === 'string'
      ? child.handoff
      : child.handoff &&
          typeof child.handoff === 'object' &&
          !Array.isArray(child.handoff) &&
          typeof child.handoff.findings === 'string'
        ? child.handoff.findings
        : ''
  return handoff ? `${lead} Result:\n${handoff}` : lead
}

export function buildCompletionBatch(children: readonly BatchChildEntry[]): {
  summary: string
  presentation: NonNullable<SystemInput['presentation']>
} {
  const items = children.map((child) => ({
    status: typeof child.status === 'string' && child.status ? child.status : 'completed',
    label:
      typeof child.label === 'string' && child.label
        ? child.label
        : typeof child.childKey === 'string'
          ? child.childKey.slice(-6)
          : '',
  }))
  const status = items.some((item) => item.status === 'failed')
    ? 'failed'
    : items.some((item) => item.status === 'budget_stopped')
      ? 'budget_stopped'
      : items.length > 0 && items.every((item) => item.status === 'cancelled')
        ? 'cancelled'
        : 'completed'
  return {
    summary: clipText(children.map(batchChildSummary).join('\n'), 2048),
    presentation: {
      kind: 'child-completed',
      status,
      label: clipText(
        items
          .map((item) => item.label)
          .filter(Boolean)
          .join(' / '),
        120,
      ),
    },
  }
}

/** A result identity belongs to one resident turn or one terminal child outcome. */
export async function childResultCollected(
  parent: SessionImpl,
  childKey: string,
  commandId: string,
  resultSeq = 0,
): Promise<boolean> {
  for await (const rows of scanPages((query) => parent.scan(query), {
    type: COLLECTED,
    lane: parent.lane,
    toSeq: parent.lastSeq,
    order: 'desc',
  })) {
    for (const row of rows) {
      const value = row.data as { childKey?: string; commandId?: string; resultSeq?: number }
      if (row.origin !== 'system' || row.trust !== 'trusted' || value.childKey !== childKey) continue
      // Recovery can terminate an idle resident without producing another result.
      if (value.commandId === commandId || (resultSeq > 0 && value.resultSeq === resultSeq)) return true
    }
  }
  return false
}

function pruneChildFromInbox(
  inbox: Inbox | undefined,
  matches: (entry: { childKey?: string; commandId?: string }) => boolean,
): Inbox['items'] | undefined {
  if (!inbox?.items.length) return undefined
  let changed = false
  const next: Inbox['items'] = []
  for (const item of inbox.items) {
    if (item.origin !== 'system' || item.system?.source !== 'agnes/child') {
      next.push(item)
      continue
    }
    if (item.system.type === 'child-completed') {
      const data = item.system.data as { childKey?: string } | null
      if (
        matches({
          ...(data?.childKey ? { childKey: data.childKey } : {}),
          ...(item.commandId ? { commandId: item.commandId } : {}),
        })
      ) {
        changed = true
        continue
      }
      next.push(item)
      continue
    }
    if (item.system.type === 'child-batch-completed') {
      const data = item.system.data as { children?: BatchChildEntry[] } | null
      const children = data?.children
      if (Array.isArray(children)) {
        const remaining = children.filter((child) => !matches(child))
        if (remaining.length !== children.length) {
          changed = true
          if (remaining.length > 0) {
            const rebuilt = buildCompletionBatch(remaining)
            next.push({
              ...item,
              content: [{ type: 'text', text: rebuilt.summary }],
              system: {
                ...item.system,
                data: { ...(data as Record<string, JsonValue>), children: remaining },
                summary: rebuilt.summary,
                presentation: rebuilt.presentation,
              },
            })
          }
          continue
        }
      }
    }
    next.push(item)
  }
  return changed ? next : undefined
}

/** Acknowledge the result and withdraw its queued wakeup atomically, before returning it to a tool. */
export async function recordChildResultCollected(
  parent: SessionImpl,
  childKey: string,
  commandId: string,
  resultSeq: number,
): Promise<void> {
  await parent.locked(async () => {
    if (await childResultCollected(parent, childKey, commandId, resultSeq)) return
    const items = pruneChildFromInbox(
      parent.latest('inbox') as Inbox | undefined,
      (entry) => entry.commandId === commandId,
    )
    await parent.d.log.append([
      parent.ev(COLLECTED, { childKey, commandId, resultSeq }, { ignorable: true }),
      ...(items ? [inboxEvent(parent.lane, parent.d.actor, { items })] : []),
    ])
  })
}

/**
 * When a parent explicitly cancels a child, acknowledge its terminal cancellation and withdraw
 * any stale queued notices for that child before and after cancellation settles so old notices
 * never head-of-line block or trigger late ghost turns.
 */
export async function withCancelledChildAck(
  parent: SessionImpl,
  childKey: string,
  run: () => Promise<void>,
): Promise<void> {
  if (parent.closingOrClosed) return run()
  const commandId = childCompletionId(childKey, 'cancelled')
  const withdraw = async (recordAck: boolean) => {
    await parent.locked(async () => {
      const needAck = recordAck && !(await childResultCollected(parent, childKey, commandId, 0))
      const items = pruneChildFromInbox(
        parent.latest('inbox') as Inbox | undefined,
        (entry) => entry.childKey === childKey,
      )
      if (!needAck && !items) return
      await parent.d.log.append([
        ...(needAck
          ? [parent.ev(COLLECTED, { childKey, commandId, resultSeq: 0 }, { ignorable: true })]
          : []),
        ...(items ? [inboxEvent(parent.lane, parent.d.actor, { items })] : []),
      ])
    })
  }
  await withdraw(true)
  try {
    await run()
  } finally {
    await withdraw(false).catch(() => undefined)
  }
}

/** Completed turn boundaries for an idle resident turn, anchored strictly on turn/end. */
export async function childCompletedTurnBounds(
  parent: SessionImpl,
  record: ChildTaskRecord,
  toSeq?: number,
): Promise<{ startSeq: number; endSeq: number } | undefined> {
  const fromSeq = record.boundarySeq + 1
  const [end] = await parent.d.log.storage.scan(record.childKey, {
    type: 'turn/end',
    fromSeq,
    ...(toSeq === undefined ? {} : { toSeq }),
    order: 'desc',
    limit: 1,
  })
  if (!end || end.seq <= 0) return undefined
  const [start] = await parent.d.log.storage.scan(record.childKey, {
    type: 'turn/start',
    fromSeq,
    toSeq: end.seq,
    order: 'desc',
    limit: 1,
  })
  return { startSeq: start?.seq ?? fromSeq, endSeq: end.seq }
}

/** A new turn start distinguishes an early cancellation from the preceding collected turn; idle binds to turn/end. */
export async function childResultSequence(
  parent: SessionImpl,
  record: ChildTaskRecord,
  toSeq?: number,
): Promise<number> {
  const fromSeq = record.boundarySeq + 1
  const [starts, ends] = await Promise.all([
    parent.d.log.storage.scan(record.childKey, {
      type: 'turn/start',
      fromSeq,
      ...(toSeq === undefined ? {} : { toSeq }),
      order: 'desc',
      limit: 1,
    }),
    parent.d.log.storage.scan(record.childKey, {
      type: 'turn/end',
      fromSeq,
      ...(toSeq === undefined ? {} : { toSeq }),
      order: 'desc',
      limit: 1,
    }),
  ])
  if (record.state === 'idle') return ends[0]?.seq ?? 0
  return Math.max(starts[0]?.seq ?? 0, ends[0]?.seq ?? 0)
}
