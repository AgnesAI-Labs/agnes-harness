import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import { sessionIdentity } from '../loop/scope.js'
import { entryKey } from '../refine/apply.js'
import type { EffectiveEntry } from '../request/experience.js'
import { rankEntries, terms } from '../request/rank-entries.js'
import type { SessionImpl } from '../step/session.js'

type Kind = HarnessEntry['kind']

/** How much one read returns: search hits, a list page, summary characters and one entry's full text. */
export const INSPECT_LIMITS = Object.freeze({ search: 10, page: 20, summaryChars: 140, fullChars: 2000 })

/** What the model asks of this session's entries, as the tool received it. */
export type InspectRequest = {
  op: 'search' | 'list' | 'get'
  query?: string
  kind?: Kind
  cursor?: string
  id?: string
}
/** One entry as a search or list shows it: its reference and a short summary. */
export type InspectSummary = { kind: Kind; id: string; version: number; summary: string }
/** One entry read in full; `truncated` says the content was cut to the size limit. */
export type InspectEntry = {
  kind: Kind
  id: string
  version: number
  title: string
  content: string
  truncated: boolean
  /** Bound to an approved skill or role that cannot be used now; the text is still returned. */
  unavailable?: true
}
export type InspectAnswer =
  | { op: 'search'; entries: InspectSummary[]; matched: number }
  | { op: 'list'; kind: Kind; entries: InspectSummary[]; total: number; nextCursor?: string }
  | { op: 'get'; entry: InspectEntry }
export type InspectProblem = { problem: 'invalid' | 'not-found'; detail: string }

const KINDS: readonly Kind[] = ['prompt', 'memory', 'skill', 'subagent']
const MAX_QUERY = 512
const MAX_ID = 128
/** Entries one session remembers having read in full; the oldest read is forgotten first. */
const MAX_READS = 256
/** Bytes of a get answer that are not the entry's title or content: reference, notes, wording. */
const GET_FRAMING_BYTES = 512

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
function clip(text: string, max: number): { text: string; cut: boolean } {
  const chars = [...text]
  return chars.length <= max
    ? { text, cut: false }
    : { text: `${chars.slice(0, max - 1).join('')}…`, cut: true }
}
const cut = (text: string, max: number) => [...text].slice(0, max).join('')
const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8')
/** The longest prefix of `text`, whole code points only, that fits `bytes` of UTF-8. */
function cutBytes(text: string, bytes: number): string {
  let used = 0
  let out = ''
  for (const ch of text) {
    used += utf8Bytes(ch)
    if (used > bytes) break
    out += ch
  }
  return out
}

/**
 * The entries in force in this session, as the validity split gives them: a cell of a known kind with
 * a string id, title and content and a numeric version. A malformed or legacy cell is not shown rather
 * than thrown on.
 */
function entriesInForce(valid: readonly EffectiveEntry[]): EffectiveEntry[] {
  const out: EffectiveEntry[] = []
  for (const cell of valid) {
    const e = cell.entry as Partial<Record<keyof HarnessEntry, unknown>> | null
    if (
      e &&
      typeof e === 'object' &&
      KINDS.includes(e.kind as Kind) &&
      typeof e.id === 'string' &&
      typeof e.title === 'string' &&
      typeof e.content === 'string' &&
      typeof e.version === 'number'
    )
      out.push({ entry: e as HarnessEntry, seq: cell.seq })
  }
  return out
}

const summaryOf = ({ entry: e }: EffectiveEntry): InspectSummary => ({
  kind: e.kind,
  id: e.id,
  version: e.version,
  summary: clip(`${e.title}: ${e.content}`.replace(/\s+/g, ' ').trim(), INSPECT_LIMITS.summaryChars).text,
})

/** What a full read saw: the entry's version and the seq of the row that set its cell. */
type Read = { version: number; seq: number }
/** Entries read in full by this session in this process, with what was read; never persisted. */
const reads = new WeakMap<object, Map<string, Read>>()

function remember(s: SessionImpl, key: string, read: Read): void {
  const owner = sessionIdentity(s)
  const seen = reads.get(owner) ?? new Map<string, Read>()
  reads.set(owner, seen)
  seen.delete(key)
  seen.set(key, read)
  if (seen.size > MAX_READS) seen.delete(seen.keys().next().value as string)
}

/**
 * Whether this session's last full read of an entry with `get`, in this process, saw the entry's
 * current cell: the same version set by the same row, so a read of an entry since removed and written
 * again at the same version does not count. A direct proposal may change a saved entry only from such
 * a read: a summary or a cut read would let it overwrite text it never saw. A restart forgets every
 * read.
 */
export function readInFull(s: SessionImpl, key: string, version: number, seq: number): boolean {
  const read = reads.get(sessionIdentity(s))?.get(key)
  return read !== undefined && read.version === version && read.seq === seq
}

/** Whether this session read a saved entry (`ws.` or `user.`, never a cell of its own) in full here. */
export function readSavedInFull(s: SessionImpl, key: string): boolean {
  return reads.get(sessionIdentity(s))?.has(key) === true
}

const isKind = (v: unknown): v is Kind => KINDS.includes(v as Kind)
const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max

function search(entries: EffectiveEntry[], r: InspectRequest): InspectAnswer | InspectProblem {
  if (!isText(r.query, MAX_QUERY)) return { problem: 'invalid', detail: 'query' }
  if (r.kind !== undefined && !isKind(r.kind)) return { problem: 'invalid', detail: 'kind' }
  const query = r.query.trim()
  const wanted = terms(query)
  const hits = entries.filter(({ entry: e }) => {
    if (r.kind !== undefined && e.kind !== r.kind) return false
    if (e.id === query || `${e.kind}/${e.id}` === query) return true
    const have = terms(`${e.id} ${e.title} ${e.content}`)
    for (const term of wanted) if (have.has(term)) return true
    return false
  })
  // An exact id is what the model asked for: it leads, whatever the term scores of the rest.
  const exact = (e: HarnessEntry) => e.id === query || `${e.kind}/${e.id}` === query
  const ranked = [
    ...hits.filter((item) => exact(item.entry)),
    ...rankEntries(
      hits.filter((item) => !exact(item.entry)),
      query,
    ),
  ]
  return {
    op: 'search',
    entries: ranked.slice(0, INSPECT_LIMITS.search).map(summaryOf),
    matched: hits.length,
  }
}

function list(entries: EffectiveEntry[], r: InspectRequest): InspectAnswer | InspectProblem {
  if (!isKind(r.kind)) return { problem: 'invalid', detail: 'kind' }
  if (r.cursor !== undefined && !isText(r.cursor, MAX_ID)) return { problem: 'invalid', detail: 'cursor' }
  const kind = r.kind
  const ofKind = entries.filter((item) => item.entry.kind === kind)
  ofKind.sort((a, b) => compare(a.entry.id, b.entry.id))
  // The cursor is the last id of the previous page: stable while entries are added or changed.
  const after = r.cursor
  const rest = after === undefined ? ofKind : ofKind.filter((item) => compare(item.entry.id, after) > 0)
  const page = rest.slice(0, INSPECT_LIMITS.page)
  const last = page.at(-1)
  return {
    op: 'list',
    kind,
    entries: page.map(summaryOf),
    total: ofKind.length,
    ...(rest.length > page.length && last ? { nextCursor: last.entry.id } : {}),
  }
}

/**
 * One entry, its content cut to 2,000 characters and then, if the answer would still not reach the
 * model whole, to what the session's tool output limit lets through. Only an answer carrying the
 * whole text is a full read. A tool-result hook that rewrites the output afterwards is not seen here.
 */
function get(s: SessionImpl, entries: EffectiveEntry[], r: InspectRequest): InspectAnswer | InspectProblem {
  if (!isText(r.id, MAX_ID + 16)) return { problem: 'invalid', detail: 'id' }
  if (r.kind !== undefined && !isKind(r.kind)) return { problem: 'invalid', detail: 'kind' }
  // The snapshot names an entry as `kind/id`; either form is accepted.
  const slash = r.id.indexOf('/')
  const named = slash > 0 && isKind(r.id.slice(0, slash))
  const kind = named ? (r.id.slice(0, slash) as Kind) : r.kind
  const id = named ? r.id.slice(slash + 1) : r.id
  if (named && r.kind !== undefined && r.kind !== kind) return { problem: 'invalid', detail: 'kind' }
  const found = entries.filter(
    (item) => item.entry.id === id && (kind === undefined || item.entry.kind === kind),
  )
  if (found.length === 0) return { problem: 'not-found', detail: kind ? `${kind}/${id}` : id }
  if (found.length > 1)
    return { problem: 'invalid', detail: `id ${id} names entries of several kinds; give kind` }
  const { entry: e, seq } = found[0] as EffectiveEntry
  const title = cut(e.title, 256)
  let content = cut(e.content, INSPECT_LIMITS.fullChars)
  // The model sees the result only after it is bounded to the output limit; past it, the tail is
  // cut here, cleanly and said so, rather than after this read was taken as whole.
  const room = Math.max(0, s.preset.tools.outputMaxBytes - GET_FRAMING_BYTES - utf8Bytes(title))
  if (utf8Bytes(content) > room) content = cutBytes(content, room)
  const truncated = content !== e.content
  // Only a read of the whole text lets a later direct proposal change the entry.
  if (!truncated) remember(s, entryKey(e), { version: e.version, seq })
  return { op: 'get', entry: { kind: e.kind, id: e.id, version: e.version, title, content, truncated } }
}

/**
 * A read-only query of this session's entries in force (`valid`: a task-level entry whose goal ended,
 * or whose goal cannot be read now, is not among them): search by words (at most 10 summaries),
 * list one kind by id in pages of 20 with a cursor, or get one entry's text (at most 2,000
 * characters). It reads only this session's own register, so no other session's entries can be
 * returned, and it writes nothing to the ledger. A full `get` is remembered in this process as the
 * read a direct proposal may change the entry from.
 */
export function inspectEntries(
  s: SessionImpl,
  valid: readonly EffectiveEntry[],
  r: InspectRequest,
): InspectAnswer | InspectProblem {
  const entries = entriesInForce(valid)
  if (r?.op === 'search') return search(entries, r)
  if (r?.op === 'list') return list(entries, r)
  if (r?.op === 'get') return get(s, entries, r)
  return { problem: 'invalid', detail: 'op' }
}
