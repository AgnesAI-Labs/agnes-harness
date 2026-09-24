import { describe, expect, it } from 'vitest'
import { CoreError, SCAN_PAGE_MAX, type ScanQuery, scanAll, scanPages } from '../src/index.js'

type Row = { seq: number; type: string; lane: string }

/**
 * A read that behaves like the SQLite adapter: every call is capped at 500 rows whatever limit it
 * asks for, and nothing says the result was cut. A stub that returned everything would let a helper
 * that never pages pass.
 */
function ledger(n: number, typeOf: (seq: number) => string = () => 'user/message') {
  const rows: Row[] = Array.from({ length: n }, (_, i) => ({ seq: i + 1, type: typeOf(i + 1), lane: 'main' }))
  const queries: ScanQuery[] = []
  let afterRead: ((call: number) => void) | undefined
  const read = async (q: ScanQuery): Promise<Row[]> => {
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
    out = out.slice(0, Math.min(q.limit ?? 500, 500))
    afterRead?.(queries.length)
    return out
  }
  const append = (count: number): void => {
    const start = rows.length
    for (let i = 1; i <= count; i++) rows.push({ seq: start + i, type: 'user/message', lane: 'main' })
  }
  return {
    read,
    queries,
    append,
    onRead: (fn: (call: number) => void) => {
      afterRead = fn
    },
  }
}

const range = (from: number, to: number): number[] =>
  from <= to
    ? Array.from({ length: to - from + 1 }, (_, i) => from + i)
    : Array.from({ length: from - to + 1 }, (_, i) => from - i)

describe('scanPages / scanAll', () => {
  it('the stub really truncates, which is the defect the helper exists for', async () => {
    const l = ledger(1234)
    expect(await l.read({ toSeq: 1234 })).toHaveLength(500)
    expect(SCAN_PAGE_MAX).toBe(500)
  })

  it('reads an ascending range in full, page by page, and stops at toSeq without an extra read', async () => {
    const l = ledger(1234)
    const rows = await scanAll(l.read, { toSeq: 1234 })
    expect(rows.map((r) => r.seq)).toEqual(range(1, 1234))
    expect(l.queries).toEqual([
      { toSeq: 1234, limit: 500 },
      { fromSeq: 501, toSeq: 1234, limit: 500 },
      { fromSeq: 1001, toSeq: 1234, limit: 500 },
    ])
    const exact = ledger(1000)
    expect((await scanAll(exact.read, { fromSeq: 1, toSeq: 1000 })).map((r) => r.seq)).toEqual(range(1, 1000))
    expect(exact.queries).toHaveLength(2)
  })

  it('with an open upper bound, reads until a short or empty page', async () => {
    const l = ledger(1000)
    const pages: number[][] = []
    for await (const page of scanPages(l.read, { fromSeq: 1 })) pages.push(page.map((r) => r.seq))
    expect(pages).toEqual([range(1, 500), range(501, 1000)])
    expect(l.queries).toHaveLength(3)
  })

  it('reads a descending range in full and stops at the fromSeq floor without an extra read', async () => {
    const l = ledger(1234)
    expect((await scanAll(l.read, { toSeq: 1234, order: 'desc' })).map((r) => r.seq)).toEqual(range(1234, 1))
    expect(l.queries.map((q) => q.toSeq)).toEqual([1234, 734, 234])
    const floored = ledger(1234)
    const rows = await scanAll(floored.read, { fromSeq: 735, toSeq: 1234, order: 'desc' })
    expect(rows.map((r) => r.seq)).toEqual(range(1234, 735))
    expect(floored.queries).toHaveLength(1)
  })

  it('follows a type filter across seq gaps, in both directions', async () => {
    const typeOf = (seq: number): string => (seq % 2 === 1 ? 'tool/call' : 'assistant/output')
    const odd = range(1, 2400).filter((s) => s % 2 === 1)
    const asc = ledger(2400, typeOf)
    expect((await scanAll(asc.read, { toSeq: 2400, type: 'tool/call' })).map((r) => r.seq)).toEqual(odd)
    const desc = ledger(2400, typeOf)
    expect(
      (await scanAll(desc.read, { toSeq: 2400, type: 'tool/call', order: 'desc' })).map((r) => r.seq),
    ).toEqual([...odd].reverse())
  })

  it('holds to the toSeq it was given while rows are appended mid-read', async () => {
    const l = ledger(1234)
    l.onRead((call) => {
      if (call === 1) l.append(300)
    })
    const rows = await scanAll(l.read, { fromSeq: 1, toSeq: 1234 })
    expect(rows.map((r) => r.seq)).toEqual(range(1, 1234))
    expect(l.queries.every((q) => q.toSeq === 1234)).toBe(true)
  })

  it('a page that does not move past the previous one is a storage fault, not a loop', async () => {
    // The same page forever. The read gives up after a few calls so that a helper which loops here
    // fails this case instead of hanging the run.
    const replay = (seqs: number[]) => {
      let calls = 0
      return async (): Promise<Row[]> => {
        if (++calls > 5) throw new Error('runaway read')
        return seqs.map((seq) => ({ seq, type: 'user/message', lane: 'main' }))
      }
    }
    const err = await scanAll(replay(range(1, 500)), { toSeq: 2000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoreError)
    expect(err).toMatchObject({ code: 'E_STORAGE_FAULT', detail: { cursor: 501, firstSeq: 1 } })
    const stuckDesc = replay(range(2000, 1501))
    await expect(scanAll(stuckDesc, { toSeq: 2000, order: 'desc' })).rejects.toMatchObject({
      code: 'E_STORAGE_FAULT',
      detail: { cursor: 1500, firstSeq: 2000 },
    })
  })

  it('refuses a page size the adapter cannot honour, before reading anything', () => {
    const l = ledger(10)
    for (const size of [0, -1, 501, 1.5, Number.NaN])
      expect(() => scanPages(l.read, { toSeq: 10 }, size), String(size)).toThrow(RangeError)
    expect(l.queries).toEqual([])
  })

  it('scanAll demands a captured upper bound', () => {
    const l = ledger(10)
    // Never called: this case exists for the type check.
    const unbounded = () =>
      // @ts-expect-error scanAll without toSeq would be an unbounded read
      scanAll(l.read, { fromSeq: 1 })
    expect(typeof unbounded).toBe('function')
  })
})
