import type { Event, Seq } from '@agnes/core-common/types'

/** The Core row that records each step of a background refinement run. */
export const REFINEMENT_RUN_EVENT = 'x/core/refinement-run'

export type RefinementRunState =
  | 'queued'
  | 'planning'
  | 'proposed'
  | 'applied'
  | 'no-op'
  | 'rejected'
  | 'superseded'
  | 'cancelled'
  | 'unknown'

export type RefinementTriggerKind = 'manual' | 'model' | 'compaction' | 'repeated-failure'
/**
 * What asked for a run: who, at which seq, and an optional focus. `saveTo: 'workspace'` asks for the
 * run's applied result to be saved to the session's workspace as well; `saveTo: 'user'` (the user's own
 * request or the model's) saves it to user memory instead. `allowUnpriced` (the user's own request only) records
 * that the user agreed to plan on a model with no known price.
 */
export type RefinementTrigger = {
  kind: RefinementTriggerKind
  seq: Seq
  focus?: string
  saveTo?: 'workspace' | 'user'
  allowUnpriced?: true
}

export type RefinementEntryKind = 'prompt' | 'memory' | 'skill' | 'subagent'
export type RefinementEntryRef = { kind: RefinementEntryKind; id: string }
/**
 * What a plan was built on and what must still hold when it is applied: every saved entry, by the
 * seq of the row that last wrote its cell (a delete and a re-create give a new seq, so "gone" and
 * "back again" both differ), every removed one (`removed`, by the seq that recorded its removal, so
 * "written and removed again" differs too), and the settings revision.
 */
export type RefinementReadSet = {
  settingsRevision: string
  entries: (RefinementEntryRef & { seq: Seq; version: number; removed?: true })[]
}
/**
 * One evidence id the planner saw, fixed to the ledger row it stands for, with what kind of fact it
 * is: only `user` (the user's own, trusted request) can back a quoted lesson.
 */
export type RefinementEvidenceRef = {
  id: string
  lane: string
  seq: Seq
  kind: 'user' | 'external' | 'tool' | 'summary'
}

export type RefinementPlanEdit =
  | {
      op: 'upsert'
      kind: RefinementEntryKind
      id: string
      title: string
      content: string
      applicability: 'task' | 'session'
      evidenceSeqs: Seq[]
      /** Kept only when the edit cites a request of the user's own; `quoteSeqs` are those requests. */
      quote?: string
      quoteSeqs?: Seq[]
      /**
       * A task-level lesson planned with no goal to bind it to: it would have expired with the goal it
       * never had, so it stays on the plan as a record and is never applied.
       */
      expired?: true
      /** The goal a task-level lesson is bound to; it expires when that goal is completed or replaced. */
      taskScope?: { id: string; revision: number }
      /** Asked for at session level but without the evidence that grants it, so kept at task level. */
      downgraded?: true
      /** The evidence identities that granted session level; they never count as confirmations. */
      usedEvidence?: string[]
      /** A skill or subagent bound to an approved resource: `<resourceId>@<revision>`, or an agent reference. */
      reference?: string
      /**
       * The lesson may be promoted to user memory, read in every workspace. Absent means its workspace
       * only. The planner suggests it; Core keeps it only where the structure allows.
       */
      reach?: 'user'
    }
  | { op: 'delete'; kind: RefinementEntryKind; id: string; evidenceSeqs: Seq[] }
/**
 * An entry saved to the workspace, shown to a run's planner as confirm-only: its reference
 * (`workspace-memory/<paragraph id>` or `workspace-skill/<name>`), the content version it was shown
 * at, and, when it was saved from a session entry, that entry.
 */
export type RefinementWorkspaceRef = {
  ref: string
  version: string
  source?: { sessionKey: string; kind: RefinementEntryKind; entryId: string }
}
/**
 * A plan's report that new evidence bore out an entry saved to the workspace. It never changes the
 * entry; once the plan is applied it renews the entry's review date.
 */
export type RefinementWorkspaceConfirmation = {
  ref: string
  evidenceSeqs: Seq[]
  quote?: string
  quoteSeqs?: Seq[]
  /** The evidence that makes it count, checked when the plan settled; absent, it renews nothing. */
  confirmedBy?: { identity: string; seq: Seq }
}
/** A validated plan, with every evidence id already replaced by its fixed seq. */
export type RefinementPlan = {
  summary: string
  rationale: string
  expectedOutcome: string
  edits: RefinementPlanEdit[]
  confirmations: (RefinementEntryRef & {
    evidenceSeqs: Seq[]
    quote?: string
    quoteSeqs?: Seq[]
    /** The evidence that makes this a confirmation, checked when the plan settled; absent, it counts nothing. */
    confirmedBy?: { identity: string; seq: Seq }
  })[]
  evidenceSeqs: Seq[]
  /**
   * The version each touched entry had when it was shown in full, and its mutation token then (`seq`:
   * the row that set its cell, or recorded its removal; 0 for an id never written). Rows written
   * before the token was recorded carry the version alone.
   */
  baseline: (RefinementEntryRef & { version: number; seq?: Seq })[]
  /**
   * Entries an upsert replaces without a read because they were no longer in force (their task had
   * ended). The apply refuses the plan if any of them is in force again.
   */
  lapsed?: RefinementEntryRef[]
  /** Confirmations of entries saved to the workspace; absent when the plan has none. */
  workspaceConfirmations?: RefinementWorkspaceConfirmation[]
}

/** A run as its rows fold: the latest state and every fact recorded on the way. */
export type RefinementRunRecord = {
  runId: string
  trigger: RefinementTrigger
  state: RefinementRunState
  reason?: string
  detail?: string
  /** The row that queued the run, and the row that set its current state. */
  queuedSeq: Seq
  seq: Seq
  settingsRevision?: string
  evidenceHash?: string
  readSet?: RefinementReadSet
  /** Which planning attempt is current; each attempt sends at most one call. */
  attempt?: number
  evidence?: RefinementEvidenceRef[]
  fullEntries?: RefinementEntryRef[]
  shownEntries?: RefinementEntryRef[]
  /** Entries saved to the workspace the planner was shown, which it may only confirm. */
  workspaceRefs?: RefinementWorkspaceRef[]
  target?: { route: string; model: string }
  plan?: RefinementPlan
}

export const TERMINAL_RUN_STATES: ReadonlySet<RefinementRunState> = new Set([
  'applied',
  'no-op',
  'rejected',
  'superseded',
  'cancelled',
  'unknown',
])

/**
 * The edges a run may take. A planning run goes back to queued only when its call was never sent.
 * Only a proposed plan is applied; a plan with nothing to change ends `no-op`, so `applied` always
 * means entries changed.
 */
const NEXT: Readonly<Record<RefinementRunState, readonly RefinementRunState[]>> = {
  queued: ['planning', 'superseded', 'cancelled', 'rejected'],
  planning: ['queued', 'proposed', 'no-op', 'rejected', 'cancelled', 'unknown'],
  proposed: ['applied', 'rejected', 'cancelled'],
  applied: [],
  'no-op': [],
  rejected: [],
  superseded: [],
  cancelled: [],
  unknown: [],
}

export const canMoveRun = (from: RefinementRunState, to: RefinementRunState): boolean =>
  NEXT[from].includes(to)

const STATES = new Set(Object.keys(NEXT))
const KINDS = new Set(['manual', 'model', 'compaction', 'repeated-failure'])

function triggerOf(raw: unknown): RefinementTrigger | undefined {
  const t = raw as {
    kind?: unknown
    seq?: unknown
    focus?: unknown
    saveTo?: unknown
    allowUnpriced?: unknown
  } | null
  if (!t || typeof t !== 'object' || !KINDS.has(String(t.kind))) return undefined
  if (!Number.isSafeInteger(t.seq) || (t.seq as number) < 0) return undefined
  if (t.focus !== undefined && typeof t.focus !== 'string') return undefined
  if (t.saveTo !== undefined && t.saveTo !== 'workspace' && t.saveTo !== 'user') return undefined
  // Only a person's own request or the model's may target user memory: no other trigger has anyone behind it.
  if (t.saveTo === 'user' && t.kind !== 'manual' && t.kind !== 'model') return undefined
  if (t.allowUnpriced !== undefined && (t.allowUnpriced !== true || t.kind !== 'manual')) return undefined
  return {
    kind: t.kind as RefinementTriggerKind,
    seq: t.seq as Seq,
    ...(t.focus === undefined ? {} : { focus: t.focus as string }),
    ...(t.saveTo === undefined ? {} : { saveTo: t.saveTo as 'workspace' | 'user' }),
    ...(t.allowUnpriced === true ? { allowUnpriced: true as const } : {}),
  }
}

const FACTS = [
  'settingsRevision',
  'evidenceHash',
  'readSet',
  'attempt',
  'evidence',
  'fullEntries',
  'shownEntries',
  'workspaceRefs',
  'target',
  'plan',
] as const

/**
 * Folds one `x/core/refinement-run` row into the run it names, or returns undefined to leave the
 * runs as they were. Only Core's own rows count (system, trusted, version 1), the first row of a run
 * must queue it, refuse it or propose a plan, with a trigger, and a row that takes an edge the state
 * machine does not have is ignored: a terminal run never moves again.
 */
export function foldRefinementRun(
  prev: RefinementRunRecord | undefined,
  e: Pick<Event, 'seq' | 'origin' | 'trust' | 'data'>,
): RefinementRunRecord | undefined {
  const d = e.data as Record<string, unknown> | null
  if (e.origin !== 'system' || e.trust !== 'trusted' || !d || d.version !== 1) return undefined
  const runId = d.runId
  const state = d.state as RefinementRunState
  if (typeof runId !== 'string' || runId.length === 0 || !STATES.has(state)) return undefined
  let base: RefinementRunRecord
  if (prev) {
    if (!canMoveRun(prev.state, state)) return undefined
    base = prev
  } else {
    const trigger = triggerOf(d.trigger)
    // A direct proposal needs no planning: it opens already proposed, and only with its plan.
    const opens = state === 'queued' || state === 'rejected' || (state === 'proposed' && d.plan !== undefined)
    if (!trigger || !opens) return undefined
    base = { runId, trigger, state, queuedSeq: e.seq, seq: e.seq }
  }
  const next: RefinementRunRecord = { ...base, state, seq: e.seq }
  delete next.reason
  delete next.detail
  if (typeof d.reason === 'string') next.reason = d.reason
  if (typeof d.detail === 'string') next.detail = d.detail
  for (const fact of FACTS)
    if (d[fact] !== undefined) (next as Record<string, unknown>)[fact] = structuredClone(d[fact])
  return next
}
