import { CoreError, type Seq } from '../types.js'
import { SCAN_PAGE_MAX, type ScanQuery } from './storage.js'

export type ScanRead<E extends { seq: number }> = (q: ScanQuery) => Promise<E[]>

/**
 * Reads a range one bounded page at a time. The cursor moves past the last row of each page, so a
 * type or lane filter may skip seqs freely. A short or empty page, or a cursor past the far bound,
 * ends the read; a page that does not move past the previous one is a storage fault, not a loop.
 */
export function scanPages<E extends { seq: number }>(
  read: ScanRead<E>,
  q: Omit<ScanQuery, 'limit'>,
  pageSize: number = SCAN_PAGE_MAX,
): AsyncGenerator<E[]> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > SCAN_PAGE_MAX)
    throw new RangeError(`scan page size must be an integer in 1..${SCAN_PAGE_MAX}, got ${pageSize}`)
  return pages(read, q, pageSize)
}

async function* pages<E extends { seq: number }>(
  read: ScanRead<E>,
  q: Omit<ScanQuery, 'limit'>,
  pageSize: number,
): AsyncGenerator<E[]> {
  const desc = q.order === 'desc'
  const floor = Math.max(1, q.fromSeq ?? 1)
  let cursor = desc ? q.toSeq : q.fromSeq
  for (;;) {
    const query: ScanQuery = { ...q, limit: pageSize }
    if (cursor !== undefined) query[desc ? 'toSeq' : 'fromSeq'] = cursor
    const page = await read(query)
    if (page.length === 0) return
    const first = (page[0] as E).seq
    const last = (page[page.length - 1] as E).seq
    if (cursor !== undefined && (desc ? Math.max(first, last) > cursor : Math.min(first, last) < cursor))
      throw new CoreError('E_STORAGE_FAULT', 'scan page did not move past the previous page', {
        cursor,
        firstSeq: first,
      })
    yield page
    if (page.length < pageSize) return
    cursor = desc ? last - 1 : last + 1
    if (desc ? cursor < floor : q.toSeq !== undefined && cursor > q.toSeq) return
  }
}

/** Every row in a range. The upper bound is required, so a read cannot grow while it runs. */
export async function scanAll<E extends { seq: number }>(
  read: ScanRead<E>,
  q: Omit<ScanQuery, 'limit'> & { toSeq: Seq },
): Promise<E[]> {
  const rows: E[] = []
  for await (const page of scanPages(read, q)) rows.push(...page)
  return rows
}
