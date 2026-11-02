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
      quote?: string
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
}

const KINDS = new Set<string>(['prompt', 'memory', 'skill', 'subagent'])
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_IDS = 20

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max
const keysWithin = (o: Obj, allowed: readonly string[]) => Object.keys(o).every((k) => allowed.includes(k))
const ids = (v: unknown, min: number): v is string[] =>
  Array.isArray(v) && v.length >= min && v.length <= MAX_IDS && v.every((id) => str(id, 64, 1))

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

function edit(raw: unknown, at: number): PlannerEdit {
  const where = `invalid-shape: edits[${at}]`
  if (!isObj(raw) || !str(raw.kind, 16) || !KINDS.has(raw.kind) || !str(raw.id, 128) || !ID.test(raw.id))
    return reject(where)
  const kind = raw.kind as EntryKind
  if (raw.op === 'delete') {
    if (!keysWithin(raw, ['op', 'kind', 'id', 'evidenceIds']) || !ids(raw.evidenceIds, 1))
      return reject(where)
    return { op: 'delete', kind, id: raw.id, evidenceIds: raw.evidenceIds }
  }
  const allowed = ['op', 'kind', 'id', 'title', 'content', 'applicability', 'evidenceIds', 'quote']
  if (
    raw.op !== 'upsert' ||
    !keysWithin(raw, allowed) ||
    !str(raw.title, 256, 1) ||
    typeof raw.content !== 'string' ||
    (raw.applicability !== 'task' && raw.applicability !== 'session') ||
    !ids(raw.evidenceIds, 1) ||
    (raw.quote !== undefined && !str(raw.quote, 2000, 1))
  )
    return reject(where)
  if (raw.content.length === 0 || raw.content.length > MAX_EDIT_CHARS) return reject(`edit-too-long: ${at}`)
  return {
    op: 'upsert',
    kind,
    id: raw.id,
    title: raw.title,
    content: raw.content,
    applicability: raw.applicability,
    evidenceIds: raw.evidenceIds,
    ...(raw.quote === undefined ? {} : { quote: raw.quote as string }),
  }
}

function confirmation(raw: unknown, at: number): PlannerConfirmation {
  if (
    !isObj(raw) ||
    !keysWithin(raw, ['entryId', 'evidenceIds', 'quote']) ||
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

/** Every rule that needs the prompt: known evidence, entries shown, one edit or confirmation per entry. */
function checkAgainst(out: PlannerOutput, context: ParseContext): void {
  const known = new Set(context.evidenceIds)
  const cited = [
    ...out.evidenceIds,
    ...out.edits.flatMap((e) => e.evidenceIds),
    ...out.confirmations.flatMap((c) => c.evidenceIds),
  ]
  const unknown = cited.find((id) => !known.has(id))
  if (unknown !== undefined) reject(`unknown-evidence: ${unknown}`)
  for (const list of [
    out.evidenceIds,
    ...out.edits.map((e) => e.evidenceIds),
    ...out.confirmations.map((c) => c.evidenceIds),
  ]) {
    const twice = list.find((id, at) => list.indexOf(id) !== at)
    if (twice !== undefined) reject(`duplicate-evidence: ${twice}`)
  }
  const ref = (e: EntryRef) => `${e.kind}/${e.id}`
  const full = new Set(context.fullEntries.map(ref))
  const shown = new Set(context.shownEntries.map(ref))
  const touched = new Set<string>()
  for (const e of out.edits) {
    const key = ref(e)
    if (touched.has(key)) reject(`duplicate-entry: ${key}`)
    touched.add(key)
    // A rewrite from a summary would drop what the planner never saw, so only full entries change.
    if (!full.has(key) && (e.op === 'delete' || shown.has(key))) reject(`not-shown-in-full: ${key}`)
  }
  const confirmed = new Set<string>()
  for (const c of out.confirmations) {
    if (!shown.has(c.entryId)) reject(`unknown-entry: ${c.entryId}`)
    if (confirmed.has(c.entryId)) reject(`duplicate-confirmation: ${c.entryId}`)
    confirmed.add(c.entryId)
  }
}

/**
 * Reads the planner's one answer. Anything wrong (not JSON, a field the planner may not set, more
 * than 5 edits, an edit over 2,000 characters, an unknown evidence id, a rewrite of an entry not
 * shown in full) rejects the whole plan with a reason. There is no second attempt to repair it.
 */
export function parsePlannerOutput(text: string, context: ParseContext): PlannerOutput | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(unfence(text))
  } catch {
    return { error: 'invalid-json' }
  }
  try {
    const allowed = ['summary', 'rationale', 'expectedOutcome', 'edits', 'confirmations', 'evidenceIds']
    if (
      !isObj(raw) ||
      !keysWithin(raw, allowed) ||
      !str(raw.summary, 1000) ||
      !str(raw.rationale, 4000) ||
      !str(raw.expectedOutcome, 1000) ||
      !Array.isArray(raw.edits) ||
      !Array.isArray(raw.confirmations) ||
      raw.confirmations.length > 4 * 40 ||
      !Array.isArray(raw.evidenceIds) ||
      raw.evidenceIds.length > 4 * MAX_IDS ||
      !raw.evidenceIds.every((id) => str(id, 64, 1))
    )
      return reject('invalid-shape: output')
    if (raw.edits.length > MAX_PLAN_EDITS) return reject('too-many-edits')
    const out: PlannerOutput = {
      summary: raw.summary,
      rationale: raw.rationale,
      expectedOutcome: raw.expectedOutcome,
      edits: raw.edits.map(edit),
      confirmations: raw.confirmations.map(confirmation),
      evidenceIds: raw.evidenceIds as string[],
    }
    checkAgainst(out, context)
    return out
  } catch (error) {
    if (error instanceof Rejected) return { error: error.message }
    throw error
  }
}
