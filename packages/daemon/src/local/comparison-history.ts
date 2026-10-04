import { type CoreUITimeline, projectUI } from '@agnes/core'
import type { EventEnvelope } from '@agnes/protocol'
import { readToolDetailPage, TOOL_DETAIL_PAGE_BYTES, type ToolDetailRead } from '@agnes/worker-runtime'

/** Reads immutable session coordinates from either a live ledger or a retained archive. */
export interface ComparisonHistoryLedger {
  head(sessionId: string): Promise<number>
  scan(
    sessionId: string,
    query: { fromSeq: number; toSeq: number; limit: number; order: 'asc' },
  ): Promise<readonly EventEnvelope[]>
}
export type ComparisonHistoryCut = { sessionId: string; throughSeq: number }
export type ComparisonHistoryPage = ComparisonHistoryCut & {
  afterSeq: number
  events: EventEnvelope[]
  nextAfterSeq: number
  complete: boolean
}
export class ComparisonHistoryError extends Error {
  constructor(readonly code: 'HISTORY_INVALID_ARGUMENT' | 'HISTORY_INCOMPLETE' | 'HISTORY_LIMIT') {
    super(code)
    this.name = 'ComparisonHistoryError'
  }
}
const fail = (code: ComparisonHistoryError['code']): never => {
  throw new ComparisonHistoryError(code)
}
const integer = (value: number, minimum = 0) => Number.isSafeInteger(value) && value >= minimum
const bytes = (event: EventEnvelope) => Buffer.byteLength(JSON.stringify(event), 'utf8')

/** Authentication and comparison membership are the caller's responsibility; no session is opened. */
export function createComparisonHistoryReader(
  ledger: ComparisonHistoryLedger,
  limits: { maxEvents?: number; maxBytes?: number } = {},
) {
  const maxEvents = limits.maxEvents ?? 100_000
  const maxBytes = limits.maxBytes ?? 16 * 1024 * 1024
  if (!integer(maxEvents, 1) || !integer(maxBytes, 1)) fail('HISTORY_INVALID_ARGUMENT')

  async function validate(cut: ComparisonHistoryCut) {
    if (!cut.sessionId || !integer(cut.throughSeq)) fail('HISTORY_INVALID_ARGUMENT')
    const head = await ledger.head(cut.sessionId)
    if (!integer(head) || head < cut.throughSeq) fail('HISTORY_INCOMPLETE')
  }
  async function scan(cut: ComparisonHistoryCut, fromSeq: number, toSeq: number, limit: number) {
    const rows = await ledger.scan(cut.sessionId, { fromSeq, toSeq, limit, order: 'asc' })
    if (!rows.length || rows.length > limit) fail('HISTORY_INCOMPLETE')
    for (const [index, row] of rows.entries()) {
      if (row.seq !== fromSeq + index || row.seq > toSeq || row.seq > cut.throughSeq)
        fail('HISTORY_INCOMPLETE')
    }
    return rows
  }

  return {
    /** A complete page need not be a complete prefix; only complete=true reaches the fixed cut. */
    async events(
      input: ComparisonHistoryCut & { afterSeq: number; limit?: number; maxBytes?: number },
    ): Promise<ComparisonHistoryPage> {
      const limit = input.limit ?? 128
      const pageBytes = input.maxBytes ?? Math.min(maxBytes, 2 * 1024 * 1024)
      if (
        !integer(input.afterSeq) ||
        input.afterSeq > input.throughSeq ||
        !integer(limit, 1) ||
        limit > 1000 ||
        !integer(pageBytes, 1) ||
        pageBytes > maxBytes
      )
        fail('HISTORY_INVALID_ARGUMENT')
      await validate(input)
      const events: EventEnvelope[] = []
      let size = 0
      if (input.afterSeq < input.throughSeq) {
        const rows = await scan(input, input.afterSeq + 1, input.throughSeq, limit)
        for (const row of rows) {
          const addition = bytes(row)
          if (addition > pageBytes && !events.length) fail('HISTORY_LIMIT')
          if (size + addition > pageBytes) break
          events.push(row)
          size += addition
        }
      }
      const nextAfterSeq = events.at(-1)?.seq ?? input.afterSeq
      return {
        sessionId: input.sessionId,
        throughSeq: input.throughSeq,
        afterSeq: input.afterSeq,
        events,
        nextAfterSeq,
        complete: nextAfterSeq === input.throughSeq,
      }
    },

    async projectUI(input: ComparisonHistoryCut): Promise<CoreUITimeline> {
      await validate(input)
      if (input.throughSeq > maxEvents) fail('HISTORY_LIMIT')
      const events: EventEnvelope[] = []
      let size = 0
      for (let fromSeq = 1; fromSeq <= input.throughSeq; ) {
        const rows = await scan(
          input,
          fromSeq,
          input.throughSeq,
          Math.min(128, input.throughSeq - fromSeq + 1),
        )
        for (const row of rows) {
          size += bytes(row)
          if (size > maxBytes) fail('HISTORY_LIMIT')
          events.push(row)
          fromSeq++
        }
      }
      // Live op state, provider settings and extension hooks do not belong to a stored cut.
      return projectUI(events, { sessionKey: input.sessionId, upto: input.throughSeq, surface: 'web' })
    },

    async readToolDetail(input: ComparisonHistoryCut & ToolDetailRead) {
      if (
        !integer(input.callSeq, 1) ||
        input.callSeq > input.throughSeq ||
        (input.resultSeq !== undefined &&
          (!integer(input.resultSeq, input.callSeq + 1) || input.resultSeq > input.throughSeq)) ||
        !integer(input.offset) ||
        !integer(input.maxBytes, 1) ||
        input.maxBytes > TOOL_DETAIL_PAGE_BYTES
      )
        fail('HISTORY_INVALID_ARGUMENT')
      await validate(input)
      // A separate bounded reader prevents cached bytes from bypassing cut validation or crossing sessions.
      return readToolDetailPage(
        {
          scan: (query) => scan(input, query.fromSeq, query.toSeq, query.limit),
        },
        input,
      )
    },
  }
}
