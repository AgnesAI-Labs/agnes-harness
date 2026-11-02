import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { Event, Seq } from '@agnes/core-common/types'
import { scanAll } from '@agnes/core-ledger/log/scan-pages'
import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { RefinementReadSet } from '@agnes/core-ledger/reduce/state'
import type { SessionImpl } from '../step/session.js'
import { redactArgs, redactClipped } from './redact.js'
import type { EvidenceItem, EvidenceSnapshot, EvidenceTaskScope, RefinementTrigger } from './types.js'

/** Facts one snapshot keeps at most; past it the oldest go, but never the task's first request. */
export const MAX_EVIDENCE_ITEMS = 120
const MAX_CHARS = { user: 4000, tool: 2000, summary: 4000, args: 500 } as const
/** Ended turns an idle request looks back through for one with a user request in it. */
const LOOKBACK_TURNS = 20

const EVIDENCE_TYPES = ['user/message', 'assistant/message', 'tool/call', 'tool/result']
const ENTRY_KINDS = new Set(['prompt', 'memory', 'skill', 'subagent'])

/** Redacted and clipped within a bounded window; see `redactClipped`. */
const shown = (text: string, max: number) => redactClipped(text, max)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The text of a content array; anything that is not text is named, never inlined. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block: { type?: unknown; text?: unknown } | null) =>
      block?.type === 'text' && typeof block.text === 'string'
        ? block.text
        : `[${String(block?.type ?? 'part')}]`,
    )
    .join('\n')
}

function argsOf(args: unknown): string {
  try {
    // Strings are redacted one by one before they are serialised, then the whole once more, so a
    // `"token":"…"` pair spelled across the keys and values is caught too.
    return shown(JSON.stringify(redactArgs(args, MAX_CHARS.args)) ?? '', MAX_CHARS.args)
  } catch {
    return ''
  }
}

const isRequest = (row: Event) =>
  row.type === 'user/message' && (row.data as { kind?: unknown } | null)?.kind !== 'runtime_context'

/**
 * The settled facts in `rows`, in ledger order, numbered `e1`, `e2`, ...: user requests (not the
 * runtime notes Core adds), tool results with the call they answer, and compaction summaries. A
 * call with no result yet is not a fact, and neither is the model's own running text. Every text is
 * redacted of credentials and harness framing. Tool output and summaries are untrusted data whatever
 * wrote the row: a builtin tool reading a file does not make the file's words trusted.
 */
export function evidenceItemsOf(rows: readonly Event[]): EvidenceItem[] {
  const calls = new Map<string, { name: string; args: unknown }>()
  const items: Omit<EvidenceItem, 'id'>[] = []
  for (const row of rows) {
    const d = row.data as Record<string, unknown> | null
    if (!d) continue
    const at = { lane: row.lane ?? 'main', seq: row.seq }
    if (row.type === 'tool/call' && typeof d.toolUseId === 'string')
      calls.set(d.toolUseId, { name: String(d.name), args: d.args })
    else if (isRequest(row))
      // External content (a fetched page, a referenced file) is written as an untrusted user row;
      // it is shown as `external`, never as the user's own request.
      items.push({
        ...at,
        ...(row.trust === 'untrusted'
          ? { kind: 'external' as const, trust: 'untrusted' as const }
          : { kind: 'user' as const, trust: 'trusted' as const }),
        text: shown(textOf(d.content), MAX_CHARS.user),
      })
    else if (row.type === 'tool/result') {
      const call = typeof d.toolUseId === 'string' ? calls.get(d.toolUseId) : undefined
      if (!call) continue
      items.push({
        ...at,
        kind: 'tool',
        trust: 'untrusted',
        tool: call.name,
        args: argsOf(call.args),
        isError: d.isError === true,
        ...(typeof d.code === 'string' ? { code: d.code } : {}),
        text: shown(textOf(d.content), MAX_CHARS.tool),
      })
    } else if (
      row.type === 'assistant/message' &&
      typeof row.surfaceOp === 'object' &&
      row.surfaceOp.op === 'replace'
    )
      items.push({
        ...at,
        kind: 'summary',
        trust: 'untrusted',
        text: shown(textOf(d.content), MAX_CHARS.summary),
      })
  }
  return items.map((item, index) => ({ id: `e${index + 1}`, ...item }))
}

/**
 * Every saved entry with the seq of the row that last wrote its cell. A delete removes the cell and
 * a re-create writes a new seq, so an entry that is gone, or gone and back, never matches.
 */
export function readSetOf(s: SessionImpl, settingsRevision: string): RefinementReadSet {
  const entries: RefinementReadSet['entries'] = []
  for (const cell of s.state.registers.harnessEntries.values()) {
    const e = cell.value as Partial<HarnessEntry> | null
    if (!e || !ENTRY_KINDS.has(String(e.kind)) || typeof e.id !== 'string') continue
    entries.push({
      kind: e.kind as HarnessEntry['kind'],
      id: e.id,
      seq: cell.seq,
      version: typeof e.version === 'number' ? e.version : 0,
    })
  }
  entries.sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id))
  return { settingsRevision, entries }
}

/**
 * Whether what a plan was built on still holds: the same entries, each last written by the same row,
 * and, when given, the same settings revision. Anything else invalidates the whole plan.
 */
export function readSetCurrent(
  s: SessionImpl,
  readSet: RefinementReadSet,
  settingsRevision?: string,
): boolean {
  if (settingsRevision !== undefined && settingsRevision !== readSet.settingsRevision) return false
  return canonicalJson(readSetOf(s, readSet.settingsRevision).entries) === canonicalJson(readSet.entries)
}

type Task = { turn: number; fromSeq: Seq; startSeq: Seq; endSeq?: Seq }

const one = async (s: SessionImpl, type: string, q: { before?: Seq; after?: Seq }) =>
  (
    await s.scan({
      type,
      lane: s.lane,
      ...(q.before === undefined
        ? { fromSeq: (q.after ?? 0) + 1, toSeq: s.lastSeq, order: 'asc' as const }
        : { toSeq: q.before - 1, order: 'desc' as const }),
      limit: 1,
    })
  )[0]

/**
 * The turn that starts after `prevEnd` (or the session start). Its task begins right after the
 * previous turn's end, so the request accepted in the same commit as `turn/start`, which comes
 * just before it, belongs to it.
 */
async function turnAfter(s: SessionImpl, prevEnd: Seq): Promise<Task | undefined> {
  const start = await one(s, 'turn/start', { after: prevEnd })
  if (!start) return undefined
  const end = await one(s, 'turn/end', { after: start.seq - 1 })
  const request = await one(s, 'user/message', { after: prevEnd })
  return {
    turn: Number((start.data as { turn?: unknown } | null)?.turn ?? 0),
    fromSeq: request && request.seq < start.seq ? request.seq : start.seq,
    startSeq: start.seq,
    ...(end ? { endSeq: end.seq } : {}),
  }
}

/** The task's rows up to its end, or up to now while it runs; the bound is fixed before reading. */
async function rowsOf(s: SessionImpl, task: Task) {
  const boundary = task.endSeq ?? s.lastSeq
  const rows = await scanAll((q) => s.scan(q), {
    type: EVIDENCE_TYPES,
    lane: s.lane,
    fromSeq: task.fromSeq,
    toSeq: boundary,
  })
  return { task, boundary, rows }
}

/**
 * The task a trigger belongs to and its rows: the turn the trigger fell in (its accepted request
 * included), running or ended; else, for a trigger between turns, the latest ended turn before it
 * that has a user request, which is what an idle manual request learns from. No such turn, no task.
 */
async function taskOf(s: SessionImpl, trigger: RefinementTrigger) {
  const at = Math.min(Math.max(trigger.seq, 0), s.lastSeq)
  let prev = (await one(s, 'turn/end', { before: at }))?.seq ?? 0
  const current = await turnAfter(s, prev)
  if (current && current.fromSeq <= at) return rowsOf(s, current)
  for (let looked = 0; looked < LOOKBACK_TURNS && prev > 0; looked++) {
    const before = (await one(s, 'turn/end', { before: prev }))?.seq ?? 0
    const task = await turnAfter(s, before)
    if (!task) break
    const found = await rowsOf(s, task)
    if (found.rows.some(isRequest)) return found
    prev = before
  }
  return undefined
}

/** Keeps the task's first request and the newest facts, within the snapshot bound. */
function bounded(items: EvidenceItem[]): { kept: EvidenceItem[]; omitted: number } {
  if (items.length <= MAX_EVIDENCE_ITEMS) return { kept: items, omitted: 0 }
  const first = items.find((item) => item.kind === 'user')
  const tail = items.slice(items.length - (MAX_EVIDENCE_ITEMS - (first ? 1 : 0)))
  const kept = first && !tail.includes(first) ? [first, ...tail] : tail
  return { kept, omitted: items.length - kept.length }
}

/**
 * Freezes what one run may learn from: the settled facts of the triggering task up to now (to the
 * turn's end once it has ended), each under an id of this snapshot fixed to its lane and seq, and
 * the read set the plan must still match when it is applied. Nothing written after the boundary,
 * on another lane or in another task is evidence.
 */
export async function freezeEvidence(
  s: SessionImpl,
  trigger: RefinementTrigger,
  opts: { settingsRevision: string },
): Promise<EvidenceSnapshot> {
  const found = await taskOf(s, trigger)
  // Read after the last await, so the entries the planner is then shown are the ones it records.
  const readSet = readSetOf(s, opts.settingsRevision)
  const turn = found?.task
  const taskScope: EvidenceTaskScope = {
    kind: 'turn',
    turn: turn?.turn ?? 0,
    startSeq: turn?.fromSeq ?? 0,
    ...(turn?.endSeq === undefined ? {} : { endSeq: turn.endSeq }),
  }
  const { kept, omitted } = bounded(found ? evidenceItemsOf(found.rows) : [])
  const items = kept.map((item, index) => ({ ...item, id: `e${index + 1}` }))
  return {
    trigger,
    taskScope,
    taskEnded: turn?.endSeq !== undefined,
    boundarySeq: found?.boundary ?? s.lastSeq,
    items,
    omitted,
    evidenceHash: sha256Hex(canonicalJson({ taskScope, items })),
    readSet,
  }
}
