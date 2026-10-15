import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { AttachmentReceipt, AttachmentScope, AttachmentStore } from '@agnes/extension-api'
import { attachmentLink, type ContentBlock, IncrementalSha256, storedAttachment } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { attachmentSurface } from '../src/request/attachment-surface.js'
import { readSessionAttachment } from '../src/request/session-files.js'
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
    artifacts: { put, get: async (ref) => objects.get(ref.sha256)?.slice() ?? new Uint8Array(), attachments },
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
  return { objects, pending, seams, provider, attachments }
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
    const transient = await attachmentSurface(session, surface)
    expect(JSON.stringify(transient)).toContain(data)
    expect(JSON.stringify(surface)).not.toContain(data)
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
