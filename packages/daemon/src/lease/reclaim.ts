// Crash-continuation orchestration over the two Task 19 primitives: scan `writer_claims` for
// deadlines that have already passed, and for each one decide from the `registers` table's
// `op.state` cell whether there was an open turn when the writer died. This module owns no SQL
// beyond the one `registers` read below - `listExpired`/`releaseClaim` (lease.ts) already own the
// `writer_claims` half.
import type { TableHandle } from '../storage/table.js'
import { claimForReclaim, listExpired, type ReclaimedClaim } from './lease.js'

export type ReclaimStore = {
  listExpired(now: number): Array<{
    sessionKey: string
    runId: string
    until: number
    generation: number
  }>
  /** See lease.ts claimForReclaim: the re-check, the op.state read and an idle delete, atomically. */
  claimForReclaim(sessionKey: string, runId: string, until: number, now: number): ReclaimedClaim | null
}

/** Adapts the shared-table fixture/legacy injection point onto the production narrow port. */
export function tableReclaimStore(claims: TableHandle, registers: TableHandle): ReclaimStore {
  return {
    listExpired: (now) => listExpired(claims, now),
    claimForReclaim: (sessionKey, runId, until, now) =>
      claimForReclaim(claims, registers, { sessionKey, runId, until, now }),
  }
}

/**
 * The narrow shape this module needs from daemon's notice sink. The real `NoticeSink` is
 * `local/notice.ts` (daemon Task 12, [I6]) - not built at the time this file was written. Once it
 * lands it satisfies this structurally (at minimum an `emit(kind, info)` method), so nothing here
 * needs to change. Kept as its own local type rather than imported from worker-pool.ts's
 * `NoticeEmitter` (same shape, same reasoning) so lease/ does not pick up a dependency on
 * supervisor/ just to name a notice sink.
 */
export type ReclaimNotices = { emit(kind: string, info?: { sessionId?: string; detail?: unknown }): void }

/**
 * What `session.resume()` reports. This is core's real `step/resume.ts` shape as of the commit this
 * package's Task 19 landed against (`{state, phase?, actions}` - no `turn`/`step`/`pending` fields),
 * rather than the retired `{turn, step, phase, pending}` shape. `packages/daemon` does not depend on `@agnes/core` (see package.json), so this is a
 * structural copy by convention, the same way lease.ts copies `writer_claims`'s row shape instead of
 * importing it.
 */
export type ResumeReport = {
  state: 'idle' | 'resumed'
  phase?: string
  actions: Array<{ effectId: string; action: string }>
}

export type ReclaimRecord = { sessionKey: string; lastSeq: number; resumed: boolean; lastStep?: number }

type OpStateShape = { step?: number } | null

/**
 * One crash-continuation pass. For every claim whose deadline has already passed `now`:
 *  - no open turn (`op.state`'s row is missing, or its `data` decodes to the JSON tombstone `null`)
 *    -> the session was idle when its writer died, so the claim is just released.
 *  - an open turn -> the claim is deliberately left in place (not released first): the new worker
 *    `openForResume` starts opens the session inside core, which bumps `generation` and overwrites
 *    this very row in its own transaction. Releasing here first would leave a window between this
 *    delete and that open where a third writer could claim the session from under the resume.
 *    `openForResume(...).session.resume()` is then called and a `'resumed'` notice emitted.
 *  - `resume()` throwing is recorded (`resumed:false`, no notice, no claim touched) and left for the
 *    next pass rather than thrown onward, so one bad session in a batch does not stop the rest.
 */
export async function reclaimExpired(o: {
  store: ReclaimStore
  now: number
  /** Null when the session is already open, or opening, in this daemon: its writer is alive. */
  openForResume: (
    sessionKey: string,
    runId: string,
  ) => Promise<{ session: { resume(): Promise<ResumeReport> } } | null>
  notices: ReclaimNotices
  log?: (m: string) => void
  signal?: AbortSignal
}): Promise<ReclaimRecord[]> {
  const out: ReclaimRecord[] = []
  for (const c of o.store.listExpired(o.now)) {
    if (o.signal?.aborted) break
    // A writer that is alive takes its lease back on its next write; if it did so after the listing,
    // the claim is no longer the one listed and is left alone.
    const claimed = o.store.claimForReclaim(c.sessionKey, c.runId, c.until, o.now)
    if (!claimed) continue
    const op = claimed.opState ? (claimed.opState.data as OpStateShape) : null
    if (!op) {
      out.push({ sessionKey: c.sessionKey, lastSeq: claimed.seq, resumed: false })
      continue
    }
    const lastSeq = (claimed.opState as { seq: number }).seq
    try {
      const opened = await o.openForResume(c.sessionKey, c.runId)
      if (o.signal?.aborted) break
      if (!opened) continue
      const { session } = opened
      const report = await session.resume()
      if (o.signal?.aborted) break
      o.notices.emit('resumed', {
        sessionId: c.sessionKey,
        detail: {
          lastStep: op.step,
          pending: report.actions.length,
          ...(report.phase !== undefined ? { phase: report.phase } : {}),
        },
      })
      out.push({
        sessionKey: c.sessionKey,
        lastSeq,
        resumed: true,
        ...(op.step !== undefined ? { lastStep: op.step } : {}),
      })
    } catch (e) {
      if (o.signal?.aborted) break
      o.log?.(`reclaim ${c.sessionKey} failed: ${String(e)}`)
      out.push({ sessionKey: c.sessionKey, lastSeq, resumed: false })
    }
  }
  return out
}
