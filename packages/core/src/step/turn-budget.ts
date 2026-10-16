import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { CoreError, type Seq } from '@agnes/core-common/types'
import { SCAN_PAGE_MAX } from '@agnes/core-ledger/log/storage'
import {
  INBOX_BUDGET_EVENT,
  type InboxBudgetOverride,
  TURN_BUDGET_EVENT,
  type TurnBudgetOverride,
} from './inbox.js'
import type { SessionImpl } from './session.js'

export async function inboxBudget(s: SessionImpl, itemId: string): Promise<InboxBudgetOverride | undefined> {
  let found: InboxBudgetOverride | undefined
  let toSeq: Seq | undefined
  for (;;) {
    const rows = await s.d.log.scan({
      type: INBOX_BUDGET_EVENT,
      order: 'desc',
      limit: SCAN_PAGE_MAX,
      ...(toSeq === undefined ? {} : { toSeq }),
    })
    for (const event of rows) {
      const data = event.data as Partial<InboxBudgetOverride> | null
      if (data?.itemId !== itemId) continue
      if (typeof data.creditsCap !== 'number' || !Number.isFinite(data.creditsCap) || data.creditsCap < 0)
        throw new CoreError('E_ENVELOPE', 'stored per-turn budget override is invalid')
      if (found !== undefined)
        throw new CoreError('E_RELATION', `duplicate budget override for inbox item ${itemId}`)
      if (data.hard !== undefined && data.hard !== true)
        throw new CoreError('E_ENVELOPE', 'stored hard budget marker is invalid')
      found = { itemId: data.itemId, creditsCap: data.creditsCap, ...(data.hard ? { hard: true } : {}) }
    }
    if (rows.length < SCAN_PAGE_MAX) return found
    const oldest = rows.at(-1)
    if (!oldest || oldest.seq <= 1) return found
    toSeq = (oldest.seq - 1) as Seq
  }
}

export async function rehydratedBudget(
  s: SessionImpl,
  op: OpStateObj,
): Promise<InboxBudgetOverride | undefined> {
  let found: InboxBudgetOverride | undefined
  let fromSeq = op.meta.triggerSeq
  for (;;) {
    const rows = await s.d.log.scan({
      fromSeq,
      toSeq: s.lastSeq,
      type: TURN_BUDGET_EVENT,
      order: 'asc',
      limit: SCAN_PAGE_MAX,
    })
    for (const event of rows) {
      const data = event.data as Partial<TurnBudgetOverride> | null
      if (data?.turn !== op.meta.turn) continue
      if (
        typeof data.itemId !== 'string' ||
        typeof data.creditsCap !== 'number' ||
        !Number.isFinite(data.creditsCap) ||
        data.creditsCap < 0
      )
        throw new CoreError('E_ENVELOPE', 'stored turn budget override is invalid')
      if (found !== undefined)
        throw new CoreError('E_RELATION', `duplicate budget override for turn ${op.meta.turn}`)
      if (data.hard !== undefined && data.hard !== true)
        throw new CoreError('E_ENVELOPE', 'stored hard budget marker is invalid')
      found = { itemId: data.itemId, creditsCap: data.creditsCap, ...(data.hard ? { hard: true } : {}) }
    }
    if (rows.length < SCAN_PAGE_MAX) return found
    const newest = rows.at(-1)
    if (!newest || newest.seq >= s.lastSeq) return found
    fromSeq = (newest.seq + 1) as Seq
  }
}
