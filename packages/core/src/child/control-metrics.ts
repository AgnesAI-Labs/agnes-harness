import type { ChildTaskRecord } from '@agnes/core-child-control/child/types'
import { isTerminalChildState } from '@agnes/core-child-control/child/types'
import { scanPages } from '@agnes/core-ledger/log/scan-pages'
import type { SessionImpl } from '../step/session.js'
import { readRoleDelegation } from './role-snapshot.js'

/** Child-local usage only: inherited parent costs are not child work. */
export async function childControlMetrics(parent: SessionImpl, record: ChildTaskRecord, running: boolean) {
  const storage = parent.d.log.storage
  // Role sessions start fresh rather than inheriting the parent's immutable ledger prefix.
  const fromSeq = (await readRoleDelegation(storage, record.childKey)) ? 1 : record.boundarySeq + 1
  const [first, last, tail] = await Promise.all([
    storage.scan(record.childKey, { fromSeq, type: 'turn/start', limit: 1 }),
    storage.scan(record.childKey, { fromSeq, type: 'turn/end', order: 'desc', limit: 1 }),
    storage.scan(record.childKey, { fromSeq, order: 'desc', limit: 1 }),
  ])
  const neverRan = !first.length && isTerminalChildState(record.state)
  let totalTokens: number | null = neverRan ? 0 : null
  let sum = 0
  let known = true
  const seen = new Set<string>()
  for await (const rows of scanPages((q) => storage.scan(record.childKey, q), {
    fromSeq,
    toSeq: tail[0]?.seq ?? fromSeq,
    type: 'cost/ledger',
  })) {
    for (const row of rows) {
      const cost = row.data as {
        effectId: string
        adjustment?: unknown
        tokens?: { input?: number; output?: number }
      }
      if (seen.has(cost.effectId) || cost.adjustment) continue
      seen.add(cost.effectId)
      if (typeof cost.tokens?.input !== 'number' || typeof cost.tokens.output !== 'number') known = false
      else sum += cost.tokens.input + cost.tokens.output
    }
  }
  if (seen.size && known) totalTokens = sum
  const start = first[0] ? Date.parse(first[0].ts) : null
  const end = running ? parent.d.clock() : last[0] ? Date.parse(last[0].ts) : null
  const durationMs = neverRan
    ? 0
    : start !== null && end !== null && Number.isFinite(start) && Number.isFinite(end)
      ? Math.max(0, end - start)
      : null
  return { totalTokens, durationMs }
}
