import type { PreparedEvent, ScanQuery, StorageAdapter } from '@agnes/core'
import { expect, it } from 'vitest'

type Ev = (type: string, data: unknown, over?: Partial<PreparedEvent>) => PreparedEvent

/**
 * The paging contract every StorageAdapter owes the callers that page through it: a scan returns at
 * most 500 rows, a limit at or under that is a page, and a scan that asks for everything (no limit,
 * or one above the page) either gets everything or fails loudly. It never quietly returns fewer.
 */
export function scanPageContract(name: string, open: () => StorageAdapter, ev: Ev): void {
  async function ledger(rows: number, typeOf: (i: number) => string = () => 'user/message') {
    const s = open()
    await s.open('k', { writerRunId: 'r1', ttlMs: 60_000 })
    const events = Array.from({ length: rows }, (_, i) => ev(typeOf(i), { i }))
    for (let i = 0; i < events.length; i += 250)
      await s.commit('k', { events: events.slice(i, i + 250), expectedWriterRunId: 'r1' })
    return s
  }
  const seqs = async (s: StorageAdapter, q: ScanQuery) => (await s.scan('k', q)).map((e) => e.seq)
  const range = (from: number, to: number) =>
    from <= to
      ? Array.from({ length: to - from + 1 }, (_, i) => from + i)
      : Array.from({ length: from - to + 1 }, (_, i) => from - i)

  it(`${name}: a scan matching 501 rows with no limit fails, and says where`, async () => {
    const s = await ledger(501)
    try {
      for (const order of ['asc', 'desc'] as const) {
        const err = await s.scan('k', { toSeq: 501, order }).catch((e: unknown) => e)
        expect(err).toMatchObject({
          code: 'E_SCAN_TRUNCATED',
          detail: { pageMax: 500, requested: 'all', fromSeq: 'start', toSeq: 501, order },
        })
        expect((err as Error).message).toBe(
          `E_SCAN_TRUNCATED: scan matched more than 500 rows (pageMax=500 requested=all fromSeq=start toSeq=501 order=${order})`,
        )
      }
    } finally {
      await s.close()
    }
  })

  it(`${name}: exactly 500 matching rows come back whole, in both directions`, async () => {
    const s = await ledger(500)
    try {
      expect(await seqs(s, { toSeq: 500 })).toEqual(range(1, 500))
      expect(await seqs(s, { toSeq: 500, order: 'desc' })).toEqual(range(500, 1))
    } finally {
      await s.close()
    }
  })

  it(`${name}: a limit above the page is a request for everything, not for one page`, async () => {
    const small = await ledger(3)
    try {
      expect(await seqs(small, { fromSeq: 1, limit: 10_000 })).toEqual([1, 2, 3])
      expect(await seqs(small, { fromSeq: 1, limit: 10_000, order: 'desc' })).toEqual([3, 2, 1])
    } finally {
      await small.close()
    }
    const large = await ledger(501)
    try {
      for (const order of ['asc', 'desc'] as const)
        await expect(large.scan('k', { fromSeq: 1, limit: 10_000, order })).rejects.toMatchObject({
          code: 'E_SCAN_TRUNCATED',
          detail: { requested: 10_000, fromSeq: 1, toSeq: 'end', order },
        })
    } finally {
      await large.close()
    }
  })

  it(`${name}: a limit at or under the page is a page`, async () => {
    const s = await ledger(501)
    try {
      expect(await seqs(s, { fromSeq: 1, limit: 200 })).toEqual(range(1, 200))
      expect(await seqs(s, { toSeq: 501, limit: 200, order: 'desc' })).toEqual(range(501, 302))
      expect(await seqs(s, { fromSeq: 2, limit: 500 })).toEqual(range(2, 501))
    } finally {
      await s.close()
    }
  })

  it(`${name}: a parent prefix counts toward the rows a child scan matched`, async () => {
    const s = await ledger(400)
    try {
      await s.createChild('k', 400, 'c')
      await s.open('c', { writerRunId: 'r2', ttlMs: 60_000 })
      const own = Array.from({ length: 200 }, (_, i) => ev('assistant/output', { i }))
      await s.commit('c', { events: own, expectedWriterRunId: 'r2' })
      await expect(s.scan('c', { toSeq: 600 })).rejects.toMatchObject({ code: 'E_SCAN_TRUNCATED' })
      await expect(s.scan('c', { toSeq: 600, order: 'desc' })).rejects.toMatchObject({
        code: 'E_SCAN_TRUNCATED',
      })
      expect((await s.scan('c', { toSeq: 600, limit: 500 })).map((e) => e.seq)).toEqual(range(1, 500))
      expect((await s.scan('c', { toSeq: 600, type: 'assistant/output' })).map((e) => e.seq)).toEqual(
        range(401, 600),
      )
    } finally {
      await s.close()
    }
  })

  it(`${name}: only the rows a filter matches count, not the rows it passed over`, async () => {
    const s = await ledger(900, (i) => (i % 3 === 0 ? 'tool/call' : 'assistant/output'))
    try {
      expect(await seqs(s, { toSeq: 900, type: 'tool/call' })).toHaveLength(300)
      expect(await seqs(s, { toSeq: 900, lane: 'side' })).toEqual([])
    } finally {
      await s.close()
    }
  })

  it(`${name}: a limit that is not a positive whole number is refused, not read as "no limit"`, async () => {
    const s = await ledger(3)
    try {
      for (const limit of [0, -1, 1.5, Number.NaN])
        await expect(s.scan('k', { toSeq: 3, limit }), String(limit)).rejects.toMatchObject({
          code: 'E_SCAN_UNBOUNDED',
        })
      await expect(s.scan('k', { limit: -1 })).rejects.toMatchObject({ code: 'E_SCAN_UNBOUNDED' })
    } finally {
      await s.close()
    }
  })
}
