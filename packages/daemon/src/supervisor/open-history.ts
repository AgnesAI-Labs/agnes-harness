import type { EventEnvelope } from '@agnes/protocol'

/** Rows per ledger page; one scan reply must fit in a worker frame. */
const PAGE = 500

/**
 * A daemon-side consumer of ledger rows. It lists the event types it reacts to, and a session that
 * opens reads exactly those rows from its history, in ledger order, instead of every row the ledger
 * holds. A consumer must ignore any other type, so the list is the complete set of rows it needs.
 */
export type HistoryConsumer = Readonly<{
  types: readonly string[]
  observe(sessionKey: string, event: EventEnvelope, generation: number): void
}>

type Scan = (query: Record<string, unknown>) => Promise<EventEnvelope[]>

/**
 * Reads `fromSeq..toSeq` in ascending pages, handing each row to `each` before the next is read.
 * A type filter may skip seqs freely: the cursor moves past the last row of each page, and a short
 * page ends the read.
 */
export async function readRange(
  scan: Scan,
  range: { fromSeq: number; toSeq: number; types?: readonly string[] },
  each: (event: EventEnvelope) => void | Promise<void>,
): Promise<void> {
  let fromSeq = range.fromSeq
  while (fromSeq <= range.toSeq) {
    const page = await scan({
      fromSeq,
      toSeq: range.toSeq,
      ...(range.types ? { type: range.types } : {}),
      order: 'asc',
      limit: PAGE,
    })
    if (page.length === 0) return
    for (const event of page) await each(event)
    const last = page.at(-1)?.seq
    if (!Number.isSafeInteger(last) || (last as number) < fromSeq)
      throw new Error('session history replay returned an invalid page')
    fromSeq = (last as number) + 1
    if (page.length < PAGE) return
  }
}

/** The types a set of consumers reacts to, and which consumers to hand a row of each type. */
export function historyIndex(
  consumers: readonly HistoryConsumer[],
  extraTypes: readonly string[] = [],
): { types: string[]; byType: ReadonlyMap<string, readonly HistoryConsumer[]> } {
  const byType = new Map<string, HistoryConsumer[]>()
  for (const consumer of consumers)
    for (const type of consumer.types) byType.set(type, [...(byType.get(type) ?? []), consumer])
  return { types: [...new Set([...extraTypes, ...byType.keys()])], byType }
}
