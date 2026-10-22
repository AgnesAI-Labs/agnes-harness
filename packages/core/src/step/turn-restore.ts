import type { OpStateObj } from '@agnes/core-common/step/op-state'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { RequestHeaderData } from '../request/derive.js'
import type { SessionImpl } from './session.js'

/** Restore request identity and tool ordinals from the persisted turn rather than a fresh counter. */
export async function rehydratedCallState(s: SessionImpl, op: OpStateObj) {
  const range = { fromSeq: op.meta.triggerSeq, toSeq: s.lastSeq, lane: s.lane }
  const [lastRow] = await s.d.log.scan({ ...range, type: 'request/header', order: 'desc', limit: 1 })
  const last = lastRow?.data as RequestHeaderData | undefined
  let calls = 0
  for await (const page of scanPages((q) => s.d.log.scan(q), { ...range, type: 'tool/call' }))
    calls += page.length
  const ordinal =
    op.phase.kind === 'tools' ? Math.max(calls, ...op.phase.batch.calls.map((c) => c.ordinal + 1)) : calls
  return { lastRow, last, ordinal }
}
