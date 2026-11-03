import type { Seq } from '@agnes/core-common/types'
import type {
  RefinementEntryKind,
  RefinementPlan,
  RefinementRunRecord,
  RefinementWorkspaceConfirmation,
  RefinementWorkspaceRef,
} from '@agnes/core-ledger/reduce/state'
import { entryKey } from '../refine/apply.js'
import type { SessionImpl } from '../step/session.js'
import { evidenceItemsOf } from './evidence.js'
import { redactClipped } from './redact.js'
import type { PlannerWorkspaceRef } from './types.js'
import { boundMeta, type Confirmation, confirmationOf, type EvidenceFact, readFacts } from './validity.js'

/**
 * Entries saved to the workspace, as a session's planner may see them.
 *
 * A memory paragraph or a skill that refinement saved to the workspace outlives the session it came
 * from; it stays in force until its review date. A later plan in any session of the workspace is shown
 * such entries as references it may only confirm: it can never rewrite or delete them. A confirmation
 * follows the same structural rules as one of a session entry: a verbatim quote of a cited request of
 * the user's own (checked against the masked text the planner was shown), or a failed and then
 * successful result of the same tool on the same target, each counted once per entry (whatever its
 * content version) by the identity of the original evidence. Evidence the entry was saved on never counts again, and a tool
 * result that merely echoes the entry (an inspect result, a read of the memory file) never counts. An
 * applied plan's confirmation renews the entry's review date through the host; nothing is written to
 * the entry itself and no approval is asked.
 */

/** Saved entries of one kind the planner is shown at most, and how much of each. */
export const WORKSPACE_REFS_PER_KIND = 40
export const WORKSPACE_TITLE_CHARS = 120
export const WORKSPACE_SUMMARY_CHARS = 240

const REF = /^workspace-(memory|skill)\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])
const MAX_VERSION = 256

/** Whether `value` names an entry saved to the workspace: `workspace-memory/<id>` or `workspace-skill/<name>`. */
export const isWorkspaceRef = (value: unknown): value is string =>
  typeof value === 'string' && REF.test(value)
/** The kinds a plan would have to name to change a saved entry, which it never may. */
export const isWorkspaceKind = (kind: unknown): boolean =>
  kind === 'workspace-memory' || kind === 'workspace-skill'

/** One entry saved to the workspace, as the host lists it for a session's planner. */
export type WorkspaceReference = {
  ref: string
  title: string
  summary: string
  /** Its content version: a memory paragraph's content hash, a skill's revision. */
  version: string
  /** The session entry it was saved from, when it was saved from one. */
  source?: { sessionKey: string; kind: RefinementEntryKind; entryId: string }
}

/**
 * What the host gives Core for entries saved to the workspace: those in force for the session's
 * workspace now, and a renewal of one at the content version a plan confirmed. `renew` answers false
 * (or throws) when it renewed nothing: the entry is gone, revoked, changed or cannot be read.
 */
export type RefinementWorkspaceRefs = {
  list(session: {
    key: string
    lane: string
  }): readonly WorkspaceReference[] | Promise<readonly WorkspaceReference[]>
  renew(session: { key: string; lane: string }, ref: string, version: string): boolean | Promise<boolean>
}

const warn = (s: SessionImpl, what: string, error: unknown) =>
  s.d.logger.warn(`refinement ${what} failed`, { message: String(error) })

function sourceOf(raw: unknown): WorkspaceReference['source'] | undefined {
  const o = raw as { sessionKey?: unknown; kind?: unknown; entryId?: unknown } | null | undefined
  if (!o || typeof o !== 'object') return undefined
  if (typeof o.sessionKey !== 'string' || typeof o.entryId !== 'string' || !KINDS.has(String(o.kind)))
    return undefined
  return { sessionKey: o.sessionKey, kind: o.kind as RefinementEntryKind, entryId: o.entryId }
}

/**
 * The saved entries the host lists for this session now, checked and bounded: well-formed references
 * only, each once, at most `WORKSPACE_REFS_PER_KIND` per kind, title and summary redacted and clipped.
 * A host that is absent or fails lists nothing.
 */
export async function workspaceRefsOf(s: SessionImpl): Promise<WorkspaceReference[]> {
  const port = s.d.refinement?.workspaceRefs
  if (!port) return []
  let listed: readonly WorkspaceReference[]
  try {
    listed = await port.list({ key: s.key, lane: s.lane })
  } catch (error) {
    warn(s, 'workspace listing', error)
    return []
  }
  if (!Array.isArray(listed)) return []
  const out: WorkspaceReference[] = []
  const seen = new Set<string>()
  const perKind = new Map<string, number>()
  for (const raw of listed) {
    if (!raw || !isWorkspaceRef(raw.ref) || seen.has(raw.ref)) continue
    if (typeof raw.version !== 'string' || !raw.version || raw.version.length > MAX_VERSION) continue
    if (typeof raw.title !== 'string' || typeof raw.summary !== 'string') continue
    const kind = raw.ref.slice(0, raw.ref.indexOf('/'))
    const n = perKind.get(kind) ?? 0
    if (n >= WORKSPACE_REFS_PER_KIND) continue
    perKind.set(kind, n + 1)
    seen.add(raw.ref)
    const source = sourceOf(raw.source)
    out.push({
      ref: raw.ref,
      title: redactClipped(raw.title, WORKSPACE_TITLE_CHARS),
      summary: redactClipped(raw.summary, WORKSPACE_SUMMARY_CHARS),
      version: raw.version,
      ...(source ? { source } : {}),
    })
  }
  return out
}

/** The references as the planner is shown them: no version, no source. */
export const plannerWorkspace = (refs: readonly WorkspaceReference[]): PlannerWorkspaceRef[] =>
  refs.map(({ ref, title, summary }) => ({ ref, title, summary }))

/**
 * The references a prompt says it showed, as the run records them, in the prompt's order; `invalid`
 * when it names one it was not given or one twice. A prompt that names none showed none.
 */
export function shownWorkspaceRefs(
  refs: readonly WorkspaceReference[],
  shown: unknown,
): RefinementWorkspaceRef[] | 'invalid' {
  if (shown === undefined) return []
  if (!Array.isArray(shown) || new Set(shown).size !== shown.length) return 'invalid'
  const byRef = new Map(refs.map((r) => [r.ref, r]))
  const out: RefinementWorkspaceRef[] = []
  for (const ref of shown) {
    const r = typeof ref === 'string' ? byRef.get(ref) : undefined
    if (!r) return 'invalid'
    out.push({ ref: r.ref, version: r.version, ...(r.source ? { source: { ...r.source } } : {}) })
  }
  return out
}

const normalized = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase()
/** The shortest piece of a saved entry whose presence in a tool result counts as an echo of it. */
const MIN_PROBE_CHARS = 12
const PROBE_CHARS = 60

/** Pieces of a saved entry that, found in a tool result, show the result only repeats the entry. */
function probesOf(ref: WorkspaceReference): string[] {
  const summary = normalized(ref.summary.replace(/…$/u, '')).slice(0, PROBE_CHARS)
  return [normalized(ref.title), summary].filter((p) => p.length >= MIN_PROBE_CHARS)
}

/** The text of each cited tool result, as the planner was shown it. */
async function toolTexts(s: SessionImpl, facts: ReadonlyMap<Seq, EvidenceFact>): Promise<Map<Seq, string>> {
  const texts = new Map<Seq, string>()
  for (const fact of facts.values()) {
    if (fact.kind !== 'tool') continue
    const [row] = await s.scan({ fromSeq: fact.seq, toSeq: fact.seq })
    const toolUseId = (row?.data as { toolUseId?: unknown } | null)?.toolUseId
    const call = typeof toolUseId === 'string' ? s.state.toolCalls.get(toolUseId) : undefined
    const [callRow] = call ? await s.scan({ fromSeq: call.seq, toSeq: call.seq }) : []
    const item = row && callRow ? evidenceItemsOf([callRow, row])[0] : undefined
    texts.set(fact.seq, item?.text ?? '')
  }
  return texts
}

/**
 * The cited facts with every tool result that cannot speak for a saved entry left out: an inspect
 * result, and any result that repeats the entry's own words.
 */
async function withoutEchoes(
  s: SessionImpl,
  facts: ReadonlyMap<Seq, EvidenceFact>,
  ref: WorkspaceReference,
): Promise<Map<Seq, EvidenceFact>> {
  const probes = probesOf(ref)
  const texts = await toolTexts(s, facts)
  const kept = new Map<Seq, EvidenceFact>()
  for (const [seq, fact] of facts) {
    if (fact.kind === 'tool') {
      if (fact.tool === 'harness_inspect') continue
      const text = normalized(texts.get(seq) ?? '')
      if (probes.some((p) => text.includes(p))) continue
    }
    kept.set(seq, fact)
  }
  return kept
}

/**
 * What a saved entry's origin rules out in this session: when it was saved from an entry of this very
 * session, evidence up to that entry's row (or its removal) is older than the entry, and evidence that
 * entry already spent (its grant and its confirmations) never counts again.
 */
function originOf(s: SessionImpl, shown: RefinementWorkspaceRef): { after: Seq; used: Set<string> } {
  const source = shown.source
  if (!source || source.sessionKey !== s.key) return { after: 0, used: new Set() }
  const key = entryKey({ kind: source.kind, id: source.entryId })
  const cell = s.state.registers.harnessEntries.get(key)
  const gone = s.state.refinementTombstones.get(key)
  const used = new Set([
    ...(boundMeta(s.state, key)?.confirmations.usedEvidence ?? []),
    ...(s.state.refinementEntryMeta.get(key)?.confirmations.usedEvidence ?? []),
  ])
  return { after: Math.max(cell?.seq ?? 0, gone?.seq ?? 0), used }
}

/**
 * Whether an applied run other than `except` (and, given `before`, one applied before that seq) has
 * already counted `identity` for this entry, at any content version. A saved entry has no apply seq in
 * another session to order evidence against, so evidence that bore out one version never counts for
 * the next: a new version needs new evidence.
 */
function spent(
  s: SessionImpl,
  shown: RefinementWorkspaceRef,
  identity: string,
  except: string,
  before?: Seq,
): boolean {
  for (const run of s.state.refinementRuns.values()) {
    if (run.state !== 'applied' || run.runId === except) continue
    if (before !== undefined && run.seq >= before) continue
    const confirmations = run.plan?.workspaceConfirmations ?? []
    if (confirmations.some((c) => c.ref === shown.ref && c.confirmedBy?.identity === identity)) return true
  }
  return false
}

/** Whether a confirmation still counts once its plan is applied: against the origin and earlier runs. */
function stillCounts(
  s: SessionImpl,
  run: RefinementRunRecord,
  shown: RefinementWorkspaceRef,
  by: Confirmation,
): boolean {
  const origin = originOf(s, shown)
  return (
    by.seq > origin.after &&
    !origin.used.has(by.identity) &&
    !spent(s, shown, by.identity, run.runId, run.seq)
  )
}

type Granted = ['proposed' | 'no-op', { plan: RefinementPlan; reason?: string; detail?: string }]

/**
 * Finds what makes each workspace confirmation of a settled plan count, as `grantLevels` does for
 * session entries. A confirmation counts only for an entry the host still lists at the version the
 * planner was shown, with evidence of the right shape that is newer than the entry's origin, not spent
 * by its origin, not an echo of the entry, and not counted by an applied run already. A plan that only
 * its workspace confirmations make worth applying is proposed.
 */
export async function grantWorkspace(
  s: SessionImpl,
  run: RefinementRunRecord,
  granted: Granted,
): Promise<Granted> {
  const [state, facts] = granted
  const asked = facts.plan.workspaceConfirmations
  if (!asked?.length) return granted
  const live = new Map((await workspaceRefsOf(s)).map((r) => [r.ref, r]))
  const shownByRef = new Map((run.workspaceRefs ?? []).map((r) => [r.ref, r]))
  const confirmations: RefinementWorkspaceConfirmation[] = []
  for (const c of asked) {
    const { confirmedBy: _unchecked, ...rest } = c
    const shown = shownByRef.get(c.ref)
    const now = live.get(c.ref)
    if (!shown || !now || now.version !== shown.version) {
      confirmations.push(rest)
      continue
    }
    const origin = originOf(s, shown)
    const facts = await withoutEchoes(s, await readFacts(s, c.evidenceSeqs), now)
    const by = confirmationOf(facts, c, origin.after)
    const counts = by && !origin.used.has(by.identity) && !spent(s, shown, by.identity, run.runId)
    confirmations.push(counts ? { ...rest, confirmedBy: by } : rest)
  }
  const plan: RefinementPlan = { ...facts.plan, workspaceConfirmations: confirmations }
  if (state === 'no-op' && confirmations.some((c) => c.confirmedBy)) return ['proposed', { plan }]
  return [state, { ...facts, plan }]
}

/** Whether applying `plan` would renew a saved entry. */
export const renewsWorkspace = (plan: RefinementPlan): boolean =>
  (plan.workspaceConfirmations ?? []).some((c) => c.confirmedBy)

/**
 * Renews each saved entry an applied run confirmed, once per entry, at the version the planner was
 * shown, and only while refinement is still on. Called after the apply has committed, outside the
 * session lock: the host's registry has its own. A renewal that fails is logged and dropped; its
 * evidence stays counted, so the same evidence never renews the entry later.
 */
export async function renewConfirmed(s: SessionImpl, runId: string): Promise<void> {
  const run = s.state.refinementRuns.get(runId)
  const port = s.d.refinement?.workspaceRefs
  if (run?.state !== 'applied' || !run.plan || !port || !renewsWorkspace(run.plan)) return
  const shownByRef = new Map((run.workspaceRefs ?? []).map((r) => [r.ref, r]))
  const done = new Set<string>()
  for (const c of run.plan.workspaceConfirmations ?? []) {
    const shown = shownByRef.get(c.ref)
    if (!c.confirmedBy || !shown || done.has(c.ref) || !stillCounts(s, run, shown, c.confirmedBy)) continue
    done.add(c.ref)
    try {
      if (s.d.refinement?.settings().enabled !== true) return
      await port.renew({ key: s.key, lane: s.lane }, shown.ref, shown.version)
    } catch (error) {
      warn(s, 'workspace renewal', error)
    }
  }
}
