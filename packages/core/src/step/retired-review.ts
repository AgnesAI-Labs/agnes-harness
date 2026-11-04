import { CoreError } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { SessionImpl } from './session.js'

/** Old experimental lineages must not resume with their former limits silently removed. */
export async function assertRetiredReviewSettled(s: SessionImpl): Promise<void> {
  const [owner] = await s.d.log.scan({ type: 'session/start', order: 'desc', limit: 1 })
  const rows = await scanAll((query) => s.d.log.scan(query), {
    type: ['turn/start', 'x/core/completion-gate', 'turn/end'],
    lane: s.lane,
    fromSeq: owner?.seq ?? 1,
    toSeq: s.lastSeq,
  })
  const roots = new Map<number, number>()
  const groups = new Map<number, { review: boolean; reason?: string | undefined }>()
  let current: number | undefined
  for (const row of rows) {
    if (row.origin !== 'system' || row.trust !== 'trusted') continue
    if (!row.data || typeof row.data !== 'object') continue
    const data = row.data as {
      turn?: number
      trigger?: string
      continues?: { turn?: number }
      diagnostic?: string
      status?: string
      reason?: string
    }
    if (row.type === 'turn/start' && typeof data.turn === 'number') {
      const previous = data.trigger === 'approval-resume' ? data.continues?.turn : undefined
      current = (previous === undefined ? undefined : roots.get(previous)) ?? data.turn
      roots.set(data.turn, current)
      const group = groups.get(current) ?? { review: false }
      delete group.reason
      groups.set(current, group)
    }
    const root = row.type === 'turn/end' && data.turn !== undefined ? roots.get(data.turn) : current
    const group = root === undefined ? undefined : groups.get(root)
    if (!group) continue
    if (row.type === 'turn/end') group.reason = data.reason
    if (
      row.type === 'x/core/completion-gate' &&
      data.diagnostic === 'completion_gate_contract_review' &&
      data.status === 'ran'
    )
      group.review = true
  }
  // A different completed turn cannot settle a parked call. Even a completed sibling continuation
  // cannot retire another live unconsumed decision in the same lineage. Expired or invalidated
  // decisions are terminal without consumption and must not undo a completed continuation.
  for (const { value } of s.state.registers.decisionStates.values()) {
    if (
      value.consumption ||
      value.invalidation ||
      (value.result && value.result.reason !== 'answered') ||
      value.request.sourcePackage !== '@agnes/core' ||
      value.request.lane !== s.lane
    )
      continue
    const call = s.state.toolCalls.get(value.request.operationId)
    if (!call || call.lane !== s.lane || call.seq < (owner?.seq ?? 1)) continue
    const root = roots.get(call.turn)
    const group = root === undefined ? undefined : groups.get(root)
    if (group?.review) delete group.reason
  }
  if ([...groups.values()].some((group) => group.review && (!group.reason || group.reason === 'parked'))) {
    throw new CoreError(
      'E_UNSUPPORTED',
      'An unfinished session contains a retired completion review. Finish or reconcile it with its original runtime, or start a new session; existing records are unchanged.',
    )
  }
}
