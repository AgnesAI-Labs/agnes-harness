import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createAttachmentStore } from '@agnes/host'
import { afterEach, describe, expect, it } from 'vitest'
import { openTestHost } from './host.js'

const initialize = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  },
}

type Endpoint = ReturnType<Awaited<ReturnType<typeof openTestHost>>['endpoint']>
type Response<T> = {
  result?: T
  error?: { code?: number; data?: { code?: string; reason?: string } }
}
type Window = { mimeType: string; totalBytes: number; base64: string }
let nextId = 2
const rpc = async <T>(ep: Endpoint, method: string, params: unknown): Promise<Response<T>> =>
  (await ep.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

// An 8x8 PNG and a small JPEG-shaped thumbnail.
const PNG8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)
const THUMB = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const MIB = 1024 * 1024

describe('_agnes/v1/session.attachmentRead', () => {
  it('serves a referenced image, its thumbnail and an old inline file in windows, to the owner only', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => h.close())
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const created = await rpc<{ sessionId: string }>(ep, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId
    if (!sessionId) throw new Error(JSON.stringify(created))
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    const store = createAttachmentStore({ dataDir: h.dataDir })
    const image = await store.put(PNG8, { kind: 'user-attachment', mimeType: 'image/png' })
    const thumb = await store.put(THUMB, { kind: 'thumbnail', mimeType: 'image/jpeg' })
    // 2.5 MiB, so the file takes three windows.
    const original = Buffer.alloc(2.5 * MIB)
    for (let i = 0; i < original.length; i++) original[i] = (i * 31) & 0xff
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            attachment: image,
            width: 8,
            height: 8,
            thumbnail: { ...thumb, width: 8, height: 8 },
          },
        ],
      }),
      session.ev('user/message', {
        content: [
          { type: 'text', text: 'the archive' },
          {
            type: 'file',
            mimeType: 'application/zip',
            name: 'insects.zip',
            data: original.toString('base64'),
          },
        ],
      }),
    ])
    const [imageSeq, fileSeq] = seqs as [number, number]
    const before = await session.scan({ fromSeq: 1, limit: 100 })

    const parts: Buffer[] = []
    let offset = 0
    let total = Number.POSITIVE_INFINITY
    while (offset < total) {
      const response = await rpc<Window>(ep, '_agnes/v1/session.attachmentRead', {
        sessionId,
        seq: fileSeq,
        kind: 'file',
        index: 1,
        offset,
        length: MIB,
      })
      const page = response.result
      if (!page) throw new Error(JSON.stringify(response))
      expect(page.mimeType).toBe('application/zip')
      total = page.totalBytes
      const bytes = Buffer.from(page.base64, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(MIB)
      parts.push(bytes)
      offset += bytes.length
    }
    expect(parts).toHaveLength(3)
    expect(Buffer.concat(parts).equals(original)).toBe(true)
    // Reading the old inline file kept a copy in the store; the ledger is unchanged.
    expect(await session.scan({ fromSeq: 1, limit: 100 })).toEqual(before)

    const full = await rpc<Window>(ep, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: imageSeq,
      kind: 'image',
      index: 1,
      offset: 0,
      length: MIB,
    })
    expect(full.result).toEqual({
      mimeType: 'image/png',
      totalBytes: PNG8.length,
      base64: PNG8.toString('base64'),
    })
    const small = await rpc<Window>(ep, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: imageSeq,
      kind: 'image',
      index: 1,
      offset: 0,
      length: MIB,
      thumbnail: true,
    })
    expect(small.result).toEqual({
      mimeType: 'image/jpeg',
      totalBytes: THUMB.length,
      base64: THUMB.toString('base64'),
    })

    const tooLong = await rpc(ep, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: fileSeq,
      kind: 'file',
      index: 1,
      offset: 0,
      length: MIB + 1,
    })
    expect(tooLong.error?.code).toBe(-32602)
    expect(
      (
        await rpc(ep, '_agnes/v1/session.attachmentRead', {
          sessionId,
          seq: fileSeq,
          kind: 'file',
          index: 2,
          offset: 0,
          length: 1,
        })
      ).error?.data?.reason,
    ).toBe('attachment-not-found')

    const stranger = h.endpoint({
      identity: { principalId: 'other-principal', authKind: 'local', credentialKind: 'local' },
    })
    cleanup.push(() => stranger.close())
    await stranger.handle(initialize)
    const denied = await rpc(stranger, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: imageSeq,
      kind: 'image',
      index: 1,
      offset: 0,
      length: 16,
    })
    expect(denied.result).toBeUndefined()
    expect(denied.error?.data?.code).toBe('CAPABILITY_DENIED')
  })

  it('serves nothing before the history is verified, and nothing once it failed', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    const first = h.endpoint({ pollMs: 5 })
    await first.handle(initialize)
    await h.addWorkspace(h.dataDir)
    const created = await rpc<{ sessionId: string }>(first, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId as string
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [{ type: 'file', mimeType: 'application/zip', name: 'a.zip', data: 'UEsDBA==' }],
      }),
    ])
    type Integrity = { scanIntegrity(key: string, q: { fromSeq: number }): Promise<unknown> }
    const storage = session.d.log.storage as unknown as Integrity
    await first.close()
    // A clean close writes the checkpoint the next open folds from; the full check then runs behind.
    await session.close()
    const db = new DatabaseSync(join(h.dataDir, 'sessions.db'))
    db.prepare(
      `UPDATE events SET data = json_set(data, '$.agnesVersion', 'tampered') WHERE session_key = ? AND seq = 1`,
    ).run(sessionId)
    db.close()
    const scan = storage.scanIntegrity
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let folded = false
    storage.scanIntegrity = async (key, q) => {
      if (q.fromSeq === 1 && folded) await gate
      if (q.fromSeq === 1) folded = true
      return scan.call(storage, key, q)
    }
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    expect(
      (await rpc(ep, 'session/load', { sessionId, cwd: h.dataDir, mcpServers: [] })).error,
    ).toBeUndefined()
    expect(h.host.kernel.get(sessionId)?.d.log.openStats.checkpoint).toMatchObject({ used: true })
    let settled = false
    const pending = rpc<Window>(ep, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: seqs[0],
      kind: 'file',
      index: 1,
      offset: 0,
      length: 16,
    }).finally(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(settled).toBe(false)
    storage.scanIntegrity = scan
    release()
    const refused = await pending
    expect(refused.result).toBeUndefined()
    expect(refused.error?.data).toEqual({ code: 'E_LEDGER_INTEGRITY' })
  })

  it('reports a referenced object that is gone as missing instead of failing the connection', async () => {
    const h = await openTestHost()
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => h.close())
    cleanup.push(() => ep.close())
    await ep.handle(initialize)
    const created = await rpc<{ sessionId: string }>(ep, 'session/new', { cwd: h.dataDir, mcpServers: [] })
    const sessionId = created.result?.sessionId as string
    const session = h.host.kernel.get(sessionId)
    if (!session) throw new Error('session missing')
    const { seqs } = await session.append([
      session.ev('user/message', {
        content: [
          {
            type: 'file',
            mimeType: 'application/zip',
            name: 'gone.zip',
            attachment: { sha256: 'e'.repeat(64), bytes: 10 },
          },
        ],
      }),
    ])
    const response = await rpc(ep, '_agnes/v1/session.attachmentRead', {
      sessionId,
      seq: seqs[0],
      kind: 'file',
      index: 1,
      offset: 0,
      length: 10,
    })
    expect(response.error?.data).toMatchObject({ code: 'ATTACHMENT_MISSING' })
    // The endpoint still answers.
    expect((await rpc(ep, '_agnes/v1/session.list', {})).error).toBeUndefined()
  })
})
