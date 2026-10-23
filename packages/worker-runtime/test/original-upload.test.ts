import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
import { hasPrivateDaclSync } from '@agnes/system-node'
import { expect, it, vi } from 'vitest'
import { OriginalUploads } from '../src/original-upload.js'

it.each([false, true])(
  'streams public SDK originals into a scoped receipt and a real Core prompt reference (stream=%s)',
  async (stream) => {
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
    if (stream)
      store.storeStream = async (scope, source, artifact, signal) => {
        const chunks: Uint8Array[] = []
        const hash = createHash('sha256')
        for await (const chunk of source) {
          signal.throwIfAborted()
          expect(chunk.length).toBeLessThanOrEqual(FILE_UPLOAD_CHUNK_BYTES)
          hash.update(chunk)
          chunks.push(chunk.slice())
        }
        expect(hash.digest('hex')).toBe(artifact.sha256)
        const bytes = Buffer.concat(chunks)
        expect(bytes.length).toBe(artifact.size)
        const id = crypto.randomUUID()
        objects.set(artifact.sha256, bytes)
        receipts.set(id, JSON.stringify([scope, artifact]))
        return { id, artifact }
      }
    const opened = await openSession({
      provider: fakeProvider([textTurn('saved')]),
      seams: fakeSeams({
        artifacts: { attachments: store, get: async (ref) => objects.get(ref.sha256)!.slice() },
      }),
    })
    const temporary = await mkdtemp(join(tmpdir(), 'agh-original-test-'))
    vi.stubEnv('TMPDIR', temporary)
    vi.stubEnv('TEMP', temporary)
    vi.stubEnv('TMP', temporary)
    const intake = new OriginalUploads(opened.session as HostSession)
    try {
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
      // SDK-owned IDs cannot be resumed by the caller: failed reads must release their slots/spools.
      for (let n = 0; n < 4; n++) {
        await expect(
          uploadAttachment(client, scope, {
            name: 'unreadable.bin',
            type: 'application/octet-stream',
            size: 1,
            read: async () => {
              throw new Error('source changed')
            },
          }),
        ).rejects.toThrow('source changed')
        expect(await readdir(temporary)).toEqual([])
      }
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
      const staged = (await readdir(temporary, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
      expect(staged.length).toBeGreaterThan(0)
      for (const file of staged) {
        expect(hasPrivateDaclSync(file)).toBe(true)
        expect(hasPrivateDaclSync(dirname(file))).toBe(true)
      }
      const previousChunk = calls.find((call) => call.operation === 'chunk')
      if (!previousChunk) throw new Error('missing chunk')
      expect(await intake.request(previousChunk)).toEqual({ offset: FILE_UPLOAD_CHUNK_BYTES })
      await expect(
        intake.request({ ...previousChunk, sha256: '0'.repeat(64) } as FileUploadRequest),
      ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_HASH_MISMATCH' } })
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
      expect(rows[0]?.data).toMatchObject({
        content: [attachmentLink(link.attachment.artifact, 'original.bin')],
      })
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
        size: source.length,
      })
      await intake.request({ ...previousChunk, uploadId: pendingId })
      await expect(
        intake.request({
          ...scope,
          laneId: 'foreign',
          destination: 'original',
          uploadId: pendingId,
          operation: 'status',
        }),
      ).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_NOT_AUTHORIZED' } })
      const tail = source.slice(FILE_UPLOAD_CHUNK_BYTES)
      const writing = intake.request({
        ...scope,
        destination: 'original',
        uploadId: pendingId,
        operation: 'chunk',
        offset: FILE_UPLOAD_CHUNK_BYTES,
        data: Buffer.from(tail).toString('base64'),
        sha256: new IncrementalSha256().update(tail).digest(),
      })
      const cancelledWrite = expect(writing).rejects.toMatchObject({
        data: { reason: 'ATTACHMENT_CANCELLED' },
      })
      const busy = expect(intake.request({ ...previousChunk, uploadId: pendingId })).rejects.toMatchObject({
        data: { reason: 'UPLOAD_BUSY' },
      })
      const cancelling = intake.request({
        ...scope,
        destination: 'original',
        uploadId: pendingId,
        operation: 'cancel',
      })
      await busy
      await cancelling
      await cancelledWrite
      await expect(intake.request({ ...previousChunk, uploadId: pendingId })).rejects.toMatchObject({
        data: { reason: 'ATTACHMENT_CANCELLED' },
      })
      expect(receipts.size).toBe(0)
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
    } finally {
      await intake.close()
      await opened.log.close()
      vi.unstubAllEnvs()
      try {
        expect(await readdir(temporary)).toEqual([])
      } finally {
        await rm(temporary, { recursive: true, force: true })
      }
    }
  },
)

it.each([false, true])(
  'never retries a lost finish response or masks it with a cleanup failure (resumable=%s)',
  async (resumable) => {
    const operations: string[] = []
    const client = {
      call: async <T>(_method: string, params: unknown): Promise<T> => {
        const input = params as FileUploadRequest
        operations.push(input.operation)
        if (input.operation === 'finish') throw new Error('response lost')
        if (input.operation === 'cancel') throw new Error('cleanup unavailable')
        return { offset: input.operation === 'start' ? 0 : 1 } as T
      },
    }
    await expect(
      uploadAttachment(
        client,
        { sessionId: 'session', laneId: 'main' },
        {
          name: 'a.bin',
          type: 'application/octet-stream',
          size: 1,
          read: async () => new Uint8Array([42]),
        },
        resumable ? { uploadId: crypto.randomUUID() } : {},
      ),
    ).rejects.toThrow('response lost')
    expect(operations).toEqual(
      resumable ? ['start', 'chunk', 'finish'] : ['start', 'chunk', 'finish', 'cancel'],
    )
  },
)

it('cancels a streaming publication in flight and discards a late receipt without resurrecting retries', async () => {
  let entered!: () => void
  let release!: () => void
  let discarded!: () => void
  const reading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const removed = new Promise<void>((resolve) => {
    discarded = resolve
  })
  const receipts = new Set<string>()
  const store: AttachmentStore = {
    store: async () => {
      throw new Error('streaming provider must be used')
    },
    storeStream: async (_scope, source, artifact) => {
      for await (const _chunk of source) {
        entered()
        break
      }
      await gate
      // Model a provider that finishes just as cancellation arrives.
      const id = crypto.randomUUID()
      receipts.add(id)
      return { id, artifact }
    },
    authorize: async () => false,
    confirm: async () => undefined,
    discard: async (_scope, id) => {
      receipts.delete(id)
      discarded()
    },
    pendingRoots: async () => ({ complete: true, roots: [] }),
  }
  const opened = await openSession({
    provider: fakeProvider([textTurn('saved')]),
    seams: fakeSeams({ artifacts: { attachments: store } }),
  })
  const intake = new OriginalUploads(opened.session as HostSession)
  const common = {
    sessionId: opened.session.key,
    laneId: opened.session.lane,
    destination: 'original' as const,
    uploadId: crypto.randomUUID(),
  }
  const bytes = new Uint8Array([42])
  const sha256 = new IncrementalSha256().update(bytes).digest()
  try {
    await intake.request({
      ...common,
      operation: 'start',
      name: 'cancel.bin',
      mimeType: 'application/octet-stream',
      size: 1,
    })
    const chunk = {
      ...common,
      operation: 'chunk' as const,
      offset: 0,
      data: Buffer.from(bytes).toString('base64'),
      sha256,
    }
    await intake.request(chunk)
    expect(await intake.request(chunk)).toEqual({ offset: 1 })
    const finishing = intake.request({ ...common, operation: 'finish', sha256 })
    const rejected = expect(finishing).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_CANCELLED' } })
    await reading
    await intake.request({ ...common, operation: 'cancel' })
    release()
    await rejected
    await removed
    await expect(intake.request(chunk)).rejects.toMatchObject({ data: { reason: 'ATTACHMENT_CANCELLED' } })
    expect(receipts.size).toBe(0)
  } finally {
    release()
    await intake.close()
    await opened.log.close()
  }
})
