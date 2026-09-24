import { describe, expect, it } from 'vitest'
import type { ScanQuery } from '../src/log/storage.js'
import { mediaLedgerForHeader } from '../src/step/inference.js'
import type { Event } from '../src/types.js'

type Row = Pick<Event, 'seq' | 'type' | 'lane'> & { sourceEventSeqs?: number[] }

/**
 * The two selected screenshots come from calls 1,202 rows apart with 1,200 other calls between them,
 * read through a log that stops every scan at 500 rows the way the SQLite adapter does.
 */
function ledger() {
  const rows: Row[] = [{ seq: 1, type: 'tool/call', lane: 'main' }]
  for (let seq = 2; seq <= 1_201; seq++) rows.push({ seq, type: 'tool/call', lane: 'main' })
  rows.push({ seq: 1_202, type: 'tool/call', lane: 'main' })
  rows.push({ seq: 1_203, type: 'tool/result', lane: 'main', sourceEventSeqs: [1] })
  rows.push({ seq: 1_204, type: 'tool/result', lane: 'main', sourceEventSeqs: [1_202] })
  const queries: ScanQuery[] = []
  const scan = async (q: ScanQuery) => {
    queries.push(q)
    const types = q.type === undefined ? undefined : new Set(Array.isArray(q.type) ? q.type : [q.type])
    let out = rows.filter(
      (r) =>
        (q.fromSeq === undefined || r.seq >= q.fromSeq) &&
        (q.toSeq === undefined || r.seq <= q.toSeq) &&
        (!types || types.has(r.type)) &&
        (q.lane === undefined || r.lane === q.lane),
    )
    if (q.order === 'desc') out = out.reverse()
    return out.slice(0, Math.min(q.limit ?? 500, 500)) as unknown as Event[]
  }
  const session = { lane: 'main', d: { log: { scan } } }
  return { session: session as never, rows, scan, queries }
}

describe('request media ledger reads', () => {
  it('a restored header finds the source call of every selected result, however far apart', async () => {
    const { session, scan, queries } = ledger()
    // One read of the source-call range stops at 500 rows and never reaches the call at 1,202.
    const once = await scan({ fromSeq: 1, toSeq: 1_202, type: 'tool/call', lane: 'main' })
    expect(once).toHaveLength(500)
    expect(once.some((e) => e.seq === 1_202)).toBe(false)
    queries.length = 0
    const header = {
      selectionOrder: [0, 1],
      manifest: [{ nodeSeq: 1_203 }, { nodeSeq: 1_204 }],
    }
    const events = await mediaLedgerForHeader(session, header as never)
    expect(events.map((e) => e.seq)).toEqual([1, 1_202, 1_203, 1_204])
    // The call range is read in pages, each resuming past the last row of the one before.
    expect(queries.filter((q) => q.type === 'tool/call').map((q) => q.fromSeq)).toEqual([1, 501, 1_001])
  })
})
