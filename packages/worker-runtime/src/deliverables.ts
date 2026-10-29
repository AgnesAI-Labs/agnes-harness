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
  // Reserve the envelope at the head, whose seq fields are at least as wide as any page cut.
  const envelope = encodedBytes({ sessionId: session.key, upto: head, items: [], nextAfterSeq: head })
  const { upto, items } = await projectDeliverableSources(
    (q) => session.scan(q),
    { lane: session.lane, afterSeq: input.afterSeq, toSeq: head },
    {
      limit: input.limit,
      fits: (items) => envelope + encodedBytes(items) - 2 <= TOOL_DETAIL_PAGE_BYTES,
    },
  )
  if (upto === head) return { ok: true, page: { upto, items } }
  if (items.length === 0) return { ok: false, reason: 'deliverable-too-large' }
  return { ok: true, page: { upto, items, nextAfterSeq: upto } }
}
