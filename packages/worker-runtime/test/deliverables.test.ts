import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { readDeliverablesPage } from '../src/deliverables.js'
import { TOOL_DETAIL_PAGE_BYTES } from '../src/tool-detail.js'

/** A main-lane ledger of one turn with a present call and result per entry of `notes`. */
function ledger(notes: string[], lane = 'main') {
  const rows: EventEnvelope[] = []
  const add = (type: string, data: unknown, rowLane = lane) =>
    rows.push({ seq: rows.length + 1, type, data, lane: rowLane } as unknown as EventEnvelope)
  add('turn/start', { turn: 1, trigger: 'prompt' })
  for (const [index, note] of notes.entries()) {
    add('tool/call', { toolUseId: `p${index}`, name: 'present', args: {}, ordinal: index })
    add('tool/result', { toolUseId: `p${index}`, content: [], structured: { note }, isError: false })
  }
  add('turn/end', { reason: 'completed', lastAssistantSeq: null })
  let rowsRead = 0
  return {
    rows,
    get rowsRead() {
      return rowsRead
    },
    key: 'session-a',
    lane,
    lastSeq: rows.length,
    async scan(q: {
      fromSeq?: number
      toSeq?: number
      type?: string | string[]
      lane?: string
      order?: string
      limit?: number
    }) {
      const types = [q.type ?? []].flat()
      const found = rows.filter(
        (row) =>
          (q.fromSeq === undefined || row.seq >= q.fromSeq) &&
          (q.toSeq === undefined || row.seq <= q.toSeq) &&
          (types.length === 0 || types.includes(row.type)) &&
          (q.lane === undefined || row.lane === q.lane),
      )
      const page = (q.order === 'desc' ? found.reverse() : found).slice(0, q.limit)
      rowsRead += page.length
      return page
    },
  }
}

const item = (index: number, note: string) => ({
  callSeq: 2 * index + 2,
  resultSeq: 2 * index + 3,
  toolUseId: `p${index}`,
  turnId: 'turn:1',
  structured: { note },
})

describe('readDeliverablesPage', () => {
  it('returns every source up to the head when they fit', async () => {
    const session = ledger(['a', 'b'])
    await expect(readDeliverablesPage(session, { afterSeq: 0, limit: 100 })).resolves.toEqual({
      ok: true,
      page: { upto: 6, items: [item(0, 'a'), item(1, 'b')] },
    })
    await expect(readDeliverablesPage(session, { afterSeq: 6, limit: 100 })).resolves.toEqual({
      ok: true,
      page: { upto: 6, items: [] },
    })
  })

  it('reads the session lane and cuts a page at the limit where the next one starts', async () => {
    const session = ledger(['a', 'b', 'c'], 'side')
    const first = await readDeliverablesPage(session, { afterSeq: 0, limit: 2 })
    expect(first).toEqual({
      ok: true,
      page: { upto: 5, items: [item(0, 'a'), item(1, 'b')], nextAfterSeq: 5 },
    })
    await expect(readDeliverablesPage(session, { afterSeq: 5, limit: 2 })).resolves.toEqual({
      ok: true,
      page: { upto: 8, items: [item(2, 'c')] },
    })
  })

  it('cuts a page at the tool-detail byte cap and refuses one source larger than a page', async () => {
    const third = 'x'.repeat(Math.floor(TOOL_DETAIL_PAGE_BYTES / 3))
    const session = ledger([third, third, third])
    const first = await readDeliverablesPage(session, { afterSeq: 0, limit: 100 })
    if (!first.ok) throw new Error(first.reason)
    expect(first.page.items.map((source) => source.toolUseId)).toEqual(['p0', 'p1'])
    expect(first.page.nextAfterSeq).toBe(5)
    expect(Buffer.byteLength(JSON.stringify({ sessionId: session.key, ...first.page }))).toBeLessThanOrEqual(
      TOOL_DETAIL_PAGE_BYTES,
    )
    await expect(
      readDeliverablesPage(ledger(['x'.repeat(TOOL_DETAIL_PAGE_BYTES)]), { afterSeq: 0, limit: 100 }),
    ).resolves.toEqual({ ok: false, reason: 'deliverable-too-large' })
  })

  it('keeps first-page work bounded and cumulative work linear as the ledger grows', async () => {
    let previousTotal = 0
    for (const n of [60, 120]) {
      const session = ledger(Array.from({ length: n }, () => 'small'))
      let afterSeq = 0
      let count = 0
      for (;;) {
        const result = await readDeliverablesPage(session, { afterSeq, limit: 5 })
        if (!result.ok) throw new Error(result.reason)
        count += result.page.items.length
        if (afterSeq === 0) expect(session.rowsRead).toBeLessThanOrEqual(16)
        if (result.page.nextAfterSeq === undefined) break
        expect(result.page.nextAfterSeq).toBe(result.page.upto)
        expect(result.page.upto).toBeGreaterThan(afterSeq)
        afterSeq = result.page.nextAfterSeq
      }
      expect(count).toBe(n)
      expect(session.rowsRead).toBeLessThan(n * 4)
      if (previousTotal > 0) expect(session.rowsRead).toBeLessThanOrEqual(previousTotal * 2 + 4)
      previousTotal = session.rowsRead
    }
  })

  it('uses the page cursor to pick up a replacement appended after an earlier head', async () => {
    const session = ledger(['old'])
    const first = await readDeliverablesPage(session, { afterSeq: 0, limit: 100 })
    if (!first.ok) throw new Error(first.reason)
    const afterSeq = first.page.upto
    const previous = session.rows.find((row) => row.type === 'tool/result')
    if (!previous) throw new Error('result missing')
    session.rows.push({
      ...previous,
      seq: afterSeq + 1,
      data: { toolUseId: 'p0', content: [], structured: { note: 'new' } },
    })
    session.lastSeq++
    await expect(readDeliverablesPage(session, { afterSeq, limit: 100 })).resolves.toMatchObject({
      ok: true,
      page: { upto: session.lastSeq, items: [{ ...item(0, 'new'), resultSeq: afterSeq + 1 }] },
    })
  })

  it('refuses a cut past the ledger head', async () => {
    await expect(readDeliverablesPage(ledger(['a']), { afterSeq: 5, limit: 100 })).resolves.toEqual({
      ok: false,
      reason: 'after-seq-out-of-range',
    })
  })
})
