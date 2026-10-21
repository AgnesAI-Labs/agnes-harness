// Test-only ReclaimStore over two shared-table handles. Production reclaims through the storage
// adapter's `crashReclaim`; this store applies the same check, read and idle delete to the plain
// `writer_claims` / `registers` tables the sqliteTables fixture provides.
import { listExpired } from '../src/lease/lease.js'
import type { ReclaimedClaim, ReclaimStore } from '../src/lease/reclaim.js'
import type { TableHandle } from '../src/storage/table.js'

/**
 * Checks, reads and acts in one transaction: null unless the claim is still exactly the expired row
 * the listing saw. With a turn open on any lane the row is left for the resuming writer to take
 * over; with none it is deleted, and only if it is still that row.
 */
function claimForReclaim(
  claims: TableHandle,
  registers: TableHandle,
  c: { sessionKey: string; runId: string; until: number; now: number },
): ReclaimedClaim | null {
  return claims.transaction(() => {
    const row = claims.get<{ run_id: string; until: number }>(
      'SELECT run_id, until FROM writer_claims WHERE session_key = ?',
      [c.sessionKey],
    )
    if (row?.run_id !== c.runId || row.until !== c.until || row.until >= c.now) return null
    const turns = registers.all<{ seq: number; data: string }>(
      'SELECT seq, data FROM registers WHERE session_key = ? AND register = ? ORDER BY seq DESC',
      [c.sessionKey, 'op.state'],
    )
    const open = turns.find((turn) => turn.data !== 'null')
    // This store has no ledger table to read a head from; the newest op.state row stands in for it.
    const seq = turns[0]?.seq ?? 0
    if (open) return { opState: { seq: open.seq, data: JSON.parse(open.data) }, seq }
    claims.exec(
      'DELETE FROM writer_claims WHERE session_key = ? AND run_id = ? AND until = ? AND until < ?',
      [c.sessionKey, c.runId, c.until, c.now],
    )
    return { opState: undefined, seq }
  })
}

export function tableReclaimStore(claims: TableHandle, registers: TableHandle): ReclaimStore {
  return {
    listExpired: (now) => listExpired(claims, now),
    claimForReclaim: (sessionKey, runId, until, now) =>
      claimForReclaim(claims, registers, { sessionKey, runId, until, now }),
  }
}
