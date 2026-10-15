import { actor, fakeProvider, fakeSeams, openSession, textTurn } from '@agnes/core/testkit'
import type { AttachmentStore } from '@agnes/extension-api'
import type { HostSession } from '@agnes/host'
import {
  attachmentLink,
  FILE_UPLOAD_CHUNK_BYTES,
  type FileUploadRequest,
  IncrementalSha256,
} from '@agnes/protocol'
import { uploadAttachment } from '@agnes/sdk'
import { expect, it, vi } from 'vitest'
import { OriginalUploads } from '../src/original-upload.js'

it('streams public SDK originals into a scoped receipt and a real Core prompt reference', async () => {
  const objects = new Map<string, Uint8Array>()
  const receipts = new Map<string, string>()
  const store: AttachmentStore = {
    store: async (scope, bytes, mime, signal) => {
      signal.throwIfAborted()
      const artifact = { sha256: new IncrementalSha256().update(bytes).digest(), size: bytes.length, mime }
      const id = crypto.randomUUID()
      objects.set(artifact.sha256, bytes.slice())
      receipts.set(id, JSON.stringify([scope, artifact]))
      return { id, artifact }
    },
    authorize: async (scope, receipt) =>
      receipts.get(receipt.id) === JSON.stringify([scope, receipt.artifact]),
    confirm: async (_scope, id) => {
      receipts.delete(id)
    },
    discard: async (_scope, id) => {
      receipts.delete(id)
    },
    pendingRoots: async () => ({ complete: true, roots: [] }),
  }
  const opened = await openSession({
    provider: fakeProvider([textTurn('saved')]),
    seams: fakeSeams({
      artifacts: { attachments: store, get: async (ref) => objects.get(ref.sha256)!.slice() },
    }),
  })
  const intake = new OriginalUploads(opened.session as HostSession)
  const calls: FileUploadRequest[] = []
  const client = {
    call: async <T>(_method: string, params: unknown): Promise<T> => {
      const input = params as FileUploadRequest
      calls.push(input)
      return (await intake.request(input)) as T
    },
  }
  const source = new Uint8Array(FILE_UPLOAD_CHUNK_BYTES + 7).fill(42)
  const uploadId = crypto.randomUUID()
  const scope = { sessionId: opened.session.key, laneId: opened.session.lane }
  let interrupted = false
  await expect(
    uploadAttachment(
      client,
      scope,
      {
        name: 'original.bin',
        type: 'application/octet-stream',
        size: source.length,
        read: async (start, end) => {
          if (start > 0) {
            interrupted = true
            throw new Error('disconnected')
          }
          return source.slice(start, end)
        },
      },
      { uploadId },
    ),
  ).rejects.toThrow('disconnected')
  expect(interrupted).toBe(true)
  const previousChunk = calls.find((call) => call.operation === 'chunk')
  if (!previousChunk) throw new Error('missing chunk')
  expect(await intake.request(previousChunk)).toEqual({ offset: FILE_UPLOAD_CHUNK_BYTES })
  const link = await uploadAttachment(
    client,
    scope,
    {
      name: 'original.bin',
      type: 'application/octet-stream',
      size: source.length,
      read: async (start, end) => source.slice(start, end),
    },
    { uploadId },
  )
  expect(
    calls.filter((call) => call.operation === 'chunk').map((call) => JSON.stringify(call).length),
  ).toEqual([expect.any(Number), expect.any(Number)])
  expect(Math.max(...calls.map((call) => JSON.stringify(call).length))).toBeLessThan(1_400_000)
  await opened.session.enqueue('next-turn', { actor, content: [link] })
  await opened.session.acceptInput()
  const rows = await opened.log.scan({ type: 'user/message', limit: 1 })
  expect(JSON.stringify(rows)).not.toContain('KioqKioq')
  expect(rows[0]?.data).toMatchObject({ content: [attachmentLink(link.attachment.artifact, 'original.bin')] })
  expect(receipts.size).toBe(0)
  await expect(
    intake.request({
      ...scope,
      destination: 'original',
      uploadId,
      operation: 'finish',
      sha256: link.attachment.artifact.sha256,
    }),
  ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_DATA' } })
  const pendingId = crypto.randomUUID()
  await intake.request({
    ...scope,
    destination: 'original',
    uploadId: pendingId,
    operation: 'start',
    name: 'a',
    mimeType: 'text/plain',
    size: 1,
  })
  await expect(
    intake.request({
      ...scope,
      laneId: 'foreign',
      destination: 'original',
      uploadId: pendingId,
      operation: 'status',
    }),
  ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_NOT_AUTHORIZED' } })
  await intake.request({ ...scope, destination: 'original', uploadId: pendingId, operation: 'cancel' })
  await expect(
    intake.request({ ...scope, destination: 'original', uploadId: pendingId, operation: 'status' }),
  ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_CANCELLED' } })
  const expiresId = crypto.randomUUID()
  await intake.request({
    ...scope,
    uploadId: expiresId,
    destination: 'original',
    operation: 'start',
    name: 'deadline',
    mimeType: 'text/plain',
    size: 1,
  })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 30 * 60_000 + 1)
  try {
    await expect(
      intake.request({ ...scope, uploadId: expiresId, destination: 'original', operation: 'status' }),
    ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_TIMEOUT' } })
  } finally {
    clock.mockRestore()
  }
  await expect(
    intake.request({
      ...scope,
      uploadId: crypto.randomUUID(),
      destination: 'original',
      operation: 'start',
      name: 'oversize',
      mimeType: 'text/plain',
      size: 101 * 1024 * 1024,
    }),
  ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_BYTES' } })
  await intake.close()
  await opened.log.close()
})
