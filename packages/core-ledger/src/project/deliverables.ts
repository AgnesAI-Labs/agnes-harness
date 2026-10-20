import type { Event, Seq } from '@agnes/core-common/types'
import {
  type JsonValue,
  normalize,
  type SessionDeliverableSource,
  type ToolCall,
  type ToolResult,
} from '@agnes/protocol'
import { type ScanRead, scanPages } from '../log/scan-pages.js'
import { TurnProjection, turnAt } from './turns.js'

/** The tool whose results name a session's presented files. */
const PRESENT_TOOL = 'present'
const TOOL_ROWS = ['tool/call', 'tool/result']
const TURN_ROWS = ['turn/start', 'turn/end']

type Call = { seq: Seq; present: boolean }
type Result = { seq: Seq; toolUseId: string; structured?: JsonValue }

/** A summarizing row becomes a compaction node in the projection, never part of a tool node. */
const toolRow = (row: Event): Event | undefined =>
  typeof row.surfaceOp === 'object' ? undefined : normalize(row)

const call = (row: Event): ToolCall | undefined => {
  const event = toolRow(row)
  return event?.type === 'tool/call' ? (event.data as ToolCall) : undefined
}

/**
 * The `present` calls whose latest result is in (afterSeq, toSeq], in result order. Calls and results
 * pair as the UI projection pairs tool nodes: a result belongs to the latest call with its toolUseId,
 * and a later result for that call replaces an earlier one. A call's turn is looked up in the
 * projection's own turn list. Only tool and turn rows of `lane` are read, and turn rows only when
 * there is something to file.
 */
export async function projectDeliverableSources(
  read: ScanRead<Event>,
  range: { lane: string; afterSeq: Seq; toSeq: Seq },
): Promise<SessionDeliverableSource[]> {
  const { lane, afterSeq, toSeq } = range
  const calls = new Map<string, Call>()
  const paired = new Map<Seq, Result>()
  // Results whose call precedes the range, in ledger order; their calls are looked up below.
  const earlier: Result[] = []
  for await (const page of scanPages(read, { fromSeq: afterSeq + 1, toSeq, lane, type: TOOL_ROWS }))
    for (const row of page) {
      const event = toolRow(row)
      if (event?.type === 'tool/call') {
        const data = event.data as ToolCall
        calls.set(data.toolUseId, { seq: event.seq, present: data.name === PRESENT_TOOL })
      } else if (event?.type === 'tool/result') {
        const data = event.data as ToolResult
        const result = {
          seq: event.seq,
          toolUseId: data.toolUseId,
          ...(data.structured === undefined ? {} : { structured: data.structured }),
        }
        const owner = calls.get(result.toolUseId)
        if (!owner) earlier.push(result)
        else if (owner.present) paired.set(owner.seq, result)
      }
    }
  if (earlier.length > 0 && afterSeq > 0) {
    const wanted = new Set(earlier.map((result) => result.toolUseId))
    const owners = new Map<string, Call>()
    const before = { fromSeq: 1, toSeq: afterSeq, lane, type: 'tool/call', order: 'desc' as const }
    for await (const page of scanPages(read, before)) {
      for (const row of page) {
        const data = call(row)
        // Newest first: the first call met for an id is the one its results belong to.
        if (data && wanted.delete(data.toolUseId))
          owners.set(data.toolUseId, { seq: row.seq, present: data.name === PRESENT_TOOL })
      }
      if (wanted.size === 0) break
    }
    for (const result of earlier) {
      const owner = owners.get(result.toolUseId)
      if (owner?.present) paired.set(owner.seq, result)
    }
  }
  if (paired.size === 0) return []
  const turns = new TurnProjection()
  for await (const page of scanPages(read, { fromSeq: 1, toSeq, lane, type: TURN_ROWS }))
    for (const row of page) turns.apply(normalize(row))
  return [...paired]
    .sort(([, a], [, b]) => a.seq - b.seq)
    .map(([callSeq, result]) => {
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
