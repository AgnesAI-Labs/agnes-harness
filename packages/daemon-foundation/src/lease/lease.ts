// Read side of the writer-claim table. The daemon never grants, renews or releases a claim: core
// owns `writer_claims` and is the only writer to it. This module only SELECTs; it agrees with core
// on the schema by convention (session_key/run_id/until/generation, snake_case columns), not by
// importing core's types.
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

/** Lapsed claims whose session has a turn open on some lane: the ones a dead writer left. */
export function countExpiredWithTurn(claims: TableHandle, now: number): number {
  return (
    claims.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM writer_claims w WHERE w.until < ? AND EXISTS (SELECT 1 FROM registers r WHERE r.session_key = w.session_key AND r.register = 'op.state' AND r.data <> 'null')",
      [now],
    )?.n ?? 0
  )
}
