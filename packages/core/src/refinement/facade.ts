import { CoreError, type Seq } from '@agnes/core-common/types'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { RefinementPlan, RefinementTrigger } from '@agnes/core-ledger/reduce/state'
import { recoverMaintenance } from '../maintenance/recovery.js'
import { entryKey } from '../refine/apply.js'
import { isChildSession } from '../step/child-session.js'
import type { SessionImpl } from '../step/session.js'
import { APPLY_LIMITS, automaticRefusal, type LimitRefusal } from './limits.js'
import { redactEvidence } from './redact.js'
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

export type { RefinementDeps, RefinementSettingsView } from './scheduler.js'

export type RefinementRefusal =
  | 'unavailable'
  | 'refinement-off'
  | 'manual-mode'
  | 'child-session'
  | 'closing'
  | 'invalid'
  | 'read-first'
  | LimitRefusal

/** A run that was accepted (queued, or proposed for a direct proposal), or why nothing was written. */
export type RefinementOutcome = { runId: string } | { refused: RefinementRefusal; detail?: string }

/**
 * A change the model proposes directly, without a planning call. Until entries can be read with a
 * snapshot to change against, it may only create entries that do not exist yet.
 */
export type DirectProposal = {
  rationale: string
  evidenceSeqs: readonly Seq[]
  edits: readonly (
    | { op: 'upsert'; kind: HarnessEntry['kind']; id: string; title: string; content: string }
    | { op: 'delete'; kind: HarnessEntry['kind']; id: string }
  )[]
}

/**
 * Core's managed refinement for one session: what the host, its RPCs and the refinement tools call.
 * Planning runs in the background on the maintenance lane and never holds the session; a plan's
 * result is applied only between two turns.
 */
export type RefinementFacade = Readonly<{
  /** Queues a plan for this trigger; manual triggers only wait for a plan already running. */
  request(trigger: RefinementTrigger): Promise<RefinementOutcome>
  /** Records a direct proposal and applies it once the session is between turns. */
  propose(proposal: DirectProposal): Promise<RefinementOutcome>
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

async function request(s: SessionImpl, trigger: RefinementTrigger): Promise<RefinementOutcome> {
  const refused = refusal(s)
  if (refused) return refused
  const settings = settingsOf(s) as RefinementSettingsView
  const automatic = trigger.kind !== 'manual'
  // Everything but the user's own request is automatic: it follows the mode and the limits.
  if (automatic && settings.mode !== 'auto') return { refused: 'manual-mode' }
  if (!plannerOf(s)) return { refused: 'unavailable' }
  const busy = slotOf(s).planning !== undefined
  if (automatic) {
    // While a plan runs, an automatic trigger waits only if nothing but that plan's cooldown would
    // stop it then; any other limit cannot clear before the next start.
    const why = await automaticRefusal(s, s.d.refinement?.target, busy ? { cooldown: false } : {})
    if (why) return { refused: why.refused }
  }
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
  for (const [at, edit] of p.edits.entries()) {
    if (!KINDS.has(edit?.kind) || typeof edit.id !== 'string' || !ID.test(edit.id))
      return invalid(`edits[${at}]`)
    const key = entryKey(edit)
    if (touched.has(key)) return invalid(`edits[${at}]: duplicate`)
    touched.add(key)
    // Changing or removing a saved entry needs a read of it to change against; none exists yet.
    if (edit.op !== 'upsert' || s.state.registers.harnessEntries.has(key))
      return { refused: 'read-first', detail: `${edit.kind}/${edit.id}` }
    const title = typeof edit.title === 'string' ? redactEvidence(edit.title) : undefined
    const content = typeof edit.content === 'string' ? redactEvidence(edit.content) : undefined
    if (title === undefined || title.length === 0 || title.length > 256) return invalid(`edits[${at}].title`)
    if (content === undefined || content.length === 0 || content.length > APPLY_LIMITS.maxChars)
      return invalid(`edits[${at}].content`)
    edits.push({
      op: 'upsert',
      kind: edit.kind,
      id: edit.id,
      title,
      content,
      applicability: 'session',
      evidenceSeqs,
    })
  }
  return {
    summary: (rationale.split('\n')[0] ?? '').slice(0, 1000),
    rationale,
    expectedOutcome: '',
    edits,
    confirmations: [],
    evidenceSeqs,
    // Each entry must still not exist when the proposal is applied.
    baseline: edits.map((edit) => ({ kind: edit.kind, id: edit.id, version: 0 })),
  }
}

async function propose(s: SessionImpl, p: DirectProposal): Promise<RefinementOutcome> {
  const refused = refusal(s)
  if (refused) return refused
  const plan = directPlan(s, p)
  if ('refused' in plan) return plan
  const runId = s.d.ids.ulid()
  const written = await s.locked(async () => {
    const settings = settingsOf(s)
    if (!settings) return false
    const trigger: RefinementTrigger = { kind: 'model', seq: s.lastSeq }
    await s.append([
      refinementRunRow(s, runId, 'proposed', { trigger, settingsRevision: settings.revision, plan }),
    ])
    return true
  })
  if (!written) return { refused: 'refinement-off' }
  await tryApply(s, runId)
  return { runId }
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
    propose: (proposal: DirectProposal) => propose(s, proposal),
    afterTurn: () => refinementAfterTurn(s),
    onIdlePlanFinished: async (runId: string) => {
      if (!settingsOf(s)) return
      await tryApply(s, runId)
      pump(s)
    },
  })
}
