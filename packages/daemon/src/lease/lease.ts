// Read side of the writer-claim table. The daemon never grants or renews a claim — core owns
// `writer_claims` and is the only writer to it (INSERT/UPDATE on open, renew, and generation bumps
// all happen inside core's own transaction). This module only SELECTs and, for `releaseClaim`,
// DELETEs a row it does not own the shape of; it agrees with core on the schema by convention
// (session_key/run_id/until/generation, snake_case columns), not by importing core's types.
import type { TableHandle } from '../storage/table.js'

type Row = { session_key: string; run_id: string; until: number; generation: number }

export type Claim = { sessionKey: string; runId: string; until: number; generation: number }

/** The current claim on a session, or undefined if nothing has ever claimed it. */
export function readClaim(t: TableHandle, sessionKey: string): Omit<Claim, 'sessionKey'> | undefined {
  const r = t.get<Row>('SELECT run_id, until, generation FROM writer_claims WHERE session_key = ?', [
    sessionKey,
  ])
  return r ? { runId: r.run_id, until: r.until, generation: r.generation } : undefined
}

/** The claim's generation, or 0 when the session has never been claimed (core writes 1 on first open). */
export function generationOf(t: TableHandle, sessionKey: string): number {
  return readClaim(t, sessionKey)?.generation ?? 0
}

/** Every claim whose deadline has passed `now`, oldest deadline first. */
export function listExpired(t: TableHandle, now: number): Claim[] {
  return t
    .all<Row>(
      'SELECT session_key, run_id, until, generation FROM writer_claims WHERE until < ? ORDER BY until',
      [now],
    )
    .map((r) => ({ sessionKey: r.session_key, runId: r.run_id, until: r.until, generation: r.generation }))
}

/** What a reclaim found once it held the claim: the open turn, if any lane has one. */
export type ReclaimedClaim = { opState: { seq: number; data: unknown } | undefined; seq: number }

/**
 * Checks, reads and acts in one transaction: null unless the claim is still exactly the expired row
 * the listing saw. With a turn open on any lane the row is left for the resuming writer to take
 * over; with none it is deleted, and only if it is still that row.
 */
export function claimForReclaim(
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

/** Lapsed claims whose session has a turn open on some lane: the ones a dead writer left. */
export function countExpiredWithTurn(claims: TableHandle, now: number): number {
  return (
    claims.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM writer_claims w WHERE w.until < ? AND EXISTS (SELECT 1 FROM registers r WHERE r.session_key = w.session_key AND r.register = 'op.state' AND r.data <> 'null')",
      [now],
    )?.n ?? 0
  )
}

/**
 * Deletes the claim on `sessionKey`, but only the row this `runId` still holds. If a newer writer has
 * since taken the session (a different run_id, possibly a higher generation), the row belongs to that
 * newer writer and is left untouched; the call reports false rather than deleting someone else's claim.
 * The membership check and the delete run inside one transaction so a claim change landing between the
 * two (a concurrent writer taking over the session) cannot make this report a release that did not
 * actually happen.
 */
export function releaseClaim(t: TableHandle, sessionKey: string, runId: string): boolean {
  return t.transaction(() => {
    const before =
      t.get<{ n: number }>('SELECT COUNT(*) AS n FROM writer_claims WHERE session_key = ? AND run_id = ?', [
        sessionKey,
        runId,
      ])?.n ?? 0
    if (!before) return false
    t.exec('DELETE FROM writer_claims WHERE session_key = ? AND run_id = ?', [sessionKey, runId])
    return true
  })
}
