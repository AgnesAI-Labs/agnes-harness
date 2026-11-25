import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'
import { childCompletionId } from './completion-notice.js'

const COLLECTED = 'x/core/child-result-collected'

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
      const data = item.system.data as { children?: Array<{ childKey?: string; commandId?: string }> } | null
      const children = data?.children
      if (Array.isArray(children)) {
        const remaining = children.filter((child) => !matches(child))
        if (remaining.length !== children.length) {
          changed = true
          if (remaining.length > 0) {
            next.push({
              ...item,
              system: {
                ...item.system,
                data: { ...(data as Record<string, never>), children: remaining },
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

/** A new turn start distinguishes an early cancellation from the preceding collected turn. */
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
  return Math.max(starts[0]?.seq ?? 0, ends[0]?.seq ?? 0)
}
