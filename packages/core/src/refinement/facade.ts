import { CoreError, type Seq } from '@agnes/core-common/types'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { RefinementPlan, RefinementTrigger } from '@agnes/core-ledger/reduce/state'
import { recoverMaintenance } from '../maintenance/recovery.js'
import {
  entryKey,
  mutationToken,
  type RollbackProblem,
  rollbackProblem,
  rollbackRefine,
} from '../refine/apply.js'
import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'
import { resumeHandOffs } from './handoff.js'
import { type InspectAnswer, type InspectRequest, inspectEntries, readInFull } from './inspect.js'
import { APPLY_LIMITS, automaticRefusal, type LimitRefusal, plannerPriced } from './limits.js'
import { redactEvidence } from './redact.js'
import { isReference, unavailableReferences } from './references.js'
import { queueRefinementRun, recoverRefinementRuns, refinementRunRow } from './run.js'
import {
  applyProposed,
  plannerOf,
  pump,
  type RefinementSettingsView,
  settingsOf,
  slotOf,
  supersedeQueued,
  tryApply,
} from './scheduler.js'
import { lapsedKeys, validEntries } from './validity.js'
import { recordSettledSaves } from './workspace.js'

export type { InspectAnswer, InspectEntry, InspectRequest, InspectSummary } from './inspect.js'
export type { RefinementDeps, RefinementSettingsView } from './scheduler.js'

export type RefinementRefusal =
  | 'unavailable'
  | 'refinement-off'
  | 'manual-mode'
  | 'child-session'
  | 'closing'
  | 'invalid'
  | 'read-first'
  | 'not-found'
  | LimitRefusal

/** A run that was accepted (queued, or proposed for a direct proposal), or why nothing was written. */
export type RefinementOutcome = { runId: string } | { refused: RefinementRefusal; detail?: string }
/**
 * A withdrawal that was written (the seq of its `harness/refine` row; a repeat returns the first), or
 * why nothing was: the seq is not an applied refinement of this session (`not-found`, `not-applied`,
 * `is-rollback`, `rejected`), a later change touched an entry it would undo (`changed-since`, with
 * those entries: a person has to decide), or the session cannot take it (`child-session`, `closing`).
 */
export type RollbackResult =
  | { seq: Seq }
  | {
      refused: RollbackProblem | 'changed-since' | 'child-session' | 'closing'
      changed?: { kind: HarnessEntry['kind']; id: string }[]
    }
/**
 * How a direct proposal is to be kept: `saveTo: 'workspace'` saves what it writes to the session's
 * workspace too, once it is applied, as the model's save.
 */
export type ProposeOptions = { saveTo?: 'workspace' }

/** What a read of this session's entries found, or why it could not be answered. */
export type InspectOutcome = InspectAnswer | { refused: RefinementRefusal; detail?: string }

/**
 * A change the model proposes directly, without a planning call. It may create an entry that does not
 * exist yet, replace or delete one this session has read in full (with `inspect` op `get`) at its
 * current version, or reuse the id of one no longer in force (its goal ended). A deleted entry the
 * model was given is withdrawn by a control notice in the next request.
 */
export type DirectProposal = {
  rationale: string
  evidenceSeqs: readonly Seq[]
  edits: readonly (
    | {
        op: 'upsert'
        kind: HarnessEntry['kind']
        id: string
        title: string
        content: string
        /** Skill and subagent only: the approved resource the entry is bound to. */
        reference?: string
      }
    | { op: 'delete'; kind: HarnessEntry['kind']; id: string }
  )[]
}

/**
 * Core's managed refinement for one session: what the host, its RPCs and the refinement tools call.
 * Planning runs in the background on the maintenance lane and never holds the session; a plan's
 * result is applied only between two turns.
 */
export type RefinementFacade = Readonly<{
  /**
   * Queues a plan for this trigger; manual triggers only wait for a plan already running. A trigger
   * with `saveTo: 'workspace'` also saves the applied result to the workspace: as the user's save for
   * a manual trigger, as the model's for the model's.
   */
  request(trigger: RefinementTrigger): Promise<RefinementOutcome>
  /**
   * Records a direct proposal and applies it once the session is between turns; with
   * `saveTo: 'workspace'` what it writes is then saved to the workspace as the model's save.
   */
  propose(proposal: DirectProposal, options?: ProposeOptions): Promise<RefinementOutcome>
  /**
   * Reads this session's entries in force; never another session's, and it writes nothing. An entry
   * whose goal has ended, or whose goal cannot be read now, is not shown.
   */
  inspect(request: InspectRequest): Promise<InspectOutcome>
  /**
   * The owner's withdrawal of one applied refinement (`refineSeq`, its `harness/refine` row): undone
   * as a new refinement, only if every entry it wrote is still as it left it. It works while
   * refinement is off, and at any time: a request prepared before it is prepared again, and the next
   * one withdraws what the model was given before any new entry.
   */
  rollback(refineSeq: Seq): Promise<RollbackResult>
  /** Called when a turn has ended: applies what is proposed, then starts the next queued plan. */
  afterTurn(): Promise<void>
  /** Called when a plan finished while the session may be idle: applies it if nothing is in the way. */
  onIdlePlanFinished(runId: string): Promise<void>
}>

const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_EVIDENCE = 20
const MAX_RATIONALE = 2048

/** The refusals every entry shares: no refinement here, the switch is off, a child, or closing. */
function refusal(s: SessionImpl): { refused: RefinementRefusal } | undefined {
  if (!s.d.refinement) return { refused: 'unavailable' }
  if (!settingsOf(s)) return { refused: 'refinement-off' }
  if (isChildSession(s)) return { refused: 'child-session' }
  if (s.closingOrClosed) return { refused: 'closing' }
  return undefined
}

/**
 * Why a request to save to the workspace cannot even be taken: the target is not one there is, or the
 * host offers no save path here (an embedded host without one), so planning for it would be wasted.
 */
function saveRefusal(
  s: SessionImpl,
  saveTo: unknown,
): { refused: 'unavailable'; detail: string } | undefined {
  if (saveTo === undefined) return undefined
  if (saveTo !== 'workspace' || !s.d.refinement?.workspace)
    return { refused: 'unavailable', detail: 'workspace' }
  return undefined
}

async function request(s: SessionImpl, trigger: RefinementTrigger): Promise<RefinementOutcome> {
  const refused = refusal(s)
  if (refused) return refused
  const settings = settingsOf(s) as RefinementSettingsView
  const automatic = trigger.kind !== 'manual'
  // Everything but the user's own request is automatic: it follows the mode and the limits. The model
  // asking for the result to be saved to the workspace is no exception.
  if (automatic && settings.mode !== 'auto') return { refused: 'manual-mode' }
  const unsaved = saveRefusal(s, trigger.saveTo)
  if (unsaved) return unsaved
  if (!plannerOf(s)) return { refused: 'unavailable' }
  const busy = slotOf(s).planning !== undefined
  if (automatic) {
    // While a plan runs, an automatic trigger waits only if nothing but that plan's cooldown would
    // stop it then; any other limit cannot clear before the next start.
    const why = await automaticRefusal(s, s.d.refinement?.target, busy ? { cooldown: false } : {})
    if (why) return { refused: why.refused }
  } else if (trigger.allowUnpriced !== true && !plannerPriced(s, s.d.refinement?.target))
    // The user's own request on a model with no known price runs only once the user agreed to that.
    return { refused: 'unpriced' }
  let runId: string
  try {
    runId = await queueRefinementRun(s, trigger, settings.revision)
  } catch (error) {
    if (error instanceof CoreError && error.code === 'E_ENVELOPE') return { refused: 'invalid' }
    throw error
  }
  // While a plan runs, only the newest trigger waits for the next one; an automatic trigger never
  // displaces the user's own request.
  if (busy) await supersedeQueued(s, runId, automatic)
  pump(s)
  return { runId }
}

function invalid(detail: string): { refused: 'invalid'; detail: string } {
  return { refused: 'invalid', detail }
}

/** A direct proposal as a plan, or why it cannot be one. */
function directPlan(
  s: SessionImpl,
  p: DirectProposal,
  lapsed: ReadonlySet<string>,
): RefinementPlan | { refused: RefinementRefusal; detail?: string } {
  // The text is stored and re-sent with every later request, so a credential in it is masked first,
  // and the masked text is what must fit.
  const rationale = typeof p?.rationale === 'string' ? redactEvidence(p.rationale) : undefined
  if (rationale === undefined || rationale.length === 0 || rationale.length > MAX_RATIONALE)
    return invalid('rationale')
  const seqs = p.evidenceSeqs
  if (!Array.isArray(seqs) || seqs.length === 0 || seqs.length > MAX_EVIDENCE) return invalid('evidenceSeqs')
  if (!seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 1 && seq <= s.lastSeq))
    return invalid('evidenceSeqs')
  if (!Array.isArray(p.edits) || p.edits.length === 0 || p.edits.length > APPLY_LIMITS.maxEdits)
    return invalid('edits')
  const evidenceSeqs = [...new Set(seqs)]
  const touched = new Set<string>()
  const edits: RefinementPlan['edits'] = []
  const baseline: RefinementPlan['baseline'] = []
  const reused: RefinementPlan['baseline'] = []
  for (const [at, edit] of p.edits.entries()) {
    if (!KINDS.has(edit?.kind) || typeof edit.id !== 'string' || !ID.test(edit.id))
      return invalid(`edits[${at}]`)
    if (edit.op !== 'upsert' && edit.op !== 'delete') return invalid(`edits[${at}].op`)
    const key = entryKey(edit)
    if (touched.has(key)) return invalid(`edits[${at}]: duplicate`)
    touched.add(key)
    // A saved entry changes, or goes, only from a full read of its current cell in this session; the
    // apply checks that version and mutation token again, so a change made since the proposal is a
    // conflict. An entry no longer in force (its goal ended) does not hold its id: it is replaced
    // without a read. A cell without a numeric version (legacy or damaged) cannot have been read: it
    // is never overwritten as if new.
    const cell = s.state.registers.harnessEntries.get(key)
    const saved = (cell?.value as { version?: unknown } | null | undefined)?.version
    const reuse = !!cell && edit.op === 'upsert' && lapsed.has(key)
    if (cell && (typeof saved !== 'number' || (!reuse && !readInFull(s, key, saved, cell.seq))))
      return { refused: 'read-first', detail: `${edit.kind}/${edit.id}` }
    if (!cell && edit.op === 'delete') return { refused: 'not-found', detail: `${edit.kind}/${edit.id}` }
    const version = typeof saved === 'number' ? saved : 0
    baseline.push({ kind: edit.kind, id: edit.id, version, seq: mutationToken(s.state, key) })
    if (reuse) reused.push({ kind: edit.kind, id: edit.id, version })
    if (edit.op === 'delete') {
      edits.push({ op: 'delete', kind: edit.kind, id: edit.id, evidenceSeqs })
      continue
    }
    const title = typeof edit.title === 'string' ? redactEvidence(edit.title) : undefined
    const content = typeof edit.content === 'string' ? redactEvidence(edit.content) : undefined
    if (title === undefined || title.length === 0 || title.length > 256) return invalid(`edits[${at}].title`)
    if (content === undefined || content.length === 0 || content.length > APPLY_LIMITS.maxChars)
      return invalid(`edits[${at}].content`)
    if (edit.reference !== undefined && !isReference(edit.kind, edit.reference))
      return invalid(`edits[${at}].reference`)
    edits.push({
      op: 'upsert',
      kind: edit.kind,
      id: edit.id,
      title,
      content,
      applicability: 'session',
      evidenceSeqs,
      ...(edit.reference === undefined ? {} : { reference: edit.reference }),
    })
  }
  return {
    summary: (rationale.split('\n')[0] ?? '').slice(0, 1000),
    rationale,
    expectedOutcome: '',
    edits,
    confirmations: [],
    evidenceSeqs,
    // Each entry must still be as it was read: absent, read in full, or the lapsed version it replaces.
    baseline,
    ...(reused.length ? { lapsed: reused.map(({ kind, id }) => ({ kind, id })) } : {}),
  }
}

async function propose(
  s: SessionImpl,
  p: DirectProposal,
  options: ProposeOptions = {},
): Promise<RefinementOutcome> {
  const refused = refusal(s)
  if (refused) return refused
  // The model saving to the workspace follows the mode, as its other automatic requests do.
  if (options.saveTo !== undefined && settingsOf(s)?.mode !== 'auto') return { refused: 'manual-mode' }
  const unsaved = saveRefusal(s, options.saveTo)
  if (unsaved) return unsaved
  const plan = directPlan(s, p, lapsedKeys(await validEntries(s)))
  if ('refused' in plan) return plan
  const [unusable] = await unavailableReferences(s, plan.edits)
  if (unusable) return invalid(`reference-unavailable: ${unusable}`)
  const runId = s.d.ids.ulid()
  const written = await s.locked(async () => {
    const settings = settingsOf(s)
    if (!settings) return false
    const trigger: RefinementTrigger = {
      kind: 'model',
      seq: s.lastSeq,
      ...(options.saveTo === 'workspace' ? { saveTo: 'workspace' as const } : {}),
    }
    await s.append([
      refinementRunRow(s, runId, 'proposed', { trigger, settingsRevision: settings.revision, plan }),
    ])
    return true
  })
  if (!written) return { refused: 'refinement-off' }
  await tryApply(s, runId)
  return { runId }
}

async function inspect(s: SessionImpl, request: InspectRequest): Promise<InspectOutcome> {
  const refused = refusal(s)
  if (refused) return refused
  const { valid } = await validEntries(s)
  const out = inspectEntries(s, valid, request)
  if ('problem' in out) return { refused: out.problem, detail: out.detail }
  if (out.op !== 'get') return out
  // A full read keeps the text (a later change builds on it), and says when its resource is unusable now.
  const { kind, id } = out.entry
  const bound = valid.find((v) => v.entry.kind === kind && v.entry.id === id)?.entry.reference
  const unusable =
    bound !== undefined &&
    (await unavailableReferences(s, [{ op: 'upsert', kind, id, reference: bound }])).length > 0
  return unusable ? { ...out, entry: { ...out.entry, unavailable: true } } : out
}

async function rollback(s: SessionImpl, refineSeq: Seq): Promise<RollbackResult> {
  if (isChildSession(s)) return { refused: 'child-session' }
  if (s.closingOrClosed) return { refused: 'closing' }
  return s.locked(async (): Promise<RollbackResult> => {
    const problem = await rollbackProblem(s, refineSeq)
    if (problem) return { refused: problem }
    const out = await rollbackRefine(s, refineSeq)
    return out.outcome === 'applied' ? { seq: out.seq } : { refused: out.reason, changed: out.changed }
  })
}

/** Applies what is proposed now that a turn has ended, then starts the next plan. Never throws. */
export async function refinementAfterTurn(s: SessionImpl): Promise<void> {
  if (!settingsOf(s)) return
  try {
    await applyProposed(s)
    pump(s)
  } catch (error) {
    s.d.logger.warn('refinement apply failed', { message: String(error) })
  }
}

/**
 * Opening a session: settles the maintenance calls a dead process left, then the runs they belonged
 * to, and (unless the session is only being closed) applies a proposed plan if nothing is in the
 * way and picks up a queued one. With refinement off,
 * only the maintenance calls are settled and nothing is written for the runs.
 */
export async function recoverRefinement(s: SessionImpl, mode?: string): Promise<void> {
  await recoverMaintenance(s)
  if (!settingsOf(s)) return
  await recordSettledSaves(s)
  try {
    const planner = plannerOf(s)
    if (planner)
      await recoverRefinementRuns(s, {
        planner,
        settings: () => ({ enabled: settingsOf(s) !== undefined, revision: settingsOf(s)?.revision ?? '' }),
      })
    if (mode !== 'close') {
      // A plan the last process left proposed is applied now if the session is between turns, so
      // the first turn after the reopen reads it; with a turn still open it waits for that turn's end.
      await applyProposed(s)
      // What applied runs still owe the workspace (cut off by a crash, or a host out of reach), in
      // the background: the reopen never waits for the host.
      void resumeHandOffs(s)
      pump(s)
    }
  } catch (error) {
    s.d.logger.warn('refinement recovery failed', { message: String(error) })
  }
}

/** The managed refinement facade of one session. */
export function refinementFacade(s: SessionImpl): RefinementFacade {
  return Object.freeze({
    request: (trigger: RefinementTrigger) => request(s, trigger),
    propose: (proposal: DirectProposal, options?: ProposeOptions) => propose(s, proposal, options),
    inspect: (request: InspectRequest) => inspect(s, request),
    rollback: (refineSeq: Seq) => rollback(s, refineSeq),
    afterTurn: () => refinementAfterTurn(s),
    onIdlePlanFinished: async (runId: string) => {
      if (!settingsOf(s)) return
      await tryApply(s, runId)
      pump(s)
    },
  })
}
