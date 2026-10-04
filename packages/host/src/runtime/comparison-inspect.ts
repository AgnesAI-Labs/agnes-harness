import type { ScanRead } from '@agnes/core'
import type { EventEnvelope, InboxItem, JsonValue } from '@agnes/protocol'
import type { SessionObservation, SessionPort } from '@agnes/runtime-comparison'
import { ComparisonCancellationEvidence } from './comparison-cancellation.js'

type Inspection = Awaited<ReturnType<SessionPort['inspect']>>
type ObjectValue = { [key: string]: JsonValue }
const object = (value: JsonValue | undefined): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}
const unknown = (): Inspection => ({ receipt: { status: 'unknown' } })
function items(row: EventEnvelope): InboxItem[] | undefined {
  const data = object(row.data)
  if (!data || !Array.isArray(data.items)) return undefined
  if (
    !data.items.every((value) => {
      const item = object(value)
      return (
        item &&
        typeof item.itemId === 'string' &&
        typeof item.target === 'string' &&
        ['next-turn', 'next-step'].includes(item.target) &&
        Array.isArray(item.content) &&
        object(item.actor)
      )
    })
  )
    return undefined
  return data.items as unknown as InboxItem[]
}
function endState(reason: JsonValue | undefined, lastSeq: number): SessionObservation | undefined {
  if (reason === 'blocked' || reason === 'parked' || reason === 'interrupted')
    return {
      phase: reason === 'blocked' ? 'waiting' : reason === 'parked' ? 'parked' : 'recovering',
      lastSeq,
      settled: false,
    }
  if (
    reason === 'completed' ||
    reason === 'aborted' ||
    reason === 'budget' ||
    reason === 'max_steps' ||
    reason === 'error'
  )
    return {
      phase: reason === 'error' ? 'failed' : 'idle',
      lastSeq,
      settled: true,
      terminalCause: reason === 'completed' ? 'finished' : reason === 'aborted' ? 'cancelled' : 'failed',
    }
  return undefined
}

/**
 * Read committed comparison evidence without acquiring a writer, opening or resuming a session.
 * `scan` must already be authorized and bound to sessionId. A session/start identity cross-check,
 * contiguous unfiltered pages and a frozen upper bound keep partial/foreign streams unknown.
 * The shared Native/Jev claim layout is inbox-removal -> user/message -> turn/start. Matching
 * text alone is never sufficient: the unique command/item identity and exact queue delta own it.
 */
export async function inspectComparisonInput(input: {
  sessionId: string
  inputId: string
  throughSeq: number
  scan: ScanRead<EventEnvelope>
  maxEvents?: number
  /** Include the proven input-owned execution window for fixed-cut result readers. */
  includeExecution?: boolean
  maxBytes?: number
}): Promise<Inspection & { execution?: { startSeq: number; endSeq: number | null; answerSeq?: number } }> {
  const throughSeq = input.throughSeq
  const maxEvents = input.maxEvents ?? 100_000
  const maxBytes = input.maxBytes ?? 16 * 1024 * 1024
  if (
    !input.sessionId ||
    !input.inputId ||
    !Number.isSafeInteger(throughSeq) ||
    throughSeq < 0 ||
    !Number.isSafeInteger(maxEvents) ||
    maxEvents < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    throughSeq > maxEvents
  )
    return unknown()
  const cancellation = new ComparisonCancellationEvidence(input.sessionId, input.inputId)
  let cursor = 1
  let bytes = 0
  let sessionVerified = false
  let admitted: { seq: number; lane: string | undefined; item: InboxItem } | undefined
  const queues = new Map<string | undefined, InboxItem[]>()
  let candidate: { seq: number; stage: 'message' | 'start' } | undefined
  let selectedTurn: number | undefined
  let openSelectedTurn = false
  const selectedTurns = new Set<number>()
  let state: SessionObservation | undefined
  let ambiguous = false
  let execution: { startSeq: number; endSeq: number | null; answerSeq?: number } | undefined
  try {
    while (cursor <= throughSeq) {
      const limit = Math.min(128, throughSeq - cursor + 1)
      const page = await input.scan({ fromSeq: cursor, toSeq: throughSeq, order: 'asc', limit })
      if (page.length === 0 || page.length > limit) return unknown()
      for (const row of page) {
        if (row.seq !== cursor || row.seq > throughSeq) return unknown()
        cursor++
        bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength
        if (bytes > maxBytes) return unknown()
        const data = object(row.data)
        cancellation.consume(row)
        if (row.seq === 1) {
          if (row.type !== 'session/start' || data?.key !== input.sessionId || data.parent !== undefined)
            return unknown()
          sessionVerified = true
        } else if (row.type === 'session/start') return unknown()

        // Consume only the exact next two rows from a verified single-item queue claim.
        if (candidate !== undefined && admitted !== undefined) {
          if (candidate.stage === 'message') {
            if (
              row.seq === candidate.seq + 1 &&
              row.type === 'user/message' &&
              row.lane === admitted.lane &&
              stable(data?.content) === stable(admitted.item.content) &&
              stable(row.actor) === stable(admitted.item.actor) &&
              data?.kind === (admitted.item.kind ?? 'prompt')
            )
              candidate.stage = 'start'
            else candidate = undefined
          } else {
            if (
              row.seq === candidate.seq + 2 &&
              row.type === 'turn/start' &&
              row.lane === admitted.lane &&
              typeof data?.turn === 'number' &&
              Number.isSafeInteger(data.turn) &&
              data.turn > 0 &&
              data.trigger === (admitted.item.kind ?? 'prompt')
            ) {
              if (selectedTurn !== undefined) ambiguous = true
              selectedTurn = data.turn
              execution = { startSeq: row.seq, endSeq: null }
              selectedTurns.add(data.turn)
              openSelectedTurn = true
              state = { phase: 'recovering', lastSeq: throughSeq, settled: false }
            }
            candidate = undefined
            // This row is the owned opening, not an intervening unrelated opening.
            if (selectedTurn === data?.turn && row.type === 'turn/start') continue
          }
        }
        if (row.type === 'inbox') {
          const current = items(row)
          if (current === undefined) return unknown()
          const matching = current.filter((item) => item.commandId === input.inputId)
          if (matching.length > 1) return unknown()
          const item = matching[0]
          if (item !== undefined) {
            if (
              item.target !== 'next-turn' ||
              typeof item.admissionId !== 'string' ||
              !/^[a-f0-9]{64}$/.test(item.admissionId)
            )
              return unknown()
            if (admitted === undefined)
              admitted = { seq: row.seq, lane: row.lane, item: structuredClone(item) }
            else if (row.lane !== admitted.lane || stable(item) !== stable(admitted.item)) return unknown()
          }
          const previous = queues.get(row.lane)
          const admission = admitted
          if (
            admission &&
            admission.lane === row.lane &&
            previous?.some((item) => item.itemId === admission.item.itemId) &&
            !current.some((item) => item.itemId === admission.item.itemId)
          ) {
            const first = previous.find((item) => item.target === 'next-turn')
            if (
              first?.itemId === admission.item.itemId &&
              stable(current) === stable(previous.filter((item) => item.itemId !== admission.item.itemId))
            )
              candidate = { seq: row.seq, stage: 'message' }
          }
          queues.set(row.lane, current)
        } else if (admitted && row.lane === admitted.lane && selectedTurn !== undefined) {
          if (row.type === 'turn/start') {
            const continuation = object(data?.continues)
            if (
              !openSelectedTurn &&
              state?.settled === false &&
              typeof continuation?.turn === 'number' &&
              selectedTurns.has(continuation.turn) &&
              typeof data?.turn === 'number'
            ) {
              selectedTurns.add(data.turn)
              if (execution) execution.endSeq = null
              selectedTurn = data.turn
              openSelectedTurn = true
              state = { phase: 'recovering', lastSeq: throughSeq, settled: false }
            } else if (openSelectedTurn) {
              ambiguous = true
              openSelectedTurn = false
              state = undefined
            }
          } else if (row.type === 'assistant/message' && openSelectedTurn && execution) {
            execution.answerSeq = row.seq
          } else if (row.type === 'turn/end' && openSelectedTurn) {
            if (execution) execution.endSeq = row.seq
            openSelectedTurn = false
            state = endState(data?.reason, throughSeq)
          }
        }
      }
      if (page.length < limit && cursor <= throughSeq) return unknown()
    }
  } catch {
    return unknown()
  }
  if (!sessionVerified) return unknown()
  const acknowledged =
    !ambiguous &&
    cancellation.acknowledged({
      pending: [...queues.values()].some((queue) => queue.some((item) => item.commandId === input.inputId)),
      open: openSelectedTurn,
      settled: state?.settled,
      item: admitted?.item,
    })
  if (admitted === undefined)
    return { ...unknown(), ...(acknowledged ? { cancellation: 'acknowledged' as const } : {}) }
  if (acknowledged && !state?.settled)
    state = { phase: 'idle', lastSeq: throughSeq, settled: true, terminalCause: 'cancelled' }
  return {
    ...(acknowledged ? { cancellation: 'acknowledged' as const } : {}),
    receipt: { status: 'accepted', seq: admitted.seq },
    ...(!ambiguous && state !== undefined
      ? { state, ...(input.includeExecution && execution ? { execution } : {}) }
      : {}),
  }
}
