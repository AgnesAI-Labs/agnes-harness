import { expect, it } from 'vitest'
import type { ScanQuery } from '../src/log/storage.js'
import { loadAuxiliaryVisionPreflight } from '../src/orchestrator/request-media-preflight.js'

// The preflight read refuses a turn with more than 1,000 preflight rows. It asked for 1,001 in one
// scan, and an adapter that stops every scan at 500 rows meant the refusal could never fire.
it('refuses a turn with 1,001 preflight rows through an adapter that pages at 500', async () => {
  const rows = Array.from({ length: 1_001 }, (_, i) => ({
    seq: i + 1,
    type: 'x/core/auxiliary-vision-preflight',
    lane: 'main',
    data: {},
  }))
  const scans: ScanQuery[] = []
  const scan = async (q: ScanQuery) => {
    scans.push(q)
    return rows
      .filter(
        (r) => (q.fromSeq === undefined || r.seq >= q.fromSeq) && (q.toSeq === undefined || r.seq <= q.toSeq),
      )
      .slice(0, Math.min(q.limit ?? 500, 500))
  }
  const session = { lane: 'main', lastSeq: 1_001, key: 'k', d: { log: { scan } } }
  const binding = { triggerSeq: 1, turn: 1, step: 1 }
  await expect(loadAuxiliaryVisionPreflight(session as never, binding as never)).rejects.toThrow(
    'auxiliary media preflight scan exceeds its bound',
  )
  // Three pages reach the 1,001st row; nothing past it is asked for.
  expect(scans.map((q) => q.fromSeq ?? 1)).toEqual([1, 501, 1001])
})
