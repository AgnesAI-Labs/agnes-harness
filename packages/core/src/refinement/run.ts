import { CoreError, type EventInput, type Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import {
  canMoveRun,
  MAINTENANCE_LANE,
  REFINEMENT_RUN_EVENT,
  type RefinementEntryRef,
  type RefinementPlan,
  type RefinementPlanEdit,
  type RefinementRunRecord,
  type RefinementRunState,
  type RefinementTrigger,
  type RefinementWorkspaceConfirmation,
} from '@agnes/core-ledger/reduce/state'
import { estimateTokens } from '../execution/model-tokens.js'
import { resolveModel } from '../execution/turn/inference.js'
import { sessionIdentity } from '../loop/scope.js'
import { MAINTENANCE_RESULT, type MaintenanceResult, maintenanceEffectId } from '../maintenance/execute.js'
import { maintenanceInFlight } from '../maintenance/in-flight.js'
import type { MaintenancePort } from '../maintenance/port.js'
import { entryKey } from '../refine/apply.js'
import type { EffectiveEntry } from '../request/experience.js'
import { rankEntries } from '../request/rank-entries.js'
import { sysEvent } from '../step/events.js'
import type { SessionImpl } from '../step/session.js'
import { freezeEvidence, readSetCurrent } from './evidence.js'
import { redactEvidence } from './redact.js'
import { isReference, unavailableReferences } from './references.js'
import { readTaskScope } from './task-scope.js'
import {
  type EvidenceSnapshot,
  MAX_EDIT_CHARS,
  MAX_PLAN_EDITS,
  PLANNER_DEADLINE_MS,
  PLANNER_ENTRIES_PER_KIND,
  PLANNER_INPUT_TOKENS,
  PLANNER_OUTPUT_TOKENS,
  type PlannerEntry,
  type PlannerPrompt,
  type RefinementPlanner,
} from './types.js'
import { type EntryView, entryValidity, grantLevels, lapsedKeys, validEntries } from './validity.js'
import {
  grantWorkspace,
  isWorkspaceKind,
  isWorkspaceRef,
  plannerWorkspace,
  shownWorkspaceRefs,
  workspaceRefsOf,
} from './workspace-refs.js'

/** The Core row each step of a refinement run is recorded as, on the maintenance lane. */
export const REFINEMENT_RUN = REFINEMENT_RUN_EVENT

export type RefinementRunDeps = {
  maintenance: MaintenancePort
  planner: RefinementPlanner
  /** The refinement switch and its revision as they are now. */
  settings: () => { enabled: boolean; revision: string }
  /** The planner model; absent means the session's current primary model, frozen for the run. */
  target?: { route: string; model: string }
  /** A manual run the user agreed to pay an unknown price for. */
  allowUnpriced?: boolean
}

export type RunFacts = Omit<Partial<RefinementRunRecord>, 'runId' | 'state' | 'queuedSeq' | 'seq'>

const KINDS: readonly HarnessEntry['kind'][] = ['prompt', 'memory', 'skill', 'subagent']
const TRIGGERS = new Set(['manual', 'model', 'compaction', 'repeated-failure'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_FOCUS = 512
/** Evidence ids one edit or confirmation may cite; a plan's own list may hold four times as many. */
const MAX_CITED_IDS = 20

/** One step of a run, as the row that records it on the maintenance lane. */
export const refinementRunRow = (
  s: SessionImpl,
  runId: string,
  state: RefinementRunState,
  facts: RunFacts,
): EventInput =>
  sysEvent(
    { actor: s.d.actor, lane: MAINTENANCE_LANE },
    REFINEMENT_RUN_EVENT,
    { version: 1, runId, state, ...facts },
    { ignorable: true },
  )

/**
 * Writes one step of a run under the session lock, only if the run may still take it and `guard`
 * agrees with what the run is now. Returns the run as it folds afterwards (or as it was, unmoved).
 */
function move(
  s: SessionImpl,
  runId: string,
  state: RefinementRunState,
  facts: RunFacts,
  guard: (run: RefinementRunRecord) => boolean = () => true,
): Promise<RefinementRunRecord | undefined> {
  return s.locked(async () => {
    const run = s.state.refinementRuns.get(runId)
    if (!run || !canMoveRun(run.state, state) || !guard(run)) return run
    await s.append([refinementRunRow(s, runId, state, facts)])
    return s.state.refinementRuns.get(runId)
  })
}

/** Runs this process is planning, by session, so a recovery sweep never settles one under it. */
const planningHere = new WeakMap<object, Set<string>>()
function claimPlanning(s: SessionImpl, runId: string): (() => void) | undefined {
  const owner = sessionIdentity(s)
  const runs = planningHere.get(owner) ?? new Set<string>()
  planningHere.set(owner, runs)
  if (runs.has(runId)) return undefined
  runs.add(runId)
  return () => runs.delete(runId)
}

/**
 * Queues a run for `trigger` and returns its id. Planning it is a separate step. `settingsRevision`
 * is the switch revision the run was accepted under; a run is never planned under another one.
 */
export async function queueRefinementRun(
  s: SessionImpl,
  trigger: RefinementTrigger,
  settingsRevision?: string,
): Promise<string> {
  if (
    !TRIGGERS.has(trigger?.kind) ||
    !Number.isSafeInteger(trigger.seq) ||
    trigger.seq < 0 ||
    (trigger.focus !== undefined &&
      (typeof trigger.focus !== 'string' || trigger.focus.length > MAX_FOCUS)) ||
    (trigger.saveTo !== undefined && trigger.saveTo !== 'workspace') ||
    (trigger.allowUnpriced !== undefined && (trigger.allowUnpriced !== true || trigger.kind !== 'manual'))
  )
    throw new CoreError('E_ENVELOPE', 'refinement trigger is invalid')
  const runId = s.d.ids.ulid()
  const clean: RefinementTrigger = {
    kind: trigger.kind,
    seq: trigger.seq,
    ...(trigger.focus === undefined ? {} : { focus: trigger.focus }),
    ...(trigger.saveTo === undefined ? {} : { saveTo: trigger.saveTo }),
    ...(trigger.allowUnpriced === true ? { allowUnpriced: true } : {}),
  }
  const facts = { trigger: clean, ...(settingsRevision === undefined ? {} : { settingsRevision }) }
  await s.locked(() => s.append([refinementRunRow(s, runId, 'queued', facts)]))
  return runId
}

const refOf = (e: { kind: string; id: string }) => `${e.kind}/${e.id}`

/**
 * The saved entries in force the planner is offered: per kind, the most relevant to the evidence
 * first. A task-level entry whose goal has ended is not offered.
 */
function plannerEntries(snapshot: EvidenceSnapshot, valid: readonly EntryView[]) {
  const usable: EffectiveEntry[] = []
  for (const cell of valid) {
    const e = cell.entry as Partial<HarnessEntry> | null
    if (e && KINDS.includes(e.kind as HarnessEntry['kind']) && typeof e.id === 'string')
      usable.push({ entry: e as HarnessEntry, seq: cell.seq })
  }
  const query = [snapshot.trigger.focus ?? '', ...snapshot.items.map((item) => item.text)].join('\n')
  const ranked = rankEntries(usable, query)
  const entries: PlannerEntry[] = []
  const counts = { prompt: 0, memory: 0, skill: 0, subagent: 0 }
  for (const kind of KINDS) {
    const ofKind = ranked.filter((item) => item.entry.kind === kind)
    counts[kind] = ofKind.length
    for (const { entry } of ofKind.slice(0, PLANNER_ENTRIES_PER_KIND))
      entries.push({
        kind,
        id: entry.id,
        title: String(entry.title ?? ''),
        content: String(entry.content ?? ''),
        version: typeof entry.version === 'number' ? entry.version : 0,
      })
  }
  return { entries, counts }
}

/** What Core checks of a prompt the plugin built: its shape, its size and that it names only what it was given. */
function promptProblem(
  p: PlannerPrompt,
  snapshot: EvidenceSnapshot,
  entries: PlannerEntry[],
): string | undefined {
  const texts = Array.isArray(p?.messages)
    ? p.messages.flatMap((m) =>
        m?.role === 'user' && Array.isArray(m.content) && m.content.length > 0
          ? m.content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : undefined))
          : [undefined],
      )
    : [undefined]
  if (typeof p?.system !== 'string' || texts.length === 0 || texts.some((t) => t === undefined))
    return 'invalid-prompt'
  const tokens = estimateTokens(p.system) + texts.reduce((n, t) => n + estimateTokens(t as string), 0)
  if (tokens > PLANNER_INPUT_TOKENS) return 'input-too-large'
  const ids = new Set(snapshot.items.map((item) => item.id))
  const keys = new Set(entries.map(refOf))
  if (!Array.isArray(p.evidenceIds) || !p.evidenceIds.every((id) => ids.has(id))) return 'invalid-prompt'
  if (new Set(p.evidenceIds).size !== p.evidenceIds.length) return 'invalid-prompt'
  for (const list of [p.fullEntries, p.referenceEntries])
    if (!Array.isArray(list) || !list.every((e) => keys.has(refOf(e)))) return 'invalid-prompt'
  if (p.evidenceIds.length === 0) return 'no-evidence'
  if (!fullTextShown(p.fullEntries, entries, texts.join('\n'))) return 'full-entry-cut'
  return undefined
}

/**
 * Whether every entry the prompt offers as rewritable carries its whole content, as written or as a
 * JSON string. An entry is replaced whole, so a rewrite from a cut copy would drop the tail the
 * planner never saw; Core does not take the plugin's word for it.
 */
function fullTextShown(full: readonly RefinementEntryRef[], entries: PlannerEntry[], text: string): boolean {
  const byKey = new Map(entries.map((e) => [refOf(e), e.content]))
  return full.every((e) => {
    const content = byKey.get(refOf(e)) ?? ''
    return text.includes(content) || text.includes(JSON.stringify(content).slice(1, -1))
  })
}

const ref = (e: RefinementEntryRef): RefinementEntryRef => ({ kind: e.kind, id: e.id })

/**
 * Plans one queued run: freezes the evidence and the read set, has the plugin build the prompt,
 * sends exactly one bounded maintenance call and settles the run on its answer. Nothing is retried:
 * an answer that does not parse or does not hold rejects the run with its reason, and a retry is a
 * new run. A run that is not queued is returned as it is.
 */
export async function planRefinementRun(
  s: SessionImpl,
  runId: string,
  deps: RefinementRunDeps,
  signal: AbortSignal,
): Promise<RefinementRunRecord | undefined> {
  const run = s.state.refinementRuns.get(runId)
  if (run?.state !== 'queued') return run
  const release = claimPlanning(s, runId)
  if (!release) return run
  const queued = (r: RefinementRunRecord) => r.state === 'queued'
  try {
    const settings = deps.settings()
    if (!settings.enabled) return await move(s, runId, 'cancelled', { reason: 'refinement-off' }, queued)
    // Accepted under another revision: the switch was saved since (turned off and on, or the mode).
    if (run.settingsRevision !== undefined && run.settingsRevision !== settings.revision)
      return await move(s, runId, 'cancelled', { reason: 'settings-changed' }, queued)
    const snapshot = await freezeEvidence(s, run.trigger, { settingsRevision: settings.revision })
    const frozen: RunFacts = {
      settingsRevision: settings.revision,
      evidenceHash: snapshot.evidenceHash,
      readSet: snapshot.readSet,
    }
    if (snapshot.items.length === 0)
      return await move(s, runId, 'rejected', { ...frozen, reason: 'no-evidence' }, queued)
    const { scope, readable } = await readTaskScope(s)
    const { entries, counts } = plannerEntries(snapshot, entryValidity(s.state, scope, readable).valid)
    const workspace = await workspaceRefsOf(s)
    let prompt: PlannerPrompt
    try {
      prompt = deps.planner.buildPrompt(
        {
          items: snapshot.items.map(({ lane: _lane, seq: _seq, ...item }) => item),
          omitted: snapshot.omitted,
        },
        entries,
        {
          trigger: run.trigger.kind,
          ...(run.trigger.focus === undefined ? {} : { focus: run.trigger.focus }),
          taskEnded: snapshot.taskEnded,
          activeGoal: scope !== null,
          counts,
          ...(workspace.length ? { workspace: plannerWorkspace(workspace) } : {}),
          ...(run.trigger.saveTo === 'workspace' ? { saveTo: 'workspace' as const } : {}),
        },
      )
    } catch {
      return await move(s, runId, 'rejected', { ...frozen, reason: 'planner-failed' }, queued)
    }
    const problem = promptProblem(prompt, snapshot, entries)
    if (problem) return await move(s, runId, 'rejected', { ...frozen, reason: problem }, queued)
    const shownWorkspace = shownWorkspaceRefs(workspace, prompt.workspaceRefs)
    if (shownWorkspace === 'invalid')
      return await move(s, runId, 'rejected', { ...frozen, reason: 'invalid-prompt' }, queued)

    const attempt = (run.attempt ?? 0) + 1
    const byId = new Map(snapshot.items.map((item) => [item.id, item]))
    const target = deps.target ?? resolveModel(s, 'primary')
    const planning = await move(
      s,
      runId,
      'planning',
      {
        ...frozen,
        attempt,
        evidence: prompt.evidenceIds.map((id) => {
          const item = byId.get(id) as EvidenceSnapshot['items'][number]
          return { id, lane: item.lane, seq: item.seq, kind: item.kind }
        }),
        fullEntries: prompt.fullEntries.map(ref),
        shownEntries: [...prompt.fullEntries, ...prompt.referenceEntries].map(ref),
        ...(shownWorkspace.length ? { workspaceRefs: shownWorkspace } : {}),
        target: { route: target.route, model: target.model },
      },
      queued,
    )
    if (planning?.state !== 'planning' || planning.attempt !== attempt) return planning
    let result: MaintenanceResult
    try {
      result = await deps.maintenance.invoke(
        {
          runId: `${runId}.${attempt}`,
          system: prompt.system,
          messages: prompt.messages,
          maxOutputTokens: PLANNER_OUTPUT_TOKENS,
          deadlineMs:
            run.trigger.kind === 'manual' ? PLANNER_DEADLINE_MS.manual : PLANNER_DEADLINE_MS.automatic,
          target,
          ...(deps.allowUnpriced ? { allowUnpriced: true } : {}),
        },
        signal,
      )
    } catch (error) {
      // A call refused before it was recorded leaves nothing to wait for; a broken log rethrows below.
      if (s.closingOrClosed) throw error
      return await move(s, runId, 'rejected', { reason: 'maintenance-failed' }, (r) => r.attempt === attempt)
    }
    return await settleRefinementRun(s, runId, attempt, result, deps)
  } finally {
    release()
  }
}

type Verdict = [RefinementRunState, RunFacts]
type Picked = Pick<MaintenanceResult, 'outcome' | 'text' | 'reason' | 'code' | 'dispatch'>
/** What settling needs of a maintenance result, whether it just arrived or was read back from the ledger. */
type Result = { -readonly [K in keyof Picked]: Picked[K] }

/**
 * Settles one planning attempt on its maintenance result, under the session lock, so the read-set
 * check and the row that records the outcome cannot be split by an apply or another writer. A run
 * that has moved on (cancelled, superseded, or a newer attempt) is left alone: a late answer is
 * never applied.
 */
export function settleRefinementRun(
  s: SessionImpl,
  runId: string,
  attempt: number,
  result: Result,
  deps: Pick<RefinementRunDeps, 'planner' | 'settings'>,
): Promise<RefinementRunRecord | undefined> {
  return s.locked(async () => {
    const run = s.state.refinementRuns.get(runId)
    if (run?.state !== 'planning' || run.attempt !== attempt) return run
    // An entry that exists but is not in force (its goal ended) is not shown to the planner, so its id
    // may be written afresh, against its current version.
    let [state, facts] = verdict(s, run, result, deps, lapsedKeys(await validEntries(s)))
    // A skill or role an edit is bound to that cannot be used now: the edit, and so the plan, is refused.
    const unusable =
      state === 'proposed' && facts.plan ? await unavailableReferences(s, facts.plan.edits) : []
    if (unusable.length)
      [state, facts] = ['rejected', { reason: 'reference-unavailable', detail: unusable.join(' ') }]
    // A plan that holds is given its levels: each lesson as the evidence it cites allows, bound to the
    // current goal or recorded as expired without one.
    if (state === 'proposed' && facts.plan)
      [state, facts] = await grantWorkspace(s, run, await grantLevels(s, facts.plan))
    await s.append([refinementRunRow(s, runId, state, facts)])
    return s.state.refinementRuns.get(runId)
  })
}

function verdict(
  s: SessionImpl,
  run: RefinementRunRecord,
  result: Result,
  deps: Pick<RefinementRunDeps, 'planner' | 'settings'>,
  lapsed: ReadonlySet<string>,
): Verdict {
  if (result.outcome === 'unknown') return ['unknown', { reason: result.reason ?? 'unknown' }]
  // A call that never left can be planned again, as a new attempt, once the session reopens.
  if (result.outcome === 'error' && result.dispatch === 'not-sent' && result.reason === 'closing')
    return ['queued', { reason: 'closing' }]
  const settings = deps.settings()
  if (!settings.enabled) return ['cancelled', { reason: 'refinement-off' }]
  if (result.outcome === 'error')
    return result.reason === 'cancelled'
      ? ['cancelled', { reason: 'cancelled' }]
      : ['rejected', { reason: result.reason ?? 'provider', ...(result.code ? { detail: result.code } : {}) }]
  if (settings.revision !== run.settingsRevision) return ['rejected', { reason: 'settings-changed' }]
  if (!run.readSet || !readSetCurrent(s, run.readSet)) return ['rejected', { reason: 'read-set-changed' }]
  let parsed: unknown
  try {
    parsed = deps.planner.parseOutput(result.text ?? '', {
      evidenceIds: (run.evidence ?? []).map((e) => e.id),
      fullEntries: run.fullEntries ?? [],
      shownEntries: run.shownEntries ?? [],
      ...(run.workspaceRefs?.length ? { workspaceRefs: run.workspaceRefs.map((r) => r.ref) } : {}),
    })
  } catch {
    return ['rejected', { reason: 'invalid-output', detail: 'parser-failed' }]
  }
  const error = (parsed as { error?: unknown } | null)?.error
  if (typeof error === 'string')
    return ['rejected', { reason: 'invalid-output', detail: error.slice(0, 200) }]
  const plan = checkedPlan(parsed, run, lapsed)
  if ('error' in plan) return ['rejected', { reason: 'invalid-output', detail: plan.error }]
  if (plan.edits.length === 0 && plan.confirmations.length === 0 && !plan.workspaceConfirmations)
    return ['no-op', {}]
  return ['proposed', { plan }]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max
const only = (o: Obj, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k))
const OUTPUT_KEYS = ['summary', 'rationale', 'expectedOutcome', 'edits', 'confirmations', 'evidenceIds']
const UPSERT_KEYS = [
  'op',
  'kind',
  'id',
  'title',
  'content',
  'applicability',
  'evidenceIds',
  'quote',
  'reference',
]

class Invalid extends Error {}
const invalid = (why: string): never => {
  throw new Invalid(why)
}
/**
 * Planner text as it may be stored: an entry is re-sent with every later request, so a credential
 * the planner echoed from evidence the redaction missed is masked here too. The masked text must
 * still fit the same bounds.
 */
const masked = (text: string, max: number, why: string, min = 0): string => {
  const out = redactEvidence(text)
  return out.length >= min && out.length <= max ? out : invalid(why)
}

/**
 * Core's own check of a parsed plan, whatever the plugin accepted: the shape, at most 5 edits of at
 * most 2,000 characters, only evidence ids the prompt showed (each replaced by its fixed seq), only
 * entries shown in full rewritten or deleted, one edit and one confirmation per entry. A deleted
 * entry the model was given is withdrawn by a control notice ahead of the next request's other notes.
 */
function checkedPlan(
  out: unknown,
  run: RefinementRunRecord,
  lapsed: ReadonlySet<string>,
): RefinementPlan | { error: string } {
  const seqOf = new Map((run.evidence ?? []).map((e) => [e.id, e.seq]))
  const seqs = (ids: unknown, max = MAX_CITED_IDS): Seq[] => {
    if (!Array.isArray(ids) || ids.length > max) return invalid('invalid-shape: evidenceIds')
    const seen = new Set<unknown>()
    return ids.map((id) => {
      if (seen.has(id)) invalid(`duplicate-evidence: ${String(id)}`)
      seen.add(id)
      return seqOf.get(id as string) ?? invalid(`unknown-evidence: ${String(id)}`)
    })
  }
  // Only the user's own requests can back a quote; a quote with no such citation is dropped, so it
  // can never grant a lesson more than it would get without one.
  const userSeqs = new Set((run.evidence ?? []).filter((e) => e.kind === 'user').map((e) => e.seq))
  const quoted: Quoted = (quote, cited) => {
    const from = quote === undefined ? [] : cited.filter((seq) => userSeqs.has(seq))
    return from.length ? { quote: quote as string, quoteSeqs: from } : {}
  }
  const existing = new Map(
    (run.readSet?.entries ?? [])
      .filter((e) => !e.removed)
      .map((e) => [refOf(e), { version: e.version, seq: e.seq }]),
  )
  const full = new Set((run.fullEntries ?? []).map(refOf))
  const shown = new Set((run.shownEntries ?? []).map(refOf))
  const shownWorkspace = new Set((run.workspaceRefs ?? []).map((r) => r.ref))
  try {
    if (
      !isObj(out) ||
      !only(out, OUTPUT_KEYS) ||
      !str(out.summary, 1000) ||
      !str(out.rationale, 4000) ||
      !str(out.expectedOutcome, 1000) ||
      !Array.isArray(out.edits) ||
      !Array.isArray(out.confirmations) ||
      !Array.isArray(out.evidenceIds)
    )
      return invalid('invalid-shape: output')
    if (out.edits.length > MAX_PLAN_EDITS) return invalid('too-many-edits')
    const touched = new Set<string>()
    const baseline: RefinementPlan['baseline'] = []
    const reused: RefinementPlan['baseline'] = []
    const edits = out.edits.map((raw, at): RefinementPlanEdit => {
      // An entry saved to the workspace is only ever confirmed, never rewritten or deleted.
      if (isObj(raw) && isWorkspaceKind(raw.kind))
        invalid(`confirm-only: ${String(raw.kind)}/${String(raw.id)}`)
      const edit = checkedEdit(raw, at, seqs, quoted)
      const key = refOf(edit)
      if (touched.has(key)) invalid(`duplicate-entry: ${key}`)
      touched.add(key)
      const saved = existing.get(key)
      if (saved === undefined && edit.op === 'delete') invalid(`unknown-entry: ${key}`)
      // An entry no longer in force (its task ended) does not hold its id: an upsert may reuse it
      // unread. Only one shown in full may be deleted.
      const reuse =
        saved !== undefined && edit.op === 'upsert' && !full.has(key) && lapsed.has(entryKey(edit))
      if (saved !== undefined && !full.has(key) && !reuse) invalid(`not-shown-in-full: ${key}`)
      if (saved !== undefined) baseline.push({ kind: edit.kind, id: edit.id, ...saved })
      if (reuse) reused.push({ kind: edit.kind, id: edit.id, version: saved.version })
      return edit
    })
    const confirmed = new Set<string>()
    const confirmations = out.confirmations.map((raw, at) => {
      if (!isObj(raw) || !only(raw, ['entryId', 'evidenceIds', 'quote']) || !str(raw.entryId, 160, 3))
        return invalid(`invalid-shape: confirmations[${at}]`)
      const workspace = isWorkspaceRef(raw.entryId)
      if (!(workspace ? shownWorkspace : shown).has(raw.entryId)) invalid(`unknown-entry: ${raw.entryId}`)
      if (confirmed.has(raw.entryId)) invalid(`duplicate-confirmation: ${raw.entryId}`)
      confirmed.add(raw.entryId)
      const [kind, ...rest] = raw.entryId.split('/')
      const evidenceSeqs = seqs(raw.evidenceIds)
      if (evidenceSeqs.length === 0) invalid(`invalid-shape: confirmations[${at}]`)
      if (raw.quote !== undefined && !str(raw.quote, 2000, 1)) invalid(`invalid-shape: confirmations[${at}]`)
      const quote =
        typeof raw.quote === 'string'
          ? masked(raw.quote, 2000, `invalid-shape: confirmations[${at}]`, 1)
          : undefined
      const checked = { evidenceSeqs, ...quoted(quote, evidenceSeqs) }
      return workspace
        ? { ref: raw.entryId, ...checked }
        : { kind: kind as HarnessEntry['kind'], id: rest.join('/'), ...checked }
    })
    const ofWorkspace = (c: (typeof confirmations)[number]) => 'ref' in c
    const workspaceConfirmations = confirmations.filter(ofWorkspace) as RefinementWorkspaceConfirmation[]
    return {
      summary: masked(out.summary, 1000, 'invalid-shape: output'),
      rationale: masked(out.rationale, 4000, 'invalid-shape: output'),
      expectedOutcome: masked(out.expectedOutcome, 1000, 'invalid-shape: output'),
      edits,
      confirmations: confirmations.filter((c) => !ofWorkspace(c)) as RefinementPlan['confirmations'],
      ...(workspaceConfirmations.length ? { workspaceConfirmations } : {}),
      evidenceSeqs: seqs(out.evidenceIds, 4 * MAX_CITED_IDS),
      baseline,
      ...(reused.length ? { lapsed: reused.map(ref) } : {}),
    }
  } catch (error) {
    if (error instanceof Invalid) return { error: error.message }
    throw error
  }
}

type Quoted = (quote: unknown, cited: Seq[]) => { quote?: string; quoteSeqs?: Seq[] }

function checkedEdit(
  raw: unknown,
  at: number,
  seqs: (ids: unknown, max?: number) => Seq[],
  quoted: Quoted,
): RefinementPlanEdit {
  const where = `invalid-shape: edits[${at}]`
  if (
    !isObj(raw) ||
    !KINDS.includes(raw.kind as HarnessEntry['kind']) ||
    !str(raw.id, 128) ||
    !ID.test(raw.id)
  )
    return invalid(where)
  const kind = raw.kind as HarnessEntry['kind']
  if (raw.op === 'delete') {
    if (!only(raw, ['op', 'kind', 'id', 'evidenceIds'])) return invalid(where)
    const evidenceSeqs = seqs(raw.evidenceIds)
    if (evidenceSeqs.length === 0) return invalid(where)
    return { op: 'delete', kind, id: raw.id, evidenceSeqs }
  }
  if (
    raw.op !== 'upsert' ||
    !only(raw, UPSERT_KEYS) ||
    !str(raw.title, 256, 1) ||
    typeof raw.content !== 'string' ||
    (raw.applicability !== 'task' && raw.applicability !== 'session') ||
    (raw.quote !== undefined && !str(raw.quote, 2000, 1)) ||
    (raw.reference !== undefined && !isReference(kind, raw.reference))
  )
    return invalid(where)
  if (raw.content.length === 0 || raw.content.length > MAX_EDIT_CHARS) return invalid(`edit-too-long: ${at}`)
  const evidenceSeqs = seqs(raw.evidenceIds)
  if (evidenceSeqs.length === 0) return invalid(where)
  const content = masked(raw.content, MAX_EDIT_CHARS, `edit-too-long: ${at}`)
  return {
    op: 'upsert',
    kind,
    id: raw.id,
    title: masked(raw.title, 256, where, 1),
    content: content.length > 0 ? content : invalid(where),
    applicability: raw.applicability,
    evidenceSeqs,
    ...quoted(raw.quote === undefined ? undefined : masked(raw.quote, 2000, where, 1), evidenceSeqs),
    ...(raw.reference === undefined ? {} : { reference: raw.reference }),
  }
}

/** The recorded result of one attempt's call, if the ledger has one. */
async function recordedResult(s: SessionImpl, run: RefinementRunRecord, effectId: string) {
  const rows = await scanAll((q) => s.scan(q), {
    type: MAINTENANCE_RESULT,
    lane: MAINTENANCE_LANE,
    fromSeq: run.seq,
    toSeq: s.lastSeq,
  })
  const found = rows.find(
    (r) => r.origin === 'system' && r.trust === 'trusted' && (r.data as Obj | null)?.effectId === effectId,
  )
  if (!found) return undefined
  const d = found.data as Obj
  const result: Result = {
    outcome: d.outcome as MaintenanceResult['outcome'],
    dispatch: d.dispatch as MaintenanceResult['dispatch'],
  }
  if (typeof d.text === 'string') result.text = d.text
  if (typeof d.reason === 'string') result.reason = d.reason as NonNullable<MaintenanceResult['reason']>
  if (typeof d.code === 'string') result.code = d.code as NonNullable<MaintenanceResult['code']>
  return result
}

/**
 * Settles runs a previous process left planning, without calling a model again: a call whose result
 * is on the ledger is settled from it (an unknown result leaves the run unknown); a call that was
 * never recorded leaves the run queued for a new attempt. Call it after the maintenance recovery has
 * settled interrupted calls. Returns how many runs it moved.
 */
export async function recoverRefinementRuns(
  s: SessionImpl,
  deps: Pick<RefinementRunDeps, 'planner' | 'settings'>,
): Promise<number> {
  let moved = 0
  const here = planningHere.get(sessionIdentity(s))
  for (const run of [...s.state.refinementRuns.values()]) {
    if (run.state !== 'planning' || run.attempt === undefined || here?.has(run.runId)) continue
    const attempt = run.attempt
    const effectId = maintenanceEffectId(`${run.runId}.${attempt}`)
    if (maintenanceInFlight(s).has(effectId)) continue
    const result = await recordedResult(s, run, effectId)
    if (result) {
      const after = await settleRefinementRun(s, run.runId, attempt, result, deps)
      if (after?.state !== 'planning') moved++
      continue
    }
    // Pending and not ours: the maintenance recovery has not settled it yet, so wait for it.
    if (s.state.pendingEffects.has(effectId)) continue
    const after = await move(s, run.runId, 'queued', { reason: 'interrupted' }, (r) => r.attempt === attempt)
    if (after?.state === 'queued') moved++
  }
  return moved
}
