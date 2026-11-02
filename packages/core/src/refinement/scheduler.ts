import { CoreError, type Seq } from '@agnes/core-common/types'
import type { HarnessEdit, Inbox } from '@agnes/core-ledger/reduce/shapes'
import type { RefinementRunRecord } from '@agnes/core-ledger/reduce/state'
import { createMaintenancePort } from '../maintenance/port.js'
import { type ApplyProposal, applyRefine, entryKey } from '../refine/apply.js'
import type { SessionImpl } from '../step/session.js'
import { readSetCurrent } from './evidence.js'
import { APPLY_LIMITS, automaticRefusal } from './limits.js'
import {
  isExpired,
  planRefinementRun,
  type RefinementRunDeps,
  type RunFacts,
  refinementRunRow,
} from './run.js'
import type { RefinementPlanner } from './types.js'

/** The refinement switch as Core reads it: on or off, how automatic triggers are treated, and its revision. */
export type RefinementSettingsView = { enabled: boolean; mode: 'manual' | 'auto'; revision: string }

/**
 * What the host gives Core to run refinement for a session. Both reads happen often (before a plan,
 * before an apply) and must be cheap; a read that throws counts as off.
 */
export type RefinementDeps = {
  settings(): RefinementSettingsView
  /** The plugin's planner, once it has been handed over; absent means no plan can be made yet. */
  planner(): RefinementPlanner | undefined
  /** The planner model; absent means the session's current primary model, frozen for each run. */
  target?: { route: string; model: string }
}

/** Why an apply attempt left the run as it was, or what it did. */
export type ApplyAttempt =
  | 'applied'
  | 'rejected'
  | 'not-proposed'
  | 'off'
  | 'closing'
  | 'turn-open'
  | 'inbox'
  | 'paused'

/** The switch as it is now; undefined (off) when the session has no refinement or the read fails. */
export function settingsOf(s: SessionImpl): RefinementSettingsView | undefined {
  try {
    const view = s.d.refinement?.settings()
    return view?.enabled === true ? view : undefined
  } catch {
    return undefined
  }
}

export function plannerOf(s: SessionImpl): RefinementPlanner | undefined {
  try {
    return s.d.refinement?.planner()
  } catch {
    return undefined
  }
}

/** Per session, in this process: the one run being planned, and a timer waiting out a cooldown. */
type Slot = { planning?: string; timer?: unknown }
const slots = new WeakMap<SessionImpl, Slot>()
export function slotOf(s: SessionImpl): Slot {
  const slot = slots.get(s) ?? {}
  slots.set(s, slot)
  return slot
}

const queuedRuns = (s: SessionImpl): RefinementRunRecord[] =>
  [...s.state.refinementRuns.values()]
    .filter((run) => run.state === 'queued')
    .sort((a, b) => a.queuedSeq - b.queuedSeq)

/**
 * Marks every queued run but `keep` superseded: only one trigger waits for the next plan. With
 * `automaticOnly`, a queued manual request is left alone: an automatic trigger never displaces it.
 */
export function supersedeQueued(s: SessionImpl, keep: string, automaticOnly = false): Promise<void> {
  return s.locked(async () => {
    const older = queuedRuns(s).filter(
      (run) => run.runId !== keep && !(automaticOnly && run.trigger.kind === 'manual'),
    )
    if (older.length > 0)
      await s.append(
        older.map((run) => refinementRunRow(s, run.runId, 'superseded', { reason: 'newer-trigger' })),
      )
  })
}

const warn = (s: SessionImpl, what: string, error: unknown) =>
  s.d.logger.warn(`refinement ${what} failed`, { message: String(error) })

/**
 * Starts planning the newest queued manual request, else the newest queued run, unless a plan is
 * already running here, refinement is off or the session is closing. Never waits for the plan: it
 * runs in the background, and an answer that proposes something is applied as soon as the session
 * is between turns.
 */
export function pump(s: SessionImpl): void {
  const slot = slotOf(s)
  if (slot.planning !== undefined || s.closingOrClosed || !settingsOf(s)) return
  const queued = queuedRuns(s)
  const run = queued.filter((r) => r.trigger.kind === 'manual').at(-1) ?? queued.at(-1)
  if (!run) return
  slot.planning = run.runId
  void start(s, run)
    .catch((error) => {
      warn(s, 'planning', error)
      return false
    })
    .then((moved) => {
      if (slot.planning === run.runId) delete slot.planning
      if (moved) pump(s)
    })
}

/** Ends a queued run without planning it, if it is still queued. */
function endQueued(s: SessionImpl, runId: string, state: 'cancelled' | 'rejected', facts: RunFacts) {
  return s.locked(async () => {
    if (s.state.refinementRuns.get(runId)?.state === 'queued')
      await s.append([refinementRunRow(s, runId, state, facts)])
  })
}

/** Plans one run; true when it moved on, so the next queued one may be looked at. */
async function start(s: SessionImpl, run: RefinementRunRecord): Promise<boolean> {
  const deps = s.d.refinement
  const settings = settingsOf(s)
  const planner = plannerOf(s)
  if (!deps || !settings || !planner) return false
  // Accepted under another revision: the switch has been saved since (off and on again, or the mode).
  if (run.settingsRevision !== settings.revision) {
    await endQueued(s, run.runId, 'cancelled', { reason: 'settings-changed' })
    return true
  }
  const automatic = run.trigger.kind !== 'manual'
  if (automatic && settings.mode !== 'auto') {
    await endQueued(s, run.runId, 'rejected', { reason: 'manual-mode' })
    return true
  }
  // A manual request queued after the queue was read is left for the next start, as everywhere else.
  await supersedeQueued(s, run.runId, automatic)
  if (automatic) {
    const why = await automaticRefusal(s, deps.target, { run: run.runId })
    if (why?.refused === 'cooldown') {
      wake(s, why.retryAt ?? s.d.clock())
      return false
    }
    // Accepted while another plan ran, but no longer within the limits it has to wait for.
    if (why) {
      await endQueued(s, run.runId, 'rejected', { reason: 'limit', detail: why.refused })
      return true
    }
  }
  const runDeps: RefinementRunDeps = {
    maintenance: createMaintenancePort(s),
    planner,
    settings: () => {
      const view = settingsOf(s)
      return { enabled: view !== undefined, revision: view?.revision ?? '' }
    },
    ...(deps.target ? { target: deps.target } : {}),
  }
  const done = await planRefinementRun(s, run.runId, runDeps, new AbortController().signal)
  if (done?.state === 'proposed') await tryApply(s, done.runId)
  return done?.state !== 'queued'
}

/** Looks at the queue again once a cooldown is over; the timer never keeps the process alive. */
function wake(s: SessionImpl, at: number): void {
  const slot = slotOf(s)
  if (slot.timer !== undefined) return
  const timers = s.d.timers ?? { setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) }
  const handle = timers.setTimeout(
    () => {
      delete slot.timer
      pump(s)
    },
    Math.max(0, at - s.d.clock()),
  )
  ;(handle as { unref?: () => void } | null)?.unref?.()
  slot.timer = handle
}

const TRIGGER = {
  manual: 'manual',
  compaction: 'compact',
  model: 'auto',
  'repeated-failure': 'auto',
} as const

/** The proposed plan as the apply step takes it, keyed by the run so a second apply is a replay. */
function proposalOf(
  run: RefinementRunRecord & { plan: NonNullable<RefinementRunRecord['plan']> },
): ApplyProposal {
  const { plan } = run
  const baseline = new Map(plan.baseline.map((b) => [entryKey(b), b.version]))
  // An expired edit is on the plan only as a record; it is never applied.
  const applied = plan.edits.filter((edit) => !isExpired(edit))
  const edits = applied.map((edit): HarnessEdit => {
    if (edit.op === 'delete') return { op: 'delete', kind: edit.kind, id: edit.id }
    const { kind, id, title, content } = edit
    const version = (baseline.get(entryKey(edit)) ?? 0) + 1
    return {
      op: 'upsert',
      entry: { kind, id, title, content, scope: 'local', version, source: `refinement:${run.runId}` },
    }
  })
  const cited = new Set<Seq>([...plan.evidenceSeqs, ...applied.flatMap((edit) => edit.evidenceSeqs)])
  return {
    proposalId: run.runId,
    runId: run.runId,
    trigger: TRIGGER[run.trigger.kind],
    rationale: plan.rationale || plan.summary,
    evidenceSeqs: [...cited].sort((a, b) => a - b),
    baseline: plan.baseline.map((b) => ({ key: entryKey(b), version: b.version })),
    edits,
  }
}

/**
 * Applies one proposed run if the session is between turns, in one short transaction under the
 * session lock (the lock `enqueue` and `acceptInput` share, so whichever commits first wins). The run
 * stays proposed while a turn is open (checked, and the commit guarded by a compare-and-set on the
 * lane's `op.state` cell), while input waits in the inbox, while the session is paused, or while
 * refinement is off. A plan made under another settings revision is cancelled and one made against
 * entries that have moved since is rejected: neither can hold again.
 */
export function tryApply(s: SessionImpl, runId: string): Promise<ApplyAttempt> {
  return s.locked(async (): Promise<ApplyAttempt> => {
    const run = s.state.refinementRuns.get(runId)
    if (run?.state !== 'proposed' || !run.plan) return 'not-proposed'
    const settings = settingsOf(s)
    if (!settings) return 'off'
    if (s.closingOrClosed) return 'closing'
    if (s.op()) return 'turn-open'
    if (((s.latest('inbox') as Inbox | undefined)?.items.length ?? 0) > 0) return 'inbox'
    if (await s.controls.paused()) return 'paused'
    // Saved since the plan was made (switched off and on, or the mode): cancelled, never applied.
    if (settings.revision !== run.settingsRevision) {
      await s.append([refinementRunRow(s, runId, 'cancelled', { reason: 'settings-changed' })])
      return 'rejected'
    }
    if (run.readSet && !readSetCurrent(s, run.readSet)) {
      await s.append([refinementRunRow(s, runId, 'rejected', { reason: 'read-set-changed' })])
      return 'rejected'
    }
    const ended = (o: { outcome: string; reason?: string }) =>
      o.outcome === 'applied'
        ? refinementRunRow(s, runId, 'applied', {})
        : refinementRunRow(s, runId, 'rejected', { reason: o.reason ?? 'apply', detail: o.outcome })
    let result: Awaited<ReturnType<typeof applyRefine>>
    try {
      result = await applyRefine(s, proposalOf({ ...run, plan: run.plan }), APPLY_LIMITS, {
        expectedRegisterSeq: { register: 'op.state', key: s.lane, seq: s.opSeq() },
        with: (o) => [ended(o)],
      })
    } catch (error) {
      // Another writer opened a turn on this lane: the apply waits for its end.
      if (error instanceof CoreError && error.code === 'E_CAS') return 'turn-open'
      throw error
    }
    // A replay of an apply already on the ledger writes nothing; the run still records how it ended.
    if (s.state.refinementRuns.get(runId)?.state === 'proposed') await s.append([ended(result)])
    return result.outcome === 'applied' ? 'applied' : 'rejected'
  })
}

/** Applies every proposed run, oldest first, while nothing stands in the way. */
export async function applyProposed(s: SessionImpl): Promise<void> {
  const proposed = [...s.state.refinementRuns.values()]
    .filter((run) => run.state === 'proposed')
    .sort((a, b) => a.queuedSeq - b.queuedSeq)
  for (const run of proposed) {
    const attempt = await tryApply(s, run.runId)
    if (attempt !== 'applied' && attempt !== 'rejected' && attempt !== 'not-proposed') return
  }
}
