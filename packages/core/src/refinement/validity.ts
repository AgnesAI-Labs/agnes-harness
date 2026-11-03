import { sha256Hex } from '@agnes/core-common/request/hash'
import type { Event, Seq } from '@agnes/core-common/types'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type {
  LedgerState,
  RefinementEntryMeta,
  RefinementPlan,
  RefinementPlanEdit,
} from '@agnes/core-ledger/reduce/state'
import { entryKey } from '../refine/apply.js'
import type { SessionImpl } from '../step/session.js'
import { evidenceItemsOf } from './evidence.js'
import { readTaskScope, sameTask, type TaskScope } from './task-scope.js'

/**
 * Validity levels of refinement entries.
 *
 * A lesson is valid either for the task it was learned in (`task`: the current goal) or for the rest
 * of the session (`session`). The host cannot tell whether evidence really supports a lesson, only
 * what shape it has, so the level is the one the plan asked for:
 *
 * - session level is granted to every edit that asked for it and cites at least one request of the
 *   user's own or one settled tool result (`hasGroundedEvidence`): page or file text recorded as an
 *   untrusted row, the model's own words and summaries alone never back it, and such an edit is task
 *   level. The plan has already been checked to cite evidence items that exist in the snapshot;
 * - task level needs a goal: with none, the lesson is recorded on the plan as expired and never
 *   applied.
 *
 * A task-level entry expires, as derived state with nothing written, when its goal is completed,
 * cleared or replaced. A session-level entry does not expire; it ends only when it is changed,
 * removed or withdrawn, or the session ends.
 */

/** The shortest quote that can grant session level. */
export const MIN_QUOTE_CHARS = 12

/** One cited row as the level and reach checks read it. */
export type EvidenceFact =
  | { kind: 'user'; seq: Seq; text: string }
  | { kind: 'tool'; seq: Seq; tool: string; target?: string; isError: boolean }

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const chars = (text: string) => [...text].length

/**
 * What a tool call acted on, for telling two calls of one tool apart: the program a command runs, or
 * the path it was given. Undefined when the call names neither, which never pairs.
 */
export function targetOf(args: unknown): string | undefined {
  if (!isObj(args)) return undefined
  if (typeof args.command === 'string') {
    const program = args.command.trim().split(/\s+/, 1)[0] ?? ''
    const name = program.split(/[\\/]/).at(-1) ?? ''
    return name ? `command:${name}` : undefined
  }
  if (typeof args.path === 'string') {
    const path = args.path.trim().replace(/[\\/]+$/u, '')
    return path ? `path:${path}` : undefined
  }
  return undefined
}

async function rowAt(s: SessionImpl, seq: Seq): Promise<Event | undefined> {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > s.lastSeq) return undefined
  return (await s.scan({ fromSeq: seq, toSeq: seq }))[0]
}

/**
 * The cited rows the level and confirmation checks read: the user's own requests with the text the
 * planner was shown, and settled tool results with their tool, target and outcome. A cited seq that
 * is neither is left out.
 */
export async function readFacts(s: SessionImpl, seqs: Iterable<Seq>): Promise<Map<Seq, EvidenceFact>> {
  const facts = new Map<Seq, EvidenceFact>()
  for (const seq of new Set(seqs)) {
    const row = await rowAt(s, seq)
    if (!row) continue
    if (row.type === 'user/message') {
      // Read exactly as the evidence snapshot renders it, so the quote is checked against what the
      // planner saw: redacted, clipped, and only the user's own requests.
      const item = evidenceItemsOf([row])[0]
      if (item?.kind === 'user') facts.set(seq, { kind: 'user', seq, text: item.text })
      continue
    }
    if (row.type !== 'tool/result') continue
    const d = row.data as Record<string, unknown> | null
    const call = typeof d?.toolUseId === 'string' ? s.state.toolCalls.get(d.toolUseId) : undefined
    if (!call) continue
    const callRow = await rowAt(s, call.seq)
    const target = targetOf((callRow?.data as Record<string, unknown> | null)?.args)
    facts.set(seq, {
      kind: 'tool',
      seq,
      tool: call.name,
      ...(target === undefined ? {} : { target }),
      isError: d?.isError === true,
    })
  }
  return facts
}

/**
 * Whether any of `seqs` is a row the facts hold: a request of the user's own or a settled tool result.
 * Page or file text (`external`), the model's own words and summaries are not facts.
 */
export const hasGroundedEvidence = (facts: ReadonlyMap<Seq, EvidenceFact>, seqs: readonly Seq[]): boolean =>
  seqs.some((seq) => facts.has(seq))

/** The user request among `seqs` (newer than `after`) that holds `quote` verbatim, if any. */
export function quotedRequest(
  facts: ReadonlyMap<Seq, EvidenceFact>,
  quote: string | undefined,
  seqs: readonly Seq[] | undefined,
  after = 0,
): Seq | undefined {
  if (quote === undefined || chars(quote.trim()) < MIN_QUOTE_CHARS) return undefined
  for (const seq of seqs ?? []) {
    const fact = facts.get(seq)
    if (fact?.kind === 'user' && seq > after && fact.text.includes(quote)) return seq
  }
  return undefined
}

/**
 * The success of a failed-then-successful pair among `seqs`: two settled results of the same tool on
 * the same target, the failure first. The newest such success (newer than `after`) is returned.
 */
export function recoveredResult(
  facts: ReadonlyMap<Seq, EvidenceFact>,
  seqs: readonly Seq[],
  after = 0,
): Seq | undefined {
  const tools = [...new Set(seqs)]
    .map((seq) => facts.get(seq))
    .filter((f): f is Extract<EvidenceFact, { kind: 'tool' }> => f?.kind === 'tool' && f.target !== undefined)
    .sort((a, b) => a.seq - b.seq)
  let found: Seq | undefined
  for (const success of tools) {
    if (success.isError || success.seq <= after) continue
    const failed = tools.some(
      (f) => f.isError && f.seq < success.seq && f.tool === success.tool && f.target === success.target,
    )
    if (failed) found = success.seq
  }
  return found
}

/** Evidence that counts once, by its identity, and the seq it stands at. */
export type Confirmation = { identity: string; seq: Seq }

/**
 * What makes a plan's confirmation of an entry count: evidence newer than the row that set the
 * entry, of one of two shapes: a verbatim quote of a cited request of the user's own (at least
 * `MIN_QUOTE_CHARS` characters; its identity is the request's seq), or a failed-then-successful pair
 * (its identity is the success's seq). Undefined when the cited evidence has neither.
 */
export function confirmationOf(
  facts: ReadonlyMap<Seq, EvidenceFact>,
  c: { evidenceSeqs: readonly Seq[]; quote?: string; quoteSeqs?: readonly Seq[] },
  entrySeq: Seq,
): Confirmation | undefined {
  const quoted = quotedRequest(facts, c.quote, c.quoteSeqs, entrySeq)
  if (quoted !== undefined) return { identity: `user:${quoted}`, seq: quoted }
  const recovered = recoveredResult(facts, c.evidenceSeqs, entrySeq)
  if (recovered !== undefined) return { identity: `tool:${recovered}`, seq: recovered }
  return undefined
}

type Upsert = Extract<RefinementPlanEdit, { op: 'upsert' }>

/**
 * Grants each upsert of a settled plan the level it asked for, binds task-level edits to the current
 * goal (or marks them expired when there is none), and finds what makes each confirmation count. Returns the
 * plan as it is proposed, or a no-op when nothing on it can be applied.
 */
export async function grantLevels(
  s: SessionImpl,
  plan: RefinementPlan,
): Promise<['proposed' | 'no-op', { plan: RefinementPlan; reason?: string; detail?: string }]> {
  const cited = [
    ...plan.edits.flatMap((e) => e.evidenceSeqs),
    ...plan.confirmations.flatMap((c) => c.evidenceSeqs),
  ]
  const facts = await readFacts(s, cited)
  // A goal that cannot be read binds nothing: a task-level lesson then has no task to belong to.
  const { scope } = await readTaskScope(s)
  const edits = plan.edits.map((edit) => (edit.op === 'upsert' ? granted(edit, facts, scope) : edit))
  const confirmations = plan.confirmations.map((c) => {
    const key = entryKey(c)
    const entrySeq = s.state.registers.harnessEntries.get(key)?.seq ?? Number.MAX_SAFE_INTEGER
    const confirmedBy = confirmationOf(facts, c, entrySeq)
    // Evidence this content version has already spent counts nothing: the run has nothing to apply.
    const spent = boundMeta(s.state, key)?.confirmations.usedEvidence ?? []
    return confirmedBy && !spent.includes(confirmedBy.identity) ? { ...c, confirmedBy } : c
  })
  const next: RefinementPlan = { ...plan, edits, confirmations }
  if (confirmations.every((c) => !c.confirmedBy) && edits.every(isExpired))
    return edits.length === 0
      ? ['no-op', { plan: next }]
      : ['no-op', { plan: next, reason: 'expired', detail: 'task-level-without-goal' }]
  return ['proposed', { plan: next }]
}

function granted(edit: Upsert, facts: ReadonlyMap<Seq, EvidenceFact>, scope: TaskScope | null): Upsert {
  const { applicability: asked, expired: _e, taskScope: _t, usedEvidence: _u, ...rest } = edit
  if (asked === 'session' && hasGroundedEvidence(facts, edit.evidenceSeqs)) {
    // The requests of the user's own that the edit cites are recorded: they back a lesson that holds in
    // every workspace (`reach`), and they never count as a later confirmation of it.
    const requests = edit.evidenceSeqs.filter((seq) => facts.get(seq)?.kind === 'user')
    return { ...rest, applicability: 'session', usedEvidence: requests.map((seq) => `user:${seq}`) }
  }
  // No goal, no task: the lesson would expire with a task it never had.
  if (!scope) return { ...rest, applicability: 'task', expired: true }
  return { ...rest, applicability: 'task', taskScope: { id: scope.id, revision: scope.revision } }
}

/** An edit kept on the plan only as a record: it is never applied. */
export const isExpired = (edit: RefinementPlanEdit): boolean => edit.op === 'upsert' && edit.expired === true

/** The metadata bound to the entry's current cell, if any: written for the row that set that cell. */
export function boundMeta(state: LedgerState, key: string): RefinementEntryMeta | undefined {
  const meta = state.refinementEntryMeta.get(key)
  const cell = state.registers.harnessEntries.get(key)
  return meta && cell && meta.entrySeq === cell.seq ? meta : undefined
}

/** One entry with the seq of the row that set it and the metadata bound to it. */
export type EntryView = { entry: HarnessEntry; seq: Seq; meta?: RefinementEntryMeta }

/** The session's entries by validity: in force, expired, or not known while the task cannot be read. */
export type Validity = { valid: EntryView[]; expired: EntryView[]; held: EntryView[] }

/**
 * The session's entries split by validity now. `valid` are in force; `expired` are task-level entries
 * whose goal has ended (or, in a child session, any task-level entry: a child never activates one);
 * `held` are task-level entries while the task cannot be read (`readable` false): neither delivered
 * nor announced, they are decided at the next read. An entry handed off elsewhere is in none. An
 * entry with no metadata (written before metadata existed, or rewritten by a rollback) is read as
 * session level.
 */
export function entryValidity(state: LedgerState, scope: TaskScope | null, readable = true): Validity {
  const out: Validity = { valid: [], expired: [], held: [] }
  for (const [key, cell] of state.registers.harnessEntries) {
    const meta = boundMeta(state, key)
    const view: EntryView = { entry: cell.value, seq: cell.seq, ...(meta ? { meta } : {}) }
    if (meta?.handedOff) continue
    if (meta?.applicability !== 'task' || sameTask(meta.taskScope, scope)) out.valid.push(view)
    else if (readable) out.expired.push(view)
    else out.held.push(view)
  }
  return out
}

/** The `kind/id` of every entry handed off to the workspace: kept, but no longer the session's to give. */
export function handedOffRefs(state: LedgerState): Set<string> {
  const refs = new Set<string>()
  for (const [key, cell] of state.registers.harnessEntries)
    if (boundMeta(state, key)?.handedOff) refs.add(`${cell.value.kind}/${cell.value.id}`)
  return refs
}

/** The entries of this session by validity now, read with the current task. */
export async function validEntries(s: SessionImpl): Promise<Validity> {
  const { scope, readable } = await readTaskScope(s)
  return entryValidity(s.state, scope, readable)
}

/** Keys of entries that exist but are not in force (expired): their ids may be written afresh. */
export const lapsedKeys = (v: Validity): Set<string> => new Set(v.expired.map((view) => entryKey(view.entry)))

/** The content version confirmations count against: the hash of the entry's content. */
export const contentHash = (content: string): string => sha256Hex(content)
