import { projectDeliverableSources, type ScanRead } from '@agnes/host'
import type { EventEnvelope, SessionDeliverableSource } from '@agnes/protocol'
import { TOOL_DETAIL_PAGE_BYTES } from './tool-detail.js'

export const DELIVERABLES_DEFAULT_LIMIT = 100

export type DeliverablesRead = { afterSeq: number; limit: number }
export type DeliverablesPage = { upto: number; items: SessionDeliverableSource[]; nextAfterSeq?: number }
export type DeliverablesReadResult =
  | { ok: true; page: DeliverablesPage }
  | { ok: false; reason: 'after-seq-out-of-range' | 'deliverable-too-large' }

type LedgerReader = {
  readonly key: string
  readonly lane: string
  readonly lastSeq: number
  scan: ScanRead<EventEnvelope>
}

const encodedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')

/**
 * One page of `present` sources whose result is after `afterSeq`, read at the head inside the process
 * that holds the ledger. A page holds at most `limit` items and one tool-detail page of JSON; a cut
 * page ends at its last item's result, which is where the next page starts.
 */
export async function readDeliverablesPage(
  session: LedgerReader,
  input: DeliverablesRead,
): Promise<DeliverablesReadResult> {
  const head = session.lastSeq
  if (input.afterSeq > head) return { ok: false, reason: 'after-seq-out-of-range' }
  const sources = await projectDeliverableSources((q) => session.scan(q), {
    lane: session.lane,
    afterSeq: input.afterSeq,
    toSeq: head,
  })
  let bytes = encodedBytes({ sessionId: session.key, upto: head, items: [], nextAfterSeq: head })
  const items: SessionDeliverableSource[] = []
  for (const source of sources) {
    const size = encodedBytes(source) + (items.length > 0 ? 1 : 0)
    if (items.length === input.limit || bytes + size > TOOL_DETAIL_PAGE_BYTES) break
    bytes += size
    items.push(source)
  }
  const last = items.at(-1)
  if (items.length === sources.length) return { ok: true, page: { upto: head, items } }
  if (!last) return { ok: false, reason: 'deliverable-too-large' }
  return { ok: true, page: { upto: last.resultSeq, items, nextAfterSeq: last.resultSeq } }
}
