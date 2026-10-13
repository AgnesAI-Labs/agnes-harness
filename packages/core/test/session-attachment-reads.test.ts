import { createHash } from 'node:crypto'
import type { JsonValue, ModelRecord } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { defaultIds } from '../src/ids.js'
import { forkPaths } from '../src/log/fork-seed.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import type { ScanQuery } from '../src/log/storage.js'
import { openTracked } from '../src/reduce/tracker.js'
import type { AttachmentReadPort } from '../src/request/attachment-bytes.js'
import { sha256Hex } from '../src/request/hash.js'
import { readSessionAttachment } from '../src/request/session-files.js'
import { readSessionImages } from '../src/request/session-images.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

// An 8x8 PNG: large enough for the media limits.
const PNG8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg=='
const PNG8_BYTES = Uint8Array.from(Buffer.from(PNG8, 'base64'))
const model: ModelRecord = {
  id: 'default',
  route: 'default',
  name: 'Image model',
  api: 'openai-completions',
  baseUrl: 'https://test.invalid',
  input: ['text', 'image'],
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const signal = () => new AbortController().signal
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

/** An in-memory attachment store with the inline cache, counting what is asked of it. */
function fakePort(over: Partial<AttachmentReadPort> = {}) {
  const objects = new Map<string, Uint8Array>()
  const cache = new Map<string, { sha256: string; bytes: number }>()
  const calls = { read: 0, cacheInline: 0, cachedInline: 0 }
  const port: AttachmentReadPort = {
    async read(sha256, range) {
      calls.read++
      const bytes = objects.get(sha256)
      if (!bytes) throw Object.assign(new Error('missing'), { code: 'ATTACHMENT_MISSING' })
      return range ? bytes.slice(range.offset, range.offset + range.length) : bytes
    },
    async cacheInline(input) {
      calls.cacheInline++
      const sha256 = hex(input.bytes)
      objects.set(sha256, input.bytes)
      const stored = { sha256, bytes: input.bytes.byteLength }
      cache.set(`${input.sessionKey}/${input.seq}/${input.kind}/${input.index}`, stored)
      return stored
    },
    async cachedInline(sessionKey, seq, kind, index) {
      calls.cachedInline++
      return cache.get(`${sessionKey}/${seq}/${kind}/${index}`)
    },
    ...over,
  }
  return { port, objects, cache, calls }
}

async function opened(port: AttachmentReadPort | undefined) {
  const artifacts = new Map<string, Uint8Array>()
  const provider = fakeProvider([])
  provider.models = () => [model]
  const out = await openSession({
    provider,
    ...(port ? { attachments: port } : {}),
    seams: fakeSeams({
      artifacts: {
        put: async (bytes, meta) => {
          const sha256 = sha256Hex(bytes)
          artifacts.set(sha256, bytes)
          return { sha256, size: bytes.length, mime: meta?.mime ?? 'image/png' }
        },
      },
    }),
    requestMedia: {
      readArtifact: async ({ sha256 }) => artifacts.get(sha256),
      surfaceLimits: {
        maxLedgerEvents: 4096,
        maxSurfaceNodes: 512,
        maxContentBlocks: 4096,
        maxManifestEntries: 32,
        maxCandidateBytes: 1024 * 1024,
        maxCandidatePixels: 8_000_000,
      },
      mediaLimits: {
        maxManifestEntries: 32,
        maxSelectedImages: 4,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 1024 * 1024,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 1456 * 1456,
        maxSelectedBytes: 1024 * 1024,
        maxSelectedPixels: 8_000_000,
      },
    },
  })
  const { session } = out
  // Every ledger read the readers make, from the moment the rows are in.
  const scans: ScanQuery[] = []
  const scan = session.d.log.scan.bind(session.d.log)
  session.d.log.scan = (q) => {
    scans.push(q)
    return scan(q)
  }
  const append = async (content: unknown[], lane?: string) =>
    (
      await session.d.log.append([
        session.ev('user/message', { kind: 'prompt', content }, lane ? { lane } : {}),
      ])
    ).firstSeq
  return { ...out, scans, append, artifacts }
}

const imageRef = (sha256: string, bytes: number) => ({
  type: 'image',
  mimeType: 'image/png',
  attachment: { sha256, bytes },
  width: 8,
  height: 8,
})

describe('session attachment readers', () => {
  it('lists images from the attachment index without reading the ledger, in the same format', async () => {
    const { port } = fakePort()
    const s = await opened(port)
    const first = await s.append([
      { type: 'text', text: 'a' },
      { type: 'image', mimeType: 'image/png', data: PNG8 },
    ])
    const second = await s.append([
      imageRef(hex(PNG8_BYTES), PNG8_BYTES.byteLength),
      { type: 'image', mimeType: 'image/png', data: PNG8 },
    ])
    await s.append([{ type: 'image', mimeType: 'image/png', data: PNG8 }], 'other')
    s.scans.length = 0
    const page = await readSessionImages(s.session, { path: 'session-image://list', limit: 2 }, signal())
    expect(text(page)).toBe(
      `1. session-image://${first}/1\n2. session-image://${second}/1\n[read session-image://list with offset=3 to continue]`,
    )
    const rest = await readSessionImages(s.session, { path: 'session-image://list', offset: 3 }, signal())
    expect(text(rest)).toBe(`3. session-image://${second}/2`)
    expect(
      text(await readSessionImages(s.session, { path: 'session-image://list', offset: 9 }, signal())),
    ).toBe('No images at this offset in this session.')
    expect(s.scans).toEqual([])
  })

  it('lists files from the attachment index without reading the ledger, in the same format', async () => {
    const s = await opened(undefined)
    const seq = await s.append([
      { type: 'file', mimeType: 'text/plain', name: 'a.txt', data: 'QQ==' },
      {
        type: 'file',
        mimeType: 'application/zip',
        name: 'insects.zip',
        attachment: { sha256: 'a'.repeat(64), bytes: 9 },
      },
    ])
    s.scans.length = 0
    const list = await readSessionAttachment(s.session, { path: 'session-file://list', limit: 1 }, signal())
    expect(new TextDecoder().decode(list?.bytes)).toBe(
      `1. session-file://${seq}/1 "a.txt" (text/plain)\n[read session-file://list with offset=2 to continue]`,
    )
    const all = await readSessionAttachment(s.session, { path: 'session-file://list' }, signal())
    expect(new TextDecoder().decode(all?.bytes)).toBe(
      `1. session-file://${seq}/1 "a.txt" (text/plain)\n2. session-file://${seq}/2 "insects.zip" (application/zip)`,
    )
    expect(s.scans).toEqual([])
  })

  it('reads a referenced image from the store into the tool result, and reports corrupt or missing bytes', async () => {
    const f = fakePort()
    const sha = hex(PNG8_BYTES)
    f.objects.set(sha, PNG8_BYTES)
    const s = await opened(f.port)
    const seq = await s.append([imageRef(sha, PNG8_BYTES.byteLength)])
    s.scans.length = 0
    const result = await readSessionImages(s.session, { path: `session-image://${seq}/1` }, signal())
    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain(`Original session-image://${seq}/1`)
    const block = result.content.find((b) => b.type === 'image') as { ref: { sha256: string } } | undefined
    expect(block?.ref.sha256).toBe(sha)
    expect(s.artifacts.get(sha)).toEqual(PNG8_BYTES)
    expect(f.calls.read).toBe(1)
    expect(s.scans).toEqual([])

    const corrupt = await opened(
      fakePort({
        read: async () => Promise.reject(Object.assign(new Error('digest'), { code: 'ATTACHMENT_CORRUPT' })),
      }).port,
    )
    const bad = await corrupt.append([imageRef(sha, PNG8_BYTES.byteLength)])
    const refused = await readSessionImages(corrupt.session, { path: `session-image://${bad}/1` }, signal())
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('corrupt')

    const gone = await opened(fakePort().port)
    const missing = await gone.append([imageRef(sha, PNG8_BYTES.byteLength)])
    const absent = await readSessionImages(gone.session, { path: `session-image://${missing}/1` }, signal())
    expect(absent.isError).toBe(true)
    expect(text(absent)).toContain('missing')
    // The file reader fails with the same coded error rather than handing back other bytes.
    await expect(
      readSessionAttachment(gone.session, { path: `session-image://${missing}/1` }, signal()),
    ).rejects.toMatchObject({ code: 'E_ENVELOPE', detail: { code: 'ATTACHMENT_MISSING' } })

    // An object of another size than the reference records is not the referenced object.
    const short = fakePort()
    short.objects.set(sha, PNG8_BYTES.subarray(0, 10))
    const wrong = await opened(short.port)
    const sized = await wrong.append([imageRef(sha, PNG8_BYTES.byteLength)])
    await expect(
      readSessionAttachment(wrong.session, { path: `session-image://${sized}/1` }, signal()),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_CORRUPT' } })
  })

  it('reads an old inline file from its row once, then from the store copy, and never changes the ledger', async () => {
    const f = fakePort()
    const s = await opened(f.port)
    const original = Buffer.from('legacy inline bytes')
    const seq = await s.append([
      { type: 'text', text: 'see' },
      {
        type: 'file',
        mimeType: 'application/octet-stream',
        name: 'old.bin',
        data: original.toString('base64'),
      },
    ])
    const before = JSON.stringify(await s.storage.scan(s.session.key, { fromSeq: 1, limit: 1000 }))
    const lastSeq = s.session.lastSeq
    s.scans.length = 0
    const path = `session-file://${seq}/1`
    const first = await readSessionAttachment(s.session, { path }, signal())
    expect(Buffer.from(first?.bytes ?? []).equals(original)).toBe(true)
    expect(first).toMatchObject({ name: 'old.bin', mimeType: 'application/octet-stream' })
    expect(f.calls.cacheInline).toBe(1)
    expect(s.scans).toHaveLength(1)
    const second = await readSessionAttachment(s.session, { path }, signal())
    expect(Buffer.from(second?.bytes ?? []).equals(original)).toBe(true)
    expect(f.calls.cacheInline).toBe(1)
    expect(f.calls.cachedInline).toBe(2)
    expect(s.scans).toHaveLength(1)
    // A copy that went away is only a cache: the row is read again and the copy kept again.
    f.objects.clear()
    const third = await readSessionAttachment(s.session, { path }, signal())
    expect(Buffer.from(third?.bytes ?? []).equals(original)).toBe(true)
    expect(f.calls.cacheInline).toBe(2)
    expect(s.scans).toHaveLength(2)
    expect(s.session.lastSeq).toBe(lastSeq)
    expect(JSON.stringify(await s.storage.scan(s.session.key, { fromSeq: 1, limit: 1000 }))).toBe(before)
  })

  it('serves windows of an attachment and its thumbnail, refusing what the session does not hold', async () => {
    const f = fakePort()
    const thumb = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3])
    f.objects.set(hex(thumb), thumb)
    f.objects.set(hex(PNG8_BYTES), PNG8_BYTES)
    const s = await opened(f.port)
    const original = Buffer.alloc(5000, 3)
    const seq = await s.append([
      {
        ...imageRef(hex(PNG8_BYTES), PNG8_BYTES.byteLength),
        thumbnail: { sha256: hex(thumb), bytes: thumb.length, width: 2, height: 2 },
      },
      { type: 'file', mimeType: 'application/zip', name: 'a.zip', data: original.toString('base64') },
    ])
    const window = (kind: 'image' | 'file', offset: number, length: number, thumbnail?: boolean) =>
      s.session.readAttachmentRange({
        seq,
        kind,
        index: 1,
        offset,
        length,
        ...(thumbnail ? { thumbnail } : {}),
      })
    const parts: Buffer[] = []
    for (let offset = 0; offset < original.length; offset += 2048) {
      const piece = await window('file', offset, 2048)
      expect(piece.totalBytes).toBe(original.length)
      parts.push(Buffer.from(piece.bytes))
    }
    expect(Buffer.concat(parts).equals(original)).toBe(true)
    expect(f.calls.cacheInline).toBe(1)
    expect(await window('image', 0, 1024, true)).toMatchObject({
      mimeType: 'image/jpeg',
      totalBytes: thumb.length,
    })
    expect(Buffer.from((await window('image', 0, 1024)).bytes).equals(Buffer.from(PNG8_BYTES))).toBe(true)
    await expect(window('file', 0, 10, true)).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_FOUND' },
    })
    await expect(window('file', original.length + 1, 10)).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_RANGE' },
    })
    await expect(
      s.session.readAttachmentRange({ seq, kind: 'file', index: 2, offset: 0, length: 10 }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_NOT_FOUND' } })
  })

  it('folds the index from the stored rows when a session is opened again', async () => {
    const storage = new MemoryStorage()
    const common = {
      ttlMs: 60_000,
      clock: () => 1_757_203_200_000,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      relationCheck: () => undefined,
      ids: defaultIds(),
    }
    const first = await openTracked({ ...common, storage, key: 'r', writerRunId: 'w1' })
    await first.log.append([
      {
        actor,
        origin: 'principal',
        trust: 'trusted',
        type: 'user/message',
        data: { content: [{ type: 'file', mimeType: 'text/plain', name: 'kept.txt', data: 'QQ==' }] },
      },
    ])
    await first.log.close()
    const again = await openTracked({ ...common, storage, key: 'r', writerRunId: 'w2' })
    expect(again.attachments.list('file', 'main').map((e) => e.name)).toEqual(['kept.txt'])
    await again.log.close()
  })

  it('gives a delegated child forked from its live parent the parent attachments up to the fork point', async () => {
    const storage = new MemoryStorage()
    const common = {
      ttlMs: 60_000,
      clock: () => 1_757_203_200_000,
      timers: { setTimeout: () => 0, clearTimeout: () => undefined },
      relationCheck: () => undefined,
      ids: defaultIds(),
    }
    const row = (content: JsonValue[]) => ({
      actor,
      origin: 'principal' as const,
      trust: 'trusted' as const,
      type: 'user/message',
      data: { content },
    })
    const parent = await openTracked({ ...common, storage, key: 'p', writerRunId: 'p' })
    await parent.log.append([
      row([{ type: 'file', mimeType: 'text/plain', name: 'before.txt', data: 'QQ==' }]),
    ])
    const forked = await parent.log.forkInto(parent.log.lastSeq, 'c', {
      actor,
      agnesVersion: 'test',
      preset: null,
      resolvedProfileHash: null,
      writerRunId: 'c',
      lane: 'main',
      delegation: { kind: 'fork', creationId: 'x', rootTaskId: 'p', generationDepth: 1 },
    })
    expect(forkPaths.get(forked)).toEqual({ path: 'live-parent' })
    await parent.log.append([
      row([{ type: 'file', mimeType: 'text/plain', name: 'parent-after.txt', data: 'QQ==' }]),
    ])
    await forked.append([row([{ type: 'file', mimeType: 'text/plain', name: 'child.txt', data: 'QQ==' }])])
    const child = await openTracked({ ...common, storage, key: 'c', writerRunId: 'c', existing: forked })
    expect(child.attachments.list('file', 'main').map((e) => e.name)).toEqual(['before.txt', 'child.txt'])
    expect(parent.attachments.list('file', 'main').map((e) => e.name)).toEqual([
      'before.txt',
      'parent-after.txt',
    ])
    await child.log.close()
    await parent.log.close()
  })
})
