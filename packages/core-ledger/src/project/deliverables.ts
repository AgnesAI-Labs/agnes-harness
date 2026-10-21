import type { Event, Seq } from '@agnes/core-common/types'
import {
  type JsonValue,
  normalize,
  type SessionDeliverableSource,
  type ToolCall,
  type ToolResult,
} from '@agnes/protocol'
import { type ScanRead, scanPages } from '../log/scan-pages.js'
import { SCAN_PAGE_MAX } from '../log/storage.js'
import { TurnProjection, turnAt } from './turns.js'

/** The tool whose results name a session's presented files. */
const PRESENT_TOOL = 'present'
const TOOL_ROWS = ['tool/call', 'tool/result']
const TURN_ROWS = ['turn/start', 'turn/end']

type Call = { seq: Seq; present: boolean }
type Result = { seq: Seq; toolUseId: string; structured?: JsonValue }
type Range = { lane: string; afterSeq: Seq; toSeq: Seq }
type Page = { upto: Seq; items: SessionDeliverableSource[] }
type PageOptions = { limit: number; fits: (items: SessionDeliverableSource[]) => boolean }

/** A summarizing row becomes a compaction node in the projection, never part of a tool node. */
const toolRow = (row: Event): Event | undefined =>
  typeof row.surfaceOp === 'object' ? undefined : normalize(row)

/**
 * The `present` calls whose latest result is in (afterSeq, toSeq], in result order. Calls and results
 * pair as the UI projection pairs tool nodes: a result belongs to the latest call with its toolUseId,
 * and a later result for that call replaces an earlier one. With page options, stop at a result
 * boundary and project only through that cut; a later page can replace a call by callSeq again.
 */
export function projectDeliverableSources(
  read: ScanRead<Event>,
  range: Range,
): Promise<SessionDeliverableSource[]>
export function projectDeliverableSources(
  read: ScanRead<Event>,
  range: Range,
  page: PageOptions,
): Promise<Page>
export async function projectDeliverableSources(
  read: ScanRead<Event>,
  range: Range,
  page?: PageOptions,
): Promise<SessionDeliverableSource[] | Page> {
  const { lane, afterSeq, toSeq } = range
  const limit = page?.limit ?? Infinity
  const pageSize = Math.min(SCAN_PAGE_MAX, limit * 2)
  const calls = new Map<string, Call | undefined>()
  const paired = new Map<Seq, Result>()
  const history: [Seq, Result][] = []
  let resultCount = 0
  let upto = toSeq
  tools: for await (const rows of scanPages(
    read,
    { fromSeq: afterSeq + 1, toSeq, lane, type: TOOL_ROWS },
    pageSize,
  )) {
    // Resolve calls before this range once for the whole batch, including negative lookups.
    const seen = new Set(calls.keys())
    const wanted = new Set<string>()
    for (const row of rows) {
      const event = toolRow(row)
      if (event?.type === 'tool/call') seen.add((event.data as ToolCall).toolUseId)
      else if (event?.type === 'tool/result') {
        const id = (event.data as ToolResult).toolUseId
        if (!seen.has(id)) wanted.add(id)
      }
    }
    if (wanted.size > 0) {
      for (const id of wanted) calls.set(id, undefined)
      const before = { fromSeq: 1, toSeq: afterSeq, lane, type: 'tool/call', order: 'desc' as const }
      if (afterSeq > 0)
        for await (const rows of scanPages(read, before, pageSize)) {
          for (const row of rows) {
            const event = toolRow(row)
            if (event?.type !== 'tool/call') continue
            const data = event.data as ToolCall
            if (wanted.delete(data.toolUseId))
              calls.set(data.toolUseId, { seq: event.seq, present: data.name === PRESENT_TOOL })
          }
          if (wanted.size === 0) break
        }
    }
    for (const row of rows) {
      const event = toolRow(row)
      if (event?.type === 'tool/call') {
        const data = event.data as ToolCall
        calls.set(data.toolUseId, { seq: event.seq, present: data.name === PRESENT_TOOL })
      } else if (event?.type === 'tool/result') {
        const data = event.data as ToolResult
        const owner = calls.get(data.toolUseId)
        if (!owner?.present) continue
        const result = {
          seq: event.seq,
          toolUseId: data.toolUseId,
          ...(data.structured === undefined ? {} : { structured: data.structured }),
        }
        paired.set(owner.seq, result)
        if (page) history.push([owner.seq, result])
        // Count replacements too: repeated results must not turn one page into an unbounded read.
        if (++resultCount === limit) {
          upto = event.seq
          break tools
        }
      }
    }
  }
  // Avoid a continuation when only non-tool tail rows remain. The one-row peek is bounded too.
  if (upto < toSeq) {
    const next = await read({ fromSeq: upto + 1, toSeq, lane, type: TOOL_ROWS, limit: 1 })
    if (next.length === 0) upto = toSeq
  }
  const ordered = () => [...paired].sort(([, a], [, b]) => a.seq - b.seq)
  const floor = [...paired.keys()].reduce((min, seq) => Math.min(min, seq), upto)
  const turns = paired.size > 0 ? await turnRange(read, lane, floor, upto) : []
  let items = attribute(turns, ordered(), upto)
  while (page && !page.fits(items) && history.length > 0) {
    history.pop()
    upto = history.at(-1)?.[1].seq ?? afterSeq
    // Cutting off a replacement restores the preceding result, just as replay at that cut does.
    paired.clear()
    for (const [callSeq, result] of history) paired.set(callSeq, result)
    // A byte cut can also precede a continuation that changed a call's turn ownership.
    items = attribute(turns, ordered(), upto)
  }
  return page ? { upto, items } : items
}

/** Read the containing turn range, following continued physical turns back to their original start. */
async function turnRange(read: ScanRead<Event>, lane: string, floor: Seq, upto: Seq): Promise<Event[]> {
  const rows: Event[] = []
  const wanted = new Set<number>()
  turns: for await (const page of scanPages(
    read,
    { fromSeq: 1, toSeq: upto, lane, type: TURN_ROWS, order: 'desc' },
    64,
  ))
    for (const row of page) {
      const event = normalize(row)
      rows.push(event)
      if (event.type !== 'turn/start') continue
      const data = event.data as { turn: number; trigger: string; continues?: { turn: number } }
      wanted.delete(data.turn)
      if (data.trigger === 'approval-resume' && data.continues) wanted.add(data.continues.turn)
      if (event.seq <= floor && wanted.size === 0) break turns
    }
  return rows.reverse()
}

/** Reuse the range for byte cuts: both turn continuations and result replacement obey the same cut. */
function attribute(rows: Event[], sources: [Seq, Result][], upto: Seq): SessionDeliverableSource[] {
  if (sources.length === 0) return []
  const turns = new TurnProjection()
  for (const row of rows) {
    if (row.seq > upto) break
    turns.apply(row)
  }
  return sources.map(([callSeq, result]) => {
    const turnId = turnAt(turns.turns, callSeq)
    return {
      callSeq,
      resultSeq: result.seq,
      toolUseId: result.toolUseId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(result.structured === undefined ? {} : { structured: result.structured }),
    }
  })
}
