import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import {
  MAINTENANCE_LANE,
  REFINEMENT_RUN_EVENT,
  type RefinementRunState,
  TERMINAL_RUN_STATES,
} from '@agnes/core-ledger/reduce/state'
import { resolveModel } from '../execution/turn/inference.js'
import { maintenanceCapCredits } from '../maintenance/budget.js'
import type { SessionImpl } from '../step/session.js'

/**
 * How often automatic refinement may plan. Manual requests are counted apart and only wait for the
 * plan in flight. The token budget is the maintenance root `rsi:<sessionKey>`, held by every call.
 */
export const AUTOMATIC_LIMITS = Object.freeze({
  /** Completed turns between the starts of two automatic plans. */
  turnsBetween: 5,
  perHour: 4,
  hourMs: 3_600_000,
  /** After any plan ends, whether it changed something, found nothing or failed. */
  cooldownMs: 120_000,
  perSession: 10,
})

/** What one edit of a plan, and one plan, may hold, and how many counted entries a kind may keep. */
export const APPLY_LIMITS = Object.freeze({ maxEdits: 5, maxChars: 2000, safetyCap: 200 })

export type LimitRefusal = 'cooldown' | 'turns' | 'hourly' | 'session-limit' | 'unpriced'

/** One run as its rows tell it: whether it was automatic, and when it started and ended planning. */
type Planned = { automatic: boolean; startedAt: number; startedSeq: number; endedAt?: number }

/**
 * Every run that reached planning, read back from the run rows themselves, so the counts and the
 * cooldown are the same after a restart as before it.
 */
async function plannedRuns(s: SessionImpl, except?: string): Promise<Planned[]> {
  const rows = await scanAll((q) => s.scan(q), {
    type: REFINEMENT_RUN_EVENT,
    lane: MAINTENANCE_LANE,
    toSeq: s.lastSeq,
  })
  const runs = new Map<string, Planned>()
  for (const row of rows) {
    const d = row.data as { version?: unknown; runId?: unknown; state?: unknown } | null
    if (row.origin !== 'system' || row.trust !== 'trusted' || d?.version !== 1) continue
    const run = typeof d.runId === 'string' ? s.state.refinementRuns.get(d.runId) : undefined
    if (!run || run.runId === except) continue
    const at = Date.parse(row.ts)
    const seen = runs.get(run.runId)
    if (!seen && d.state === 'planning')
      runs.set(run.runId, { automatic: run.trigger.kind !== 'manual', startedAt: at, startedSeq: row.seq })
    else if (seen && TERMINAL_RUN_STATES.has(d.state as RefinementRunState)) seen.endedAt = at
  }
  return [...runs.values()]
}

async function completedTurnsAfter(s: SessionImpl, seq: number): Promise<number> {
  const ends = await scanAll((q) => s.scan(q), {
    type: 'turn/end',
    lane: s.lane,
    fromSeq: seq + 1,
    toSeq: s.lastSeq,
  })
  return ends.filter((row) => (row.data as { reason?: unknown } | null)?.reason === 'completed').length
}

/**
 * Whether an automatic plan may start now, and if only time stands in the way, when it may. The
 * planner model must have a price: a free or unpriced model has nothing to bound its spend.
 *
 * `run` is the run about to start: its own earlier attempts (a plan a restart or a close cut short)
 * do not count against it, so it continues rather than being refused by itself. `cooldown: false`
 * asks whether anything but the cooldown stands in the way, for a trigger that would wait for the
 * plan in flight anyway.
 */
export async function automaticRefusal(
  s: SessionImpl,
  target: { route: string; model: string } | undefined,
  o: { run?: string; cooldown?: false } = {},
): Promise<{ refused: LimitRefusal; retryAt?: number } | undefined> {
  if (!priced(s, target ?? resolveModel(s, 'primary'))) return { refused: 'unpriced' }
  const now = s.d.clock()
  const planned = await plannedRuns(s, o.run)
  const automatic = planned.filter((run) => run.automatic)
  if (automatic.length >= AUTOMATIC_LIMITS.perSession) return { refused: 'session-limit' }
  const inHour = automatic.filter((run) => run.startedAt > now - AUTOMATIC_LIMITS.hourMs)
  if (inHour.length >= AUTOMATIC_LIMITS.perHour)
    return {
      refused: 'hourly',
      retryAt: Math.min(...inHour.map((run) => run.startedAt)) + AUTOMATIC_LIMITS.hourMs,
    }
  const ended = Math.max(-Infinity, ...planned.map((run) => run.endedAt ?? run.startedAt))
  if (o.cooldown !== false && now < ended + AUTOMATIC_LIMITS.cooldownMs)
    return { refused: 'cooldown', retryAt: ended + AUTOMATIC_LIMITS.cooldownMs }
  const last = automatic.reduce<Planned | undefined>(
    (a, b) => (a && a.startedSeq > b.startedSeq ? a : b),
    undefined,
  )
  if (last && (await completedTurnsAfter(s, last.startedSeq)) < AUTOMATIC_LIMITS.turnsBetween)
    return { refused: 'turns' }
  return undefined
}

function priced(s: SessionImpl, target: { route: string; model: string }): boolean {
  try {
    const record = s.d.provider.models().find((m) => m.route === target.route && m.id === target.model)
    return record !== undefined && maintenanceCapCredits(record) !== undefined
  } catch {
    return false
  }
}
