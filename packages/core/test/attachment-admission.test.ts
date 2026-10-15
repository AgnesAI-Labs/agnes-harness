import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { AttachmentReceipt, AttachmentScope, AttachmentStore } from '@agnes/extension-api'
import {
  AttachmentError,
  attachmentLink,
  type ContentBlock,
  IncrementalSha256,
  storedAttachment,
} from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { visibleAttachmentRefs } from '../src/request/attachment-admission.js'
import { attachmentIndex } from '../src/request/attachment-index.js'
import { attachmentSurface } from '../src/request/attachment-surface.js'
import { readSessionAttachment } from '../src/request/session-files.js'
import { readSessionImages } from '../src/request/session-images.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

function fixture() {
  const objects = new Map<string, Uint8Array>()
  const pending = new Map<string, { scope: AttachmentScope; receipt: AttachmentReceipt }>()
  let ordinal = 0
  const put = async (bytes: Uint8Array, meta?: { mime?: string }) => {
    const ref = {
      sha256: new IncrementalSha256().update(bytes).digest(),
      size: bytes.length,
      mime: meta?.mime ?? 'application/octet-stream',
    }
    objects.set(ref.sha256, bytes.slice())
    return ref
  }
  const attachments: AttachmentStore = {
    async store(scope, bytes, mime, signal) {
      signal.throwIfAborted()
      const receipt = {
        id: `00000000-0000-4000-8000-${String(++ordinal).padStart(12, '0')}`,
        artifact: await put(bytes, { mime }),
      }
      pending.set(receipt.id, { scope, receipt })
      return receipt
    },
    async authorize(scope, receipt) {
      const found = pending.get(receipt.id)
      return (
        !!found &&
        JSON.stringify(found.scope) === JSON.stringify(scope) &&
        JSON.stringify(found.receipt) === JSON.stringify(receipt)
      )
    },
    async confirm(_scope, id) {
      pending.delete(id)
    },
    async discard(_scope, id) {
      pending.delete(id)
    },
    async pendingRoots() {
      return { complete: true, roots: [...pending.values()].map((row) => row.receipt.artifact) }
    },
  }
  const seams = fakeSeams({
    artifacts: {
      put,
      get: async (ref) => {
        const bytes = objects.get(ref.sha256)
        if (!bytes) throw new AttachmentError('ATTACHMENT_MISSING')
        return bytes.slice()
      },
      attachments,
    },
  })
  const provider = fakeProvider([textTurn('saved')])
  provider.models = () => [
    {
      id: 'default',
      route: 'default',
      name: 'Synthetic vision',
      api: 'openai-completions',
      baseUrl: 'https://test.invalid',
      input: ['text', 'image'],
      reasoning: false,
      contextWindow: 10000,
      maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ]
  return {
    objects,
    pending,
    seams,
    provider,
    attachments,
    imageInputTokenFallback: ({ imageCount }: { imageCount: number }) => ({ tokens: 128, imageCount }),
  }
}
const inline = (text: string): ContentBlock => ({
  type: 'file',
  name: 'report.txt',
  mimeType: 'text/plain',
  data: btoa(text),
})
const queued = (session: Awaited<ReturnType<typeof openSession>>['session']): ContentBlock[] =>
  (session.latest('inbox') as { items: { content: ContentBlock[] }[] }).items.at(-1)?.content ?? []

describe('artifact-backed input admission', () => {
  it('persists references in inbox and messages, reads exact originals and never exposes raw files in the prompt', async () => {
    const f = fixture()
    const { session, log } = await openSession(f)
    await session.enqueue('next-turn', { actor, content: [inline('private-original')] })
    const content = queued(session)
    expect(content).toHaveLength(1)
    expect(storedAttachment(content[0]!)).toBe(true)
    expect(JSON.stringify(content)).not.toContain(btoa('private-original'))
    expect(f.pending.size).toBe(0)
    await session.acceptInput()
    const [row] = await log.scan({ type: 'user/message', lane: 'main', limit: 1 })
    const original = await readSessionAttachment(
      session,
      { path: `session-file://${row!.seq}/1` },
      new AbortController().signal,
    )
    expect(new TextDecoder().decode(original?.bytes)).toBe('private-original')
    await expect(
      readSessionAttachment(
        session,
        { path: `session-file://${row!.seq}/1`, maxBytes: 2 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
    expect(
      await readSessionAttachment(
        session,
        { path: `session-file://${session.lastSeq + 1}/1` },
        new AbortController().signal,
      ),
    ).toBeUndefined()
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(JSON.stringify(f.provider.requests)).not.toContain(btoa('private-original'))
    expect(JSON.stringify(f.provider.requests)).toContain('session-file://')
  })

  it('refuses forged scope/size/MIME/hash and leaves the inbox unchanged on failure', async () => {
    const f = fixture()
    const { session, log } = await openSession(f)
    const receipt = await f.attachments.store(
      { sessionKey: 'foreign', lane: 'main' },
      new Uint8Array([1, 2]),
      'text/plain',
      new AbortController().signal,
    )
    const link = attachmentLink(receipt.artifact, 'foreign', { receiptId: receipt.id })
    await expect(session.enqueue('next-turn', { actor, content: [link] })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    expect(f.pending.has(receipt.id)).toBe(true)
    const own = await f.attachments.store(
      { sessionKey: session.key, lane: session.lane },
      new Uint8Array([3]),
      'text/plain',
      new AbortController().signal,
    )
    for (const artifact of [
      { ...own.artifact, size: 2 },
      { ...own.artifact, mime: 'application/pdf' },
    ])
      await expect(
        session.enqueue('next-turn', {
          actor,
          content: [attachmentLink(artifact, 'forged', { receiptId: own.id })],
        }),
      ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' } })
    f.objects.set(own.artifact.sha256, new Uint8Array([9]))
    await expect(
      session.enqueue('next-turn', {
        actor,
        content: [attachmentLink(own.artifact, 'tampered', { receiptId: own.id })],
      }),
    ).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_HASH_MISMATCH' } })
    expect(await log.scan({ type: 'inbox', limit: 10 })).toEqual([])
    const append = vi.spyOn(log, 'append').mockRejectedValueOnce(new Error('synthetic append failure'))
    await expect(session.enqueue('next-turn', { actor, content: [inline('rollback')] })).rejects.toThrow(
      'synthetic append failure',
    )
    append.mockRestore()
    expect([...f.pending.values()].map((entry) => entry.receipt.id).sort()).toEqual(
      [own.id, receipt.id].sort(),
    )
  })

  it('inherits only visible fork prefixes and rejects another lane or a later parent reference', async () => {
    const f = fixture(),
      storage = new MemoryStorage()
    const parent = await openSession({ ...f, storage, key: 'parent' })
    await parent.session.enqueue('next-turn', { actor, content: [inline('prefix')] })
    await parent.session.acceptInput()
    const first = queued(parent.session) // Claimed input is empty; use the immutable message instead.
    expect(first).toEqual([])
    const [message] = await parent.log.scan({ type: 'user/message', limit: 1 })
    const prefix = (message!.data as { content: ContentBlock[] }).content
    await parent.session.run({ until: 'turn-end', signal: new AbortController().signal })
    const cut = parent.session.lastSeq
    await storage.createChild('parent', cut, 'child')
    await parent.session.enqueue('next-turn', { actor, content: [inline('after-boundary')] })
    const late = queued(parent.session)
    const child = await openSession({ ...f, storage, key: 'child', writerRunId: 'child-writer' })
    await expect(child.session.enqueue('next-turn', { actor, content: prefix })).resolves.toBeGreaterThan(cut)
    await expect(child.session.enqueue('next-turn', { actor, content: late })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    await parent.log.close()
    const other = await openSession({
      ...f,
      storage,
      key: 'parent',
      writerRunId: 'lane-writer',
      lane: 'other',
    })
    await expect(other.session.enqueue('next-turn', { actor, content: prefix })).rejects.toMatchObject({
      detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
    })
    const read = await readSessionAttachment(
      child.session,
      { path: `session-file://${message!.seq}/1` },
      new AbortController().signal,
    )
    expect(new TextDecoder().decode(read?.bytes)).toBe('prefix')
  })

  it('hydrates only a transient image surface and can copy the image original without a model read', async () => {
    const f = fixture(),
      { session } = await openSession(f)
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await session.enqueue('next-turn', { actor, content: [{ type: 'image', data, mimeType: 'image/png' }] })
    expect(queued(session)[0]).toMatchObject({
      type: 'resource_link',
      attachment: { image: { width: 1, height: 1 } },
    })
    await session.acceptInput()
    const surface = session.surface()
    const { surface: transient } = await attachmentSurface(session, surface)
    expect(JSON.stringify(transient)).toContain(data)
    expect(JSON.stringify(surface)).not.toContain(data)
    const forged = structuredClone(surface)
    const forgedUser = forged.find((node) => node.kind === 'user')!
    const forgedContent = (forgedUser.event.data as { content: ContentBlock[] }).content
    forgedContent[0] = attachmentLink(
      { sha256: 'f'.repeat(64), size: 68, mime: 'image/png' },
      'foreign.png',
      { image: { width: 1, height: 1 } },
    )
    await expect(attachmentSurface(session, forged)).rejects.toMatchObject({
      code: 'ATTACHMENT_NOT_AUTHORIZED',
    })
    const seq = surface.find((node) => node.kind === 'user')!.seq
    const original = await readSessionAttachment(
      session,
      { path: `session-image://${seq}/1` },
      new AbortController().signal,
    )
    expect(Buffer.from(original!.bytes).toString('base64')).toBe(data)
  })
})

it('cancels a provider that ignores its signal without persisting input, and rejects a forged thumbnail', async () => {
  const f = fixture()
  const { session, log } = await openSession(f)
  const receipt = await f.attachments.store(
    { sessionKey: session.key, lane: 'main' },
    new Uint8Array([1]),
    'text/plain',
    new AbortController().signal,
  )
  const thumbnail = { sha256: 'f'.repeat(64), size: 10, mime: 'image/png' }
  const ref = attachmentLink(receipt.artifact, 'original', { receiptId: receipt.id, thumbnail })
  await expect(session.enqueue('next-turn', { actor, content: [ref] })).rejects.toMatchObject({
    detail: { code: 'ATTACHMENT_NOT_AUTHORIZED' },
  })
  f.attachments.store = async () => new Promise(() => {})
  const cancelled = new AbortController()
  const pending = session.enqueue('next-turn', {
    actor,
    content: [inline('cancel me')],
    signal: cancelled.signal,
  })
  cancelled.abort()
  await expect(pending).rejects.toMatchObject({ detail: { code: 'ATTACHMENT_CANCELLED' } })
  expect(await log.scan({ type: 'inbox', limit: 10 })).toEqual([])
})

it('reuses bounded verified attachment metadata across long text history and only scans appended ranges', async () => {
  const f = fixture()
  const { session, log } = await openSession(f)
  await session.enqueue('next-turn', { actor, content: [inline('indexed')] })
  await session.acceptInput()
  for (let page = 0; page < 4; page++)
    await session.append(
      Array.from({ length: 100 }, (_, index) =>
        session.ev('user/message', {
          kind: 'prompt',
          content: [{ type: 'text', text: `text-${page}-${index}` }],
        }),
      ),
    )
  const snapshot = await attachmentIndex(session)
  // A caller cannot mutate the cache's authority through a returned projection snapshot.
  ;(snapshot.refs as Map<string, unknown>).clear()
  const through = session.lastSeq
  const scan = log.scan.bind(log)
  // A storage adapter may enforce an I/O window after indexing. Repeated list/authority reads
  // must work without requesting that historical range (no private-helper or call-count assertion).
  const bounded = vi.spyOn(log, 'scan').mockImplementation((query = {}) => {
    if ((query.fromSeq ?? 0) <= through && query.fromSeq !== query.toSeq)
      throw new Error('historical storage window is closed')
    return scan(query)
  })
  try {
    for (let index = 0; index < 3; index++) {
      expect((await visibleAttachmentRefs(session)).size).toBe(1)
      const list = await readSessionAttachment(
        session,
        { path: 'session-file://list' },
        new AbortController().signal,
      )
      expect(new TextDecoder().decode(list?.bytes)).toContain('report.txt')
      expect(
        await readSessionImages(session, { path: 'session-image://list' }, new AbortController().signal),
      ).toMatchObject({ content: [{ type: 'text', text: 'No images at this offset in this session.' }] })
    }
    await session.enqueue('next-turn', { actor, content: [inline('incremental')] })
    await session.append([session.ev('user/message', { kind: 'prompt', content: queued(session) })])
    expect((await attachmentIndex(session)).files).toHaveLength(snapshot.files.length + 1)
    expect((await visibleAttachmentRefs(session)).size).toBe(2)
  } finally {
    bounded.mockRestore()
  }
})

it('keeps an omitted image prefix across model changes and verified reopen, preserving fresh originals', async () => {
  const f = fixture(),
    storage = new MemoryStorage()
  const baseModels = f.provider.models
  f.provider = fakeProvider(Array.from({ length: 5 }, () => textTurn('saved')))
  f.provider.models = () => baseModels().map((m) => ({ ...m, inputLimits: { images: { maxPerRequest: 4 } } }))
  const { session, log } = await openSession({ ...f, storage, key: 'image-prefix' })
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  for (let turn = 0; turn < 5; turn++) {
    await session.enqueue('next-turn', { actor, content: [{ type: 'image', data, mimeType: 'image/png' }] })
    await session.acceptInput()
    expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
  }
  const headers = await log.scan({ type: 'request/header', order: 'desc', limit: 1 })
  expect(headers[0]?.data).toMatchObject({ attachmentImagesOmittedThrough: expect.any(Number) })
  await log.close()
  f.provider.models = baseModels
  const reopened = await openSession({ ...f, storage, key: 'image-prefix', writerRunId: 'reopened' })
  const { surface: transient } = await attachmentSurface(reopened.session, reopened.session.surface())
  const images = transient.filter(
    (n) => n.kind === 'user' && JSON.stringify(n.event.data).includes('session-image://'),
  )
  expect(images.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(images.slice(0, 2))).toContain('original not included')
  const [original] = [...f.objects.values()]
  expect(Buffer.from(original!).toString('base64')).toBe(data)
  f.objects.clear()
  await expect(attachmentSurface(reopened.session, reopened.session.surface())).rejects.toBeDefined()
  await reopened.log.close()
})

it('degrades a missing historical original while retaining the current image and refusing corrupt history', async () => {
  const f = fixture()
  const { session } = await openSession(f)
  const jpeg = Uint8Array.of(
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    0,
    1,
    0,
    1,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    1,
    2,
    3,
    255,
    217,
  )
  await session.enqueue('next-turn', {
    actor,
    content: [
      { type: 'image', data: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' },
      {
        type: 'image',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        mimeType: 'image/png',
      },
    ],
  })
  await session.acceptInput()
  await session.run({ until: 'turn-end', signal: new AbortController().signal })
  const oldSha = new IncrementalSha256().update(jpeg).digest()
  const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  await session.enqueue('next-turn', { actor, content: [{ type: 'image', data, mimeType: 'image/png' }] })
  await session.acceptInput()
  f.objects.delete(oldSha)
  const projected = await attachmentSurface(session, session.surface())
  const oldSeq = session.surface().find((node) => node.kind === 'user')!.seq
  const transient = JSON.stringify(projected.surface)
  expect(transient).toContain('original missing')
  expect(transient).toContain(data)
  expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
    reason: 'completed',
  })
  const shown = f.provider.requests
    .at(-1)
    ?.messages.find((message) =>
      JSON.stringify(message).includes(`session-image://${oldSeq}/1; original missing`),
    )
  expect(JSON.stringify(shown)).toContain(`session-image://${oldSeq}/1; original missing`)
  expect(JSON.stringify(shown)).toContain(`session-image://${oldSeq}/2; pixels`)
  expect(shown?.content.filter((block) => block.type === 'image')).toHaveLength(1)
  f.objects.set(oldSha, new Uint8Array([9]))
  await expect(attachmentSurface(session, session.surface())).rejects.toMatchObject({
    code: 'ATTACHMENT_HASH_MISMATCH',
  })
})
