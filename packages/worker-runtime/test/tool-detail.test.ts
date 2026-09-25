import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { encodeFrame } from '../src/framing.js'
import { readToolDetailPage, TOOL_DETAIL_PAGE_BYTES } from '../src/tool-detail.js'

function ledger() {
  const rows = [
    { seq: 7, type: 'tool/call', data: { toolUseId: 'a', name: 'read', args: { path: 'x' }, ordinal: 0 } },
    {
      seq: 9,
      type: 'tool/result',
      data: {
        toolUseId: 'a',
        content: [{ type: 'text', text: '中'.repeat(400_000) }],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'd' },
      },
    },
    {
      seq: 11,
      type: 'tool/result',
      data: {
        toolUseId: 'b',
        content: [],
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'd' },
      },
    },
  ] as unknown as EventEnvelope[]
  return {
    async scan(q: { fromSeq: number; toSeq: number; limit: number }) {
      return rows.filter((row) => row.seq >= q.fromSeq && row.seq <= q.toSeq).slice(0, q.limit)
    },
  }
}

describe('readToolDetailPage', () => {
  it('returns full UTF-8 JSON through frame-safe pages', async () => {
    const session = ledger()
    const scan = vi.spyOn(session, 'scan')
    const pages: Buffer[] = []
    let offset = 0
    let total = 0
    for (;;) {
      const got = await readToolDetailPage(session, {
        callSeq: 7,
        resultSeq: 9,
        offset,
        maxBytes: TOOL_DETAIL_PAGE_BYTES,
      })
      expect(got.ok).toBe(true)
      if (!got.ok) throw new Error(got.reason)
      expect(encodeFrame(got.page).byteLength).toBeLessThan(2 * 1024 * 1024)
      pages.push(Buffer.from(got.page.data, 'base64'))
      total = got.page.totalBytes
      if (got.page.nextOffset === null) break
      offset = got.page.nextOffset
    }
    expect(pages.length).toBeGreaterThan(1)
    expect(scan).toHaveBeenCalledTimes(2)
    const bytes = Buffer.concat(pages)
    expect(bytes.byteLength).toBe(total)
    const detail = JSON.parse(bytes.toString('utf8')) as {
      call: { args: unknown }
      result: { content: unknown }
    }
    expect(detail.call.args).toEqual({ path: 'x' })
    expect(detail.result.content).toEqual([{ type: 'text', text: '中'.repeat(400_000) }])
  })

  it('bounds serialized detail caching across sessions', async () => {
    const sessions = [ledger(), ledger(), ledger()]
    const scans = sessions.map((session) => vi.spyOn(session, 'scan'))
    const read = (session: ReturnType<typeof ledger>) =>
      readToolDetailPage(session, { callSeq: 7, offset: 0, maxBytes: 64 })
    for (const session of sessions) expect((await read(session)).ok).toBe(true)
    expect((await read(sessions[0] as ReturnType<typeof ledger>)).ok).toBe(true)
    expect(scans[0]).toHaveBeenCalledTimes(2)
    expect(scans[1]).toHaveBeenCalledTimes(1)
    expect(scans[2]).toHaveBeenCalledTimes(1)
  })

  it('releases an idle cached detail when its lifetime ends', async () => {
    vi.useFakeTimers()
    try {
      const session = ledger()
      const scan = vi.spyOn(session, 'scan')
      const read = () => readToolDetailPage(session, { callSeq: 7, offset: 0, maxBytes: 64 })
      expect((await read()).ok).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(20_000)
      expect((await read()).ok).toBe(true)
      expect(scan).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(vi.getTimerCount()).toBe(0)
      expect((await read()).ok).toBe(true)
      expect(scan).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an oversized escaped detail before serializing the complete object', async () => {
    const session = ledger()
    const originalScan = session.scan
    session.scan = async (q) => {
      if (q.fromSeq !== 9) return originalScan(q)
      const [result] = await originalScan(q)
      return [
        {
          ...result,
          data: {
            ...(result?.data as object),
            content: [{ type: 'text', text: '\n'.repeat(34 * 1024 * 1024) }],
          },
        },
      ] as EventEnvelope[]
    }
    const originalStringify = JSON.stringify
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value) => {
      if (value !== null && typeof value === 'object') throw new Error('serialized oversized detail')
      return originalStringify(value)
    })
    try {
      await expect(
        readToolDetailPage(session, { callSeq: 7, resultSeq: 9, offset: 0, maxBytes: 64 }),
      ).resolves.toEqual({ ok: false, reason: 'detail-too-large' })
    } finally {
      stringify.mockRestore()
    }
  })

  it('rejects wrong seq, type, tool identity and offset', async () => {
    const session = ledger()
    const read = (callSeq: number, resultSeq?: number, offset = 0) =>
      readToolDetailPage(session, {
        callSeq,
        ...(resultSeq === undefined ? {} : { resultSeq }),
        offset,
        maxBytes: 64,
      })
    await expect(read(8)).resolves.toEqual({ ok: false, reason: 'call-not-found' })
    await expect(read(9)).resolves.toEqual({ ok: false, reason: 'call-not-found' })
    await expect(read(7, 8)).resolves.toEqual({ ok: false, reason: 'result-not-found' })
    await expect(read(7, 11)).resolves.toEqual({ ok: false, reason: 'tool-use-id-mismatch' })
    await expect(read(7, undefined, 10_000)).resolves.toEqual({ ok: false, reason: 'offset-out-of-range' })
  })
})
