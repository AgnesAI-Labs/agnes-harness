import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { Inbox } from '@agnes/core-ledger/reduce/shapes'
import { inboxEvent } from '../step/inbox.js'
import type { SessionImpl } from '../step/session.js'

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

/** Acknowledge the result and withdraw its queued wakeup atomically, before returning it to a tool. */
export async function recordChildResultCollected(
  parent: SessionImpl,
  childKey: string,
  commandId: string,
  resultSeq: number,
): Promise<void> {
  await parent.locked(async () => {
    if (await childResultCollected(parent, childKey, commandId, resultSeq)) return
    const inbox = parent.latest('inbox') as Inbox | undefined
    const items = inbox?.items.filter(
      (item) =>
        !(
          item.origin === 'system' &&
          item.commandId === commandId &&
          item.system?.source === 'agnes/child' &&
          item.system.type === 'child-completed'
        ),
    )
    await parent.d.log.append([
      parent.ev(COLLECTED, { childKey, commandId, resultSeq }, { ignorable: true }),
      ...(inbox && items && items.length !== inbox.items.length
        ? [inboxEvent(parent.lane, parent.d.actor, { items })]
        : []),
    ])
  })
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
