import type { EntryKind, EntryRef } from './prompt.js'

/** At most this many edits in one plan. */
export const MAX_PLAN_EDITS = 5
/** The longest entry content one edit may carry. */
export const MAX_EDIT_CHARS = 2000

export type PlannerEdit =
  | {
      op: 'upsert'
      kind: EntryKind
      id: string
      title: string
      content: string
      applicability: 'task' | 'session'
      evidenceIds: string[]
      /** Skill and subagent only: the approved resource the entry is bound to; the host checks it. */
      reference?: string
      /** A suggestion that the lesson holds in every workspace; Core decides. */
      reach?: 'workspace' | 'user'
    }
  | { op: 'delete'; kind: EntryKind; id: string; evidenceIds: string[] }
export type PlannerConfirmation = { entryId: string; evidenceIds: string[]; quote?: string }
/** A plan as the planner may state it. It never names actor, scope, versions, cost or state. */
export type PlannerOutput = {
  summary: string
  rationale: string
  expectedOutcome: string
  edits: PlannerEdit[]
  confirmations: PlannerConfirmation[]
  evidenceIds: string[]
}
/** What the prompt showed: the only evidence a plan may cite and the only entries it may touch. */
export type ParseContext = {
  evidenceIds: readonly string[]
  fullEntries: readonly EntryRef[]
  shownEntries: readonly EntryRef[]
  /** Entries saved to the workspace the prompt showed; they may only be confirmed. */
  workspaceRefs?: readonly string[]
}

const KINDS = new Set<string>(['prompt', 'memory', 'skill', 'subagent'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_IDS = 20
/** The longest reference to an approved skill or role. */
const MAX_REFERENCE = 512

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max
const ids = (v: unknown, min: number): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= MAX_IDS && v.every((id) => str(id, 64, 1))
/**
 * At most `max` UTF-16 units of `text` (the unit every bound here is checked in), never cut inside a
 * surrogate pair: a character that would be split is dropped whole.
 */
function cut(text: string, max: number): string {
  if (text.length <= max) return text
  const end = text.charCodeAt(max - 1)
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? max - 1 : max)
}
const clip = (v: unknown, max: number): string => (typeof v === 'string' ? cut(v, max) : '')

class Rejected extends Error {}
const reject = (why: string): never => {
  throw new Rejected(why)
}

/** A single fenced block is the same JSON; anything else around it is not. */
function unfence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/u.exec(trimmed)
  return fenced ? (fenced[1] as string) : trimmed
}

/** One edit as stated, or a rejection that drops this edit alone. Fields it may not set are ignored. */
function edit(raw: unknown, at: number): PlannerEdit {
  const where = `invalid-shape: edits[${at}]`
  // An entry saved to the workspace is only ever confirmed, never rewritten or deleted.
  if (isObj(raw) && (raw.kind === 'workspace-memory' || raw.kind === 'workspace-skill'))
    return reject(`confirm-only: ${raw.kind}/${String(raw.id)}`)
  if (!isObj(raw) || !str(raw.kind, 16) || !KINDS.has(raw.kind) || !str(raw.id, 128) || !ID.test(raw.id))
    return reject(where)
  const kind = raw.kind as EntryKind
  if (raw.op === 'delete') {
    if (!ids(raw.evidenceIds, 1)) return reject(where)
    return { op: 'delete', kind, id: raw.id, evidenceIds: raw.evidenceIds }
  }
  const bindable = kind === 'skill' || kind === 'subagent'
  if (
    raw.op !== 'upsert' ||
    !str(raw.title, 256, 1) ||
    typeof raw.content !== 'string' ||
    raw.content.length === 0 ||
    !ids(raw.evidenceIds, 1) ||
    (raw.reference !== undefined && (!bindable || !str(raw.reference, MAX_REFERENCE, 1)))
  )
    return reject(where)
  // Session is the default when the planner states nothing; a value that is neither level is not guessed.
  if (raw.applicability !== undefined && raw.applicability !== 'task' && raw.applicability !== 'session')
    return reject(where)
  const applicability = raw.applicability === 'task' ? 'task' : 'session'
  // A longer text is cut, not refused. Only a prompt or memory lesson can reach user memory; any other
  // reach is ignored.
  const reach =
    (raw.reach === 'workspace' || raw.reach === 'user') &&
    !(raw.reach === 'user' && kind !== 'prompt' && kind !== 'memory')
      ? raw.reach
      : undefined
  return {
    op: 'upsert',
    kind,
    id: raw.id,
    title: raw.title,
    content: cut(raw.content, MAX_EDIT_CHARS),
    applicability,
    evidenceIds: raw.evidenceIds,
    ...(raw.reference === undefined ? {} : { reference: raw.reference as string }),
    ...(reach === undefined ? {} : { reach }),
  }
}

function confirmation(raw: unknown, at: number): PlannerConfirmation {
  if (
    !isObj(raw) ||
    !str(raw.entryId, 160, 3) ||
    !ids(raw.evidenceIds, 1) ||
    (raw.quote !== undefined && !str(raw.quote, 2000, 1))
  )
    return reject(`invalid-shape: confirmations[${at}]`)
  return {
    entryId: raw.entryId,
    evidenceIds: raw.evidenceIds,
    ...(raw.quote === undefined ? {} : { quote: raw.quote as string }),
  }
}

/** The evidence ids a list cites twice, or that the prompt never showed. */
function badEvidence(list: readonly string[], known: ReadonlySet<string>): string | undefined {
  const unknown = list.find((id) => !known.has(id))
  if (unknown !== undefined) return `unknown-evidence: ${unknown}`
  const twice = list.find((id, at) => list.indexOf(id) !== at)
  return twice === undefined ? undefined : `duplicate-evidence: ${twice}`
}

/**
 * Reads the planner's one answer, edit by edit. Text that is not JSON, or JSON that is not an object,
 * rejects the plan. Anything else wrong is dropped where it is and the rest is kept: an edit past the
 * fifth is ignored, a longer content is cut, a field the planner may not set is ignored, and an edit or
 * confirmation that cites an unknown or repeated evidence id, rewrites an entry not shown in full, names
 * an entry twice or has a bad shape is left out alone. The plan is rejected only when it asked for
 * something and nothing valid is left. There is no second attempt to repair it.
 */
export function parsePlannerOutput(text: string, context: ParseContext): PlannerOutput | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(unfence(text))
  } catch {
    return { error: 'invalid-json' }
  }
  if (!isObj(raw)) return { error: 'invalid-shape: output' }
  const known = new Set(context.evidenceIds)
  const ref = (e: EntryRef) => `${e.kind}/${e.id}`
  const full = new Set(context.fullEntries.map(ref))
  const shown = new Set([...context.shownEntries.map(ref), ...(context.workspaceRefs ?? [])])
  const asked = (Array.isArray(raw.edits) ? raw.edits : []).slice(0, MAX_PLAN_EDITS)
  const confirmable = (Array.isArray(raw.confirmations) ? raw.confirmations : []).slice(0, 4 * 40)
  const dropped: string[] = []
  const edits: PlannerEdit[] = []
  const touched = new Set<string>()
  for (const [at, item] of asked.entries()) {
    try {
      const e = edit(item, at)
      const bad = badEvidence(e.evidenceIds, known)
      if (bad) reject(bad)
      const key = ref(e)
      if (touched.has(key)) reject(`duplicate-entry: ${key}`)
      // A rewrite from a summary would drop what the planner never saw, so only full entries change.
      if (!full.has(key) && (e.op === 'delete' || shown.has(key))) reject(`not-shown-in-full: ${key}`)
      touched.add(key)
      edits.push(e)
    } catch (error) {
      if (!(error instanceof Rejected)) throw error
      dropped.push(error.message)
    }
  }
  const confirmations: PlannerConfirmation[] = []
  const confirmed = new Set<string>()
  for (const [at, item] of confirmable.entries()) {
    try {
      const c = confirmation(item, at)
      const bad = badEvidence(c.evidenceIds, known)
      if (bad) reject(bad)
      if (!shown.has(c.entryId)) reject(`unknown-entry: ${c.entryId}`)
      if (confirmed.has(c.entryId)) reject(`duplicate-confirmation: ${c.entryId}`)
      confirmed.add(c.entryId)
      confirmations.push(c)
    } catch (error) {
      if (!(error instanceof Rejected)) throw error
      dropped.push(error.message)
    }
  }
  if (edits.length === 0 && confirmations.length === 0 && dropped.length > 0)
    return { error: dropped[0] as string }
  const cited = Array.isArray(raw.evidenceIds) ? raw.evidenceIds : []
  return {
    summary: clip(raw.summary, 1000),
    rationale: clip(raw.rationale, 4000),
    expectedOutcome: clip(raw.expectedOutcome, 1000),
    edits,
    confirmations,
    evidenceIds: [...new Set(cited.filter((id): id is string => str(id, 64, 1) && known.has(id)))].slice(
      0,
      4 * MAX_IDS,
    ),
  }
}
