import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScriptedProvider } from '@agnes/ai/testkit'
import type { Host, HostSession } from '@agnes/host'
import { createTestHost } from '@agnes/host/testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleCommand } from '../src/commands.js'
import { EXPORT_RAW_CHUNK_BYTES, exportRawChunk } from '../src/export-raw.js'
import { realHosted } from './real-hosted.js'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

async function openSession(): Promise<{ host: Host; session: HostSession }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'agnes-scan-lean-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const { host } = await createTestHost({
    dataDir,
    provider: new ScriptedProvider({ scripts: [] }),
    disableSessionTitle: true,
  })
  cleanup.push(() => host.close())
  const session = await host.createSession({ key: 'scan-lean', cwd: realpathSync.native(dataDir) })
  return { host, session }
}

const bigBase64 = Buffer.alloc(400 * 1024, 7).toString('base64')

describe('worker scan command', () => {
  it('sends lean rows across the process boundary', async () => {
    const { host, session } = await openSession()
    await session.append([
      session.ev('user/message', {
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', mimeType: 'image/png', data: bigBase64 },
        ],
      }),
    ])
    const deps = { host, aborts: new Map() }
    const out = (await handleCommand(
      session,
      { method: 'scan', params: { fromSeq: 1, toSeq: session.lastSeq, limit: 500 } } as never,
      deps,
    )) as { rows: Array<{ data: unknown }>; resume?: unknown }
    expect(out.resume).toBeUndefined()
    expect(JSON.stringify(out.rows)).not.toContain(bigBase64.slice(1000, 1064))
    expect(JSON.stringify(out.rows)).toContain('"dataOmitted"')
    // The full row is still in the ledger; only the reply is lean.
    const [full] = await session.scan({ type: 'user/message', limit: 1 })
    expect(JSON.stringify(full)).toContain(bigBase64)
  })

  it.each(['asc', 'desc'] as const)(
    'returns a page that fits one frame and says where to resume (%s)',
    async (order) => {
      const { host, session } = await openSession()
      for (let i = 0; i < 6; i++)
        await session.append([
          session.ev('user/message', { content: [{ type: 'text', text: 'x'.repeat(600) }] }),
        ])
      const query = { fromSeq: 1, toSeq: session.lastSeq, limit: 500, order }
      const out = (await handleCommand(session, { method: 'scan', params: query } as never, {
        host,
        aborts: new Map(),
        maxScanFrameBytes: 2_048,
      })) as { rows: Array<{ seq: number }>; resume?: { fromSeq?: number; toSeq?: number; limit?: number } }
      const all = await session.scanLean(query)
      expect(out.rows.length).toBeGreaterThan(0)
      expect(out.rows.length).toBeLessThan(all.length)
      expect(out.rows).toEqual(all.slice(0, out.rows.length))
      expect(Buffer.byteLength(JSON.stringify(out.rows), 'utf8')).toBeLessThanOrEqual(2_048)
      const last = (out.rows.at(-1) as { seq: number }).seq
      expect(out.resume).toEqual(
        order === 'asc'
          ? { fromSeq: last + 1, limit: 500 - out.rows.length }
          : { toSeq: last - 1, limit: 500 - out.rows.length },
      )
    },
  )

  it('refuses a single row larger than one frame, naming its seq', async () => {
    const { host, session } = await openSession()
    const { seqs } = await session.append([
      session.ev('user/message', { content: [{ type: 'text', text: 'y'.repeat(4_000) }] }),
    ])
    await expect(
      handleCommand(
        session,
        { method: 'scan', params: { fromSeq: seqs[0], toSeq: seqs[0], limit: 1 } } as never,
        { host, aborts: new Map(), maxScanFrameBytes: 2_048 },
      ),
    ).rejects.toMatchObject({ data: { code: 'SCAN_ROW_TOO_LARGE', seq: seqs[0] } })
  })
})

describe('worker exportRaw command', () => {
  it('serves one stored row as its exact JSONL line in bounded pieces', async () => {
    const { host, session } = await openSession()
    const data = Buffer.alloc(EXPORT_RAW_CHUNK_BYTES + 1024, 3).toString('base64')
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', data }],
      }),
    ])
    const seq = seqs[0] as number
    const [row] = await session.scan({ fromSeq: seq, toSeq: seq, limit: 1 })
    const expected = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8')
    const parts: Buffer[] = []
    let offset: number | null = 0
    let calls = 0
    while (offset !== null) {
      const page = (await handleCommand(session, { method: 'exportRaw', params: { seq, offset } } as never, {
        host,
        aborts: new Map(),
      })) as { seq: number; base64: string; nextOffset: number | null }
      expect(page.seq).toBe(seq)
      const bytes = Buffer.from(page.base64, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(EXPORT_RAW_CHUNK_BYTES)
      parts.push(bytes)
      offset = page.nextOffset
      calls++
    }
    expect(calls).toBeGreaterThan(1)
    expect(Buffer.concat(parts).equals(expected)).toBe(true)
  })

  it('refuses a missing row and an offset past the end', async () => {
    const { session } = await openSession()
    await expect(exportRawChunk(session, session.lastSeq + 5, 0)).rejects.toMatchObject({
      data: { reason: 'row-not-found' },
    })
    await expect(exportRawChunk(session, 1, 10_000_000)).rejects.toMatchObject({
      data: { reason: 'offset-out-of-range' },
    })
    await expect(exportRawChunk(session, 0, 0)).rejects.toMatchObject({
      data: { reason: 'invalid-position' },
    })
  })
})

describe('worker tail', () => {
  it('sends lean event frames to the supervisor', async () => {
    const t = await realHosted()
    cleanup.push(t.close)
    const key = 'tail-lean'
    await t.hosted.open(t.openFrame(key))
    await t.hosted.tail(key, 1)
    const session = t.host.kernel.get(key)
    if (!session) throw new Error('session did not open')
    const { seqs } = await session.append([
      session.ev('user/message', { content: [{ type: 'image', mimeType: 'image/png', data: bigBase64 }] }),
    ])
    await vi.waitFor(() => expect(t.sent.some((f) => f.kind === 'event' && f.seq === seqs[0])).toBe(true))
    const frame = t.sent.find((f) => f.kind === 'event' && f.seq === seqs[0])
    expect(JSON.stringify(frame)).not.toContain(bigBase64.slice(1000, 1064))
    expect(JSON.stringify(frame)).toContain('"dataOmitted"')
  })
})
