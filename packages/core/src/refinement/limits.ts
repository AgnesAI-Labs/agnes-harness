import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import {
  MAINTENANCE_LANE,
  REFINEMENT_RUN_EVENT,
  type RefinementRunState,
  TERMINAL_RUN_STATES,
} from '@agnes/core-ledger/reduce/state'
import { resolveModel } from '../execution/turn/inference.js'
import { knownPrice } from '../maintenance/budget.js'
import type { SessionImpl } from '../step/session.js'

/**
 * How often automatic refinement may plan: not within the cooldown of the last plan (the model's own
 * reviews apart), and a number of
 * them a session. Manual requests are counted apart and only wait for the
 * plan in flight, and so are the model's own requests (`MODEL_LIMITS`). A review that found nothing to
 * keep does not count toward `perSession`. The token budget is the maintenance root
 * `rsi:<sessionKey>`, held by every call.
 */
export const AUTOMATIC_LIMITS = Object.freeze({
  /** After any plan ends, whether it changed something, found nothing or failed. */
  cooldownMs: 120_000,
  perSession: 40,
})

/**
 * The model asking for a review (`harness_refine`) has no turn spacing, cooldown or hourly limit, as
 * the model chose to call it; only this many reviews a session, one that found nothing not counted.
 */
export const MODEL_LIMITS = Object.freeze({ perSession: 40 })

/** What one edit of a plan, and one plan, may hold, and how many counted entries a kind may keep. */
export const APPLY_LIMITS = Object.freeze({ maxEdits: 5, maxChars: 2000, safetyCap: 200 })

export type LimitRefusal = 'cooldown' | 'session-limit' | 'unpriced'

/** One run as its rows tell it: whether it was automatic, and when it started and ended planning. */
type Planned = {
  automatic: boolean
  model: boolean
  /** The review ended with nothing to keep. */
  empty: boolean
  startedAt: number
  startedSeq: number
  endedAt?: number
}

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
      runs.set(run.runId, {
        automatic: run.trigger.kind !== 'manual',
        model: run.trigger.kind === 'model',
        empty: false,
        startedAt: at,
        startedSeq: row.seq,
      })
    else if (seen && TERMINAL_RUN_STATES.has(d.state as RefinementRunState)) seen.endedAt = at
  }
  for (const [runId, planned] of runs) planned.empty = s.state.refinementRuns.get(runId)?.state === 'no-op'
  return [...runs.values()]
}

/**
 * Whether an automatic plan may start now, and if only time stands in the way, when it may. The model's
 * own request (`kind: 'model'`) is held to the price and to `MODEL_LIMITS` only. The
 * planner model must have a known price; zero is one (a free or local model, bounded by the token
 * budget alone). A model with no known price only runs for the user's own request, once they agree.
 *
 * `run` is the run about to start: its own earlier attempts (a plan a restart or a close cut short)
 * do not count against it, so it continues rather than being refused by itself. `cooldown: false`
 * asks whether anything but the cooldown stands in the way, for a trigger that would wait for the
 * plan in flight anyway.
 */
export async function automaticRefusal(
  s: SessionImpl,
  target: { route: string; model: string } | undefined,
  o: { run?: string; cooldown?: false; kind?: 'model' } = {},
): Promise<{ refused: LimitRefusal; retryAt?: number } | undefined> {
  if (!priced(s, target ?? resolveModel(s, 'primary'))) return { refused: 'unpriced' }
  const now = s.d.clock()
  const planned = await plannedRuns(s, o.run)
  if (o.kind === 'model')
    return planned.filter((run) => run.model && !run.empty).length >= MODEL_LIMITS.perSession
      ? { refused: 'session-limit' }
      : undefined
  // The machine's triggers (a compaction, a repeated failure) are counted apart from the model's.
  const automatic = planned.filter((run) => run.automatic && !run.model)
  if (automatic.filter((run) => !run.empty).length >= AUTOMATIC_LIMITS.perSession)
    return { refused: 'session-limit' }
  // The cooldown follows the last plan that was not the model's own: its frequent reviews must not keep
  // the machine's triggers (a compaction, a repeated failure) from ever starting.
  const ended = Math.max(
    -Infinity,
    ...planned.filter((run) => !run.model).map((run) => run.endedAt ?? run.startedAt),
  )
  if (o.cooldown !== false && now < ended + AUTOMATIC_LIMITS.cooldownMs)
    return { refused: 'cooldown', retryAt: ended + AUTOMATIC_LIMITS.cooldownMs }
  return undefined
}

/** Whether the planner model, the target or else the session's primary, has a known price. */
export function plannerPriced(s: SessionImpl, target: { route: string; model: string } | undefined): boolean {
  return priced(s, target ?? resolveModel(s, 'primary'))
}

function priced(s: SessionImpl, target: { route: string; model: string }): boolean {
  try {
    return knownPrice(s.d.provider.models().find((m) => m.route === target.route && m.id === target.model))
  } catch {
    return false
  }
}
