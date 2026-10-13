import { createHash, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AttachmentStore,
  attachmentReceiptFor,
  createAttachmentStore,
  createUserAttachmentPort,
} from '@agnes/host'
import type { ContentBlock } from '@agnes/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { attachmentRefusal } from '../src/local/methods/acp.js'
import { createAttachmentUploadService } from '../src/local/methods/attachment-upload.js'
import { openTestHost } from './host.js'

// Chunked uploads over the client connection, against an embedded endpoint and the real store: the
// object lands in the store marked with this session's receipt, and the reference block the upload
// returns is what a prompt then carries. Another session cannot use it.

const MIB = 1024 * 1024
const PNG8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)
/** A minimal baseline JPEG header of the given size, enough for the safe-image decoder. */
function jpeg(width: number, height: number, padding = 0): Buffer {
  return Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    11,
    8,
    height >>> 8,
    height & 0xff,
    width >>> 8,
    width & 0xff,
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    ...new Array(padding).fill(1),
    1,
    2,
    3,
    0xff,
    0xd9,
  ])
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

const init = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      _meta: { 'ai.agnes.harness': { capabilities: { permission: false, attachmentRefs: 1 } } },
    },
  },
}
type Response<T = Record<string, unknown>> = {
  result?: T
  error?: { code?: number; data?: { code?: string; reason?: string } }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

let nextId = 10
async function fixture(o: { limits?: Record<string, number>; disk?: number } = {}) {
  const h = await openTestHost({
    storeAttachmentsByReference: true,
    script: [
      [
        { type: 'text_delta', delta: 'ok' },
        { type: 'done', reason: 'stop' },
      ],
    ],
    ...(o.limits ? { limits: o.limits } : {}),
  })
  cleanup.push(() => h.close())
  let now = 1_000_000
  const clock = () => now
  const store = createAttachmentStore({ dataDir: h.dataDir })
  const limits = o.limits ?? {}
  const port = createUserAttachmentPort({
    store,
    limits,
    storeByReference: true,
    diskFree: async () => o.disk ?? 1024 ** 4,
  })
  const service = createAttachmentUploadService({ store, limits, reserve: port.reserve, clock })
  const ep = h.endpoint({ pollMs: 5, attachmentUpload: service })
  cleanup.push(() => ep.close())
  await ep.handle(init)
  const call = async <T = Record<string, unknown>>(method: string, params: unknown, on = ep) =>
    (await on.handle({ jsonrpc: '2.0', id: nextId++, method, params })) as Response<T>
  const newSession = async () => {
    const created = await call<{ sessionId: string }>('session/new', {
      cwd: h.dataDir,
      mcpServers: [],
      _meta: { 'ai.agnes.harness': { sessionKey: `upload-test-${randomUUID()}` } },
    })
    if (!created.result) throw new Error(JSON.stringify(created))
    return created.result.sessionId
  }
  const sessionId = await newSession()
  const upload = (params: Record<string, unknown>, session = sessionId, on = ep) =>
    call('_agnes/v1/attachment.upload', { sessionId: session, ...params }, on)
  /** Starts, sends every chunk and finishes; returns the finish response. */
  const uploadAll = async (
    bytes: Buffer,
    meta: { name: string; mimeType: string; purpose?: 'attachment' | 'thumbnail' },
    session = sessionId,
  ) => {
    const uploadId = randomUUID()
    const started = await upload({ operation: 'start', uploadId, size: bytes.length, ...meta }, session)
    if (started.error) return started
    for (let offset = 0; offset < bytes.length; offset += MIB) {
      const part = bytes.subarray(offset, offset + MIB)
      const sent = await upload(
        { operation: 'chunk', uploadId, offset, data: part.toString('base64'), sha256: sha(part) },
        session,
      )
      if (sent.error) return sent
    }
    return upload({ operation: 'finish', uploadId }, session)
  }
  const stagingFiles = () => {
    try {
      return readdirSync(join(store.root, 'staging'))
    } catch {
      return []
    }
  }
  return {
    h,
    ep,
    store,
    service,
    sessionId,
    call,
    newSession,
    upload,
    uploadAll,
    stagingFiles,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const codeOf = (r: Response) => r.error?.data?.code

describe('_agnes/v1/attachment.upload', () => {
  it('uploads 3 MiB in three chunks, stores the object and records this session’s receipt', async () => {
    const f = await fixture()
    const limits = await f.upload({ operation: 'limits' })
    expect(limits.result).toEqual({
      limits: { maxBytes: 2 * 1024 ** 3, chunkBytes: MIB, maxConcurrent: 4 },
    })
    const bytes = Buffer.alloc(3 * MIB)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff
    const uploadId = randomUUID()
    expect(
      (
        await f.upload({
          operation: 'start',
          uploadId,
          name: 'insects.zip',
          mimeType: 'application/zip',
          size: bytes.length,
        })
      ).result,
    ).toEqual({ offset: 0 })
    const offsets: unknown[] = []
    for (let offset = 0; offset < bytes.length; offset += MIB) {
      const part = bytes.subarray(offset, offset + MIB)
      const r = await f.upload({
        operation: 'chunk',
        uploadId,
        offset,
        data: part.toString('base64'),
        sha256: sha(part),
      })
      offsets.push(r.result?.offset)
    }
    expect(offsets).toEqual([MIB, 2 * MIB, 3 * MIB])
    const done = await f.upload({ operation: 'finish', uploadId, sha256: sha(bytes) })
    expect(done.result).toEqual({
      offset: bytes.length,
      attachment: {
        type: 'file',
        mimeType: 'application/zip',
        name: 'insects.zip',
        attachment: { sha256: sha(bytes), bytes: bytes.length },
      },
    })
    expect(Buffer.from(await f.store.read(sha(bytes))).equals(bytes)).toBe(true)
    const marker = await f.store.userAttachment(sha(bytes))
    expect(marker?.receipts).toEqual([attachmentReceiptFor(f.sessionId)])
    // A finished upload is gone: its id answers as expired.
    expect(codeOf(await f.upload({ operation: 'status', uploadId }))).toBe('UPLOAD_EXPIRED')
    expect(f.service.uploads.size).toBe(0)
  })

  it('refuses a chunk with the wrong digest or offset and answers a replayed chunk with the current offset', async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(2 * MIB, 3)
    const uploadId = randomUUID()
    await f.upload({ operation: 'start', uploadId, name: 'a.bin', mimeType: 'a/b', size: bytes.length })
    const first = bytes.subarray(0, MIB)
    const data = first.toString('base64')
    expect(
      codeOf(await f.upload({ operation: 'chunk', uploadId, offset: 0, data, sha256: 'e'.repeat(64) })),
    ).toBe('UPLOAD_HASH_MISMATCH')
    expect((await f.upload({ operation: 'status', uploadId })).result).toEqual({ offset: 0 })
    expect(
      codeOf(await f.upload({ operation: 'chunk', uploadId, offset: MIB, data, sha256: sha(first) })),
    ).toBe('UPLOAD_OFFSET')
    const sent = { operation: 'chunk', uploadId, offset: 0, data, sha256: sha(first) }
    expect((await f.upload(sent)).result).toEqual({ offset: MIB })
    // The same chunk again (its answer was lost): nothing is written twice.
    expect((await f.upload(sent)).result).toEqual({ offset: MIB })
    expect(codeOf(await f.upload({ operation: 'finish', uploadId }))).toBe('UPLOAD_INCOMPLETE')
    const second = bytes.subarray(MIB)
    await f.upload({
      operation: 'chunk',
      uploadId,
      offset: MIB,
      data: second.toString('base64'),
      sha256: sha(second),
    })
    // Starting the same id again reports where it is, so a client can resume from there.
    expect(
      (await f.upload({ operation: 'start', uploadId, name: 'a.bin', mimeType: 'a/b', size: bytes.length }))
        .result,
    ).toEqual({ offset: 2 * MIB })
    expect(codeOf(await f.upload({ operation: 'finish', uploadId, sha256: 'e'.repeat(64) }))).toBe(
      'UPLOAD_HASH_MISMATCH',
    )
    expect(await f.store.stat(sha(bytes))).toBeUndefined()
  })

  it('refuses an upload over the size limit or the quota before storing anything', async () => {
    const f = await fixture({
      limits: { 'attachments.max_upload_bytes': 1000, 'attachments.global_quota_bytes': 1500 },
    })
    expect(
      codeOf(
        await f.upload({
          operation: 'start',
          uploadId: randomUUID(),
          name: 'a',
          mimeType: 'a/b',
          size: 1001,
        }),
      ),
    ).toBe('UPLOAD_SIZE_LIMIT')
    const kept = Buffer.alloc(900, 1)
    expect((await f.uploadAll(kept, { name: 'a', mimeType: 'a/b' })).result).toBeDefined()
    const refused = Buffer.alloc(700, 2)
    expect(codeOf(await f.uploadAll(refused, { name: 'b', mimeType: 'a/b' }))).toBe('UPLOAD_QUOTA')
    expect(await f.store.stat(sha(refused))).toBeUndefined()
    expect(f.stagingFiles()).toEqual([])
  })

  it('holds at most four uploads per session', async () => {
    const f = await fixture()
    const start = () =>
      f.upload({ operation: 'start', uploadId: randomUUID(), name: 'a', mimeType: 'a/b', size: 10 })
    for (let i = 0; i < 4; i++) expect((await start()).result).toEqual({ offset: 0 })
    expect(codeOf(await start())).toBe('UPLOAD_BUSY')
    // Another session has its own four.
    const other = await f.newSession()
    const theirs = await f.upload(
      { operation: 'start', uploadId: randomUUID(), name: 'a', mimeType: 'a/b', size: 10 },
      other,
    )
    expect(theirs.result, JSON.stringify(theirs)).toEqual({ offset: 0 })
  })

  it('drops an upload idle for 30 minutes together with its staged bytes', async () => {
    const f = await fixture()
    const uploadId = randomUUID()
    const part = Buffer.alloc(100, 9)
    await f.upload({ operation: 'start', uploadId, name: 'a', mimeType: 'a/b', size: 200 })
    await f.upload({
      operation: 'chunk',
      uploadId,
      offset: 0,
      data: part.toString('base64'),
      sha256: sha(part),
    })
    expect(f.stagingFiles()).toHaveLength(1)
    f.advance(29 * 60_000)
    expect((await f.upload({ operation: 'status', uploadId })).result).toEqual({ offset: 100 })
    f.advance(30 * 60_000 + 1)
    expect(codeOf(await f.upload({ operation: 'status', uploadId }))).toBe('UPLOAD_EXPIRED')
    expect(f.stagingFiles()).toEqual([])
  })

  it('accepts only a small JPEG as a thumbnail, and marks it for the session', async () => {
    const f = await fixture()
    const thumbnail = { name: 't.jpg', mimeType: 'image/jpeg', purpose: 'thumbnail' as const }
    expect(codeOf(await f.uploadAll(PNG8, { ...thumbnail, mimeType: 'image/png' }))).toBe('UPLOAD_NOT_IMAGE')
    expect(codeOf(await f.uploadAll(Buffer.from('not a jpeg'), thumbnail))).toBe('UPLOAD_NOT_IMAGE')
    // A thumbnail is always a JPEG: one labelled anything else is refused whatever its bytes.
    expect(codeOf(await f.uploadAll(jpeg(10, 10), { ...thumbnail, mimeType: 'image/png' }))).toBe(
      'UPLOAD_NOT_IMAGE',
    )
    expect(codeOf(await f.uploadAll(jpeg(321, 100), thumbnail))).toBe('UPLOAD_SIZE_LIMIT')
    expect(
      codeOf(await f.upload({ operation: 'start', uploadId: randomUUID(), ...thumbnail, size: 262_145 })),
    ).toBe('UPLOAD_SIZE_LIMIT')
    const small = jpeg(320, 180)
    const done = await f.uploadAll(small, thumbnail)
    expect(done.result?.attachment).toEqual({
      sha256: sha(small),
      bytes: small.length,
      width: 320,
      height: 180,
    })
    expect((await f.store.userAttachment(sha(small)))?.receipts).toEqual([attachmentReceiptFor(f.sessionId)])
  })

  it('reads an image’s header at finish and returns an image reference with its size', async () => {
    const f = await fixture()
    const done = await f.uploadAll(PNG8, { name: 'shot.png', mimeType: 'image/png' })
    expect(done.result?.attachment).toEqual({
      type: 'image',
      mimeType: 'image/png',
      attachment: { sha256: sha(PNG8), bytes: PNG8.length },
      width: 8,
      height: 8,
      name: 'shot.png',
    })
    const broken = Buffer.concat([PNG8.subarray(0, 40), Buffer.alloc(20)])
    expect(codeOf(await f.uploadAll(broken, { name: 'bad.png', mimeType: 'image/png' }))).toBe(
      'UPLOAD_NOT_IMAGE',
    )
    // Refused, so no session may reference it: it has no marker.
    expect(await f.store.userAttachment(sha(broken))).toBeUndefined()
  })

  it('serves the session owner only, and refuses a malformed upload id', async () => {
    const f = await fixture()
    const uploadId = randomUUID()
    await f.upload({ operation: 'start', uploadId, name: 'a', mimeType: 'a/b', size: 4 })
    const stranger = f.h.endpoint({
      identity: { principalId: 'other-principal', authKind: 'local', credentialKind: 'local' },
      attachmentUpload: f.service,
    })
    cleanup.push(() => stranger.close())
    await stranger.handle(init)
    for (const params of [
      { operation: 'limits' },
      { operation: 'status', uploadId },
      { operation: 'start', uploadId: randomUUID(), name: 'a', mimeType: 'a/b', size: 4 },
    ])
      expect(codeOf(await f.upload(params, f.sessionId, stranger))).toBe('CAPABILITY_DENIED')
    const bad = await f.upload({
      operation: 'start',
      uploadId: 'upload-1',
      name: 'a',
      mimeType: 'a/b',
      size: 4,
    })
    expect(bad.error?.code).toBe(-32602)
    // A name a reference block may not carry is refused at the start, not when the prompt is sent.
    expect(
      codeOf(
        await f.upload({
          operation: 'start',
          uploadId: randomUUID(),
          name: 'a\nb',
          mimeType: 'a/b',
          size: 4,
        }),
      ),
    ).toBe('UPLOAD_INVALID')
  })

  it('answers every step as unavailable where uploads are not served', async () => {
    const h = await openTestHost()
    cleanup.push(() => h.close())
    const ep = h.endpoint({ pollMs: 5 })
    cleanup.push(() => ep.close())
    await ep.handle(init)
    const created = (await ep.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: h.dataDir, mcpServers: [] },
    })) as Response<{ sessionId: string }>
    const r = (await ep.handle({
      jsonrpc: '2.0',
      id: 3,
      method: '_agnes/v1/attachment.upload',
      params: { operation: 'limits', sessionId: created.result?.sessionId },
    })) as Response
    expect(codeOf(r)).toBe('UPLOAD_UNAVAILABLE')
  })

  it('sends the uploaded reference in a prompt within the row bound; another session is refused it', async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(3 * MIB, 5)
    const done = await f.uploadAll(bytes, { name: 'big.zip', mimeType: 'application/zip' })
    const block = (done.result as { attachment: ContentBlock }).attachment
    const { toAcpPrompt } = await import('@agnes/protocol')
    const prompted = await f.call('session/prompt', {
      sessionId: f.sessionId,
      prompt: toAcpPrompt([{ type: 'text', text: 'unpack it' }, block]),
    })
    expect(prompted.error, JSON.stringify(prompted.error)).toBeUndefined()
    const session = f.h.host.kernel.get(f.sessionId)
    if (!session) throw new Error('session missing')
    const rows = (await session.scan({ fromSeq: 1, limit: 500 })).filter(
      (row) => row.type === 'inbox' || row.type === 'user/message',
    )
    expect(rows.map((row) => row.type)).toEqual(expect.arrayContaining(['inbox', 'user/message']))
    for (const row of rows) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThanOrEqual(64 * 1024)
    const message = rows.find((row) => row.type === 'user/message')
    expect((message?.data as { content: ContentBlock[] }).content).toContainEqual(block)

    const other = await f.newSession()
    expect(other).not.toBe(f.sessionId)
    const refused = await f.call('session/prompt', {
      sessionId: other,
      prompt: toAcpPrompt([{ type: 'text', text: 'mine now' }, block]),
    })
    expect(refused.error?.data, JSON.stringify(refused)).toMatchObject({
      code: 'ATTACHMENT_NOT_AUTHORIZED',
      reason: 'attachment-not-authorized',
    })
  })

  it('leaves a committed upload nobody sent as an orphan, and sweeps half-written staging after a day', async () => {
    const f = await fixture()
    const bytes = Buffer.alloc(1000, 4)
    expect((await f.uploadAll(bytes, { name: 'a', mimeType: 'a/b' })).result).toBeDefined()
    // No prompt: the object stays stored and marked, referenced by no ledger row (the sweep's job).
    expect(await f.store.stat(sha(bytes))).toEqual({ sha256: sha(bytes), bytes: 1000 })

    const uploadId = randomUUID()
    const part = Buffer.alloc(100, 6)
    await f.upload({ operation: 'start', uploadId, name: 'b', mimeType: 'a/b', size: 200 })
    await f.upload({
      operation: 'chunk',
      uploadId,
      offset: 0,
      data: part.toString('base64'),
      sha256: sha(part),
    })
    expect(f.stagingFiles()).toHaveLength(1)
    // A restart: a new upload table over the same store knows nothing of the half-written upload.
    const restarted = createAttachmentUploadService({
      store: createAttachmentStore({ dataDir: f.h.dataDir }) as AttachmentStore,
      limits: {},
      reserve: async () => () => undefined,
    })
    const ep = f.h.endpoint({ pollMs: 5, attachmentUpload: restarted })
    cleanup.push(() => ep.close())
    await ep.handle(init)
    expect(codeOf(await f.upload({ operation: 'status', uploadId }, f.sessionId, ep))).toBe('UPLOAD_EXPIRED')
    expect(await f.store.sweepStaging(Date.now())).toBe(0)
    expect(await f.store.sweepStaging(Date.now() + 25 * 60 * 60 * 1000)).toBe(1)
    expect(f.stagingFiles()).toEqual([])
  })
})

describe('attachment refusals reach the client with their own code', () => {
  it('maps over quota, over limit, missing receipt and forged references on steer and prompt', async () => {
    const f = await fixture({
      limits: { 'attachments.session_quota_bytes': 2000, 'attachments.max_upload_bytes': 5000 },
    })
    const mine = (await f.uploadAll(Buffer.alloc(100, 1), { name: 'a.bin', mimeType: 'a/b' })).result as {
      attachment: ContentBlock
    }
    const other = await f.newSession()
    const theirs = (await f.uploadAll(Buffer.alloc(100, 2), { name: 'b.bin', mimeType: 'a/b' }, other))
      .result as { attachment: ContentBlock }
    const forged = {
      type: 'file',
      mimeType: 'a/b',
      name: 'f.bin',
      attachment: { sha256: 'f'.repeat(64), bytes: 4 },
    }
    const inline = (name: string, size: number) => ({
      type: 'file',
      mimeType: 'a/b',
      name,
      data: Buffer.alloc(size, 7).toString('base64'),
    })
    const cases: Array<[unknown, string]> = [
      [inline('q.bin', 3000), 'UPLOAD_QUOTA'],
      [inline('l.bin', 6000), 'UPLOAD_SIZE_LIMIT'],
      [theirs.attachment, 'ATTACHMENT_NOT_AUTHORIZED'],
      [forged, 'ATTACHMENT_NOT_AUTHORIZED'],
    ]
    let n = 0
    for (const [block, code] of cases) {
      const steered = await f.call('_agnes/v1/session.steer', {
        sessionId: f.sessionId,
        content: [{ type: 'text', text: 'see' }, block],
        commandId: `c-${n++}`,
      })
      expect(steered.error?.data, `${code} ${JSON.stringify(steered)}`).toMatchObject({
        code,
        reason: code.toLowerCase().replaceAll('_', '-'),
      })
    }
    const { toAcpPrompt } = await import('@agnes/protocol')
    const prompted = await f.call('session/prompt', {
      sessionId: f.sessionId,
      prompt: toAcpPrompt([{ type: 'text', text: 'see' }, forged as ContentBlock]),
    })
    expect(prompted.error?.data).toMatchObject({ code: 'ATTACHMENT_NOT_AUTHORIZED' })
    // The receipted one is still accepted.
    const accepted = await f.call('_agnes/v1/session.steer', {
      sessionId: f.sessionId,
      content: [{ type: 'text', text: 'see' }, mine.attachment],
      commandId: 'ok',
    })
    expect(accepted.error).toBeUndefined()
  })

  it('reads the refusal the same way when a worker forwarded it', () => {
    expect(attachmentRefusal({ code: 'E_ENVELOPE', message: 'x', reason: 'upload-quota' })).toMatchObject({
      data: { code: 'UPLOAD_QUOTA', reason: 'upload-quota' },
    })
    expect(
      attachmentRefusal({
        code: 'E_ENVELOPE',
        detail: { code: 'ATTACHMENT_MISSING', reason: 'attachment-missing' },
      }),
    ).toMatchObject({ data: { code: 'ATTACHMENT_MISSING' } })
    // Other envelope refusals, and other codes, are not attachment refusals.
    expect(attachmentRefusal({ code: 'E_ENVELOPE', message: 'budget' })).toBeUndefined()
    expect(attachmentRefusal({ code: 'E_ENVELOPE', reason: 'not-a-code' })).toBeUndefined()
    expect(attachmentRefusal({ code: 'E_OTHER', reason: 'upload-quota' })).toBeUndefined()
  })
})
