import { createHash, type Hash } from 'node:crypto'
import type { HostSession } from '@agnes/host'
import {
  AttachmentError,
  type AttachmentErrorCode,
  attachmentLink,
  decodeSafeImageBytes,
  FILE_UPLOAD_CHUNK_BYTES,
  type FileUploadRequest,
  type FileUploadResult,
  rpcError,
  USER_IMAGE_ORIGINAL_LIMITS,
} from '@agnes/protocol'
import { UploadSpool } from './upload-spool.js'

type Upload = {
  name: string
  mime: string
  size: number
  offset: number
  chunks: Map<number, { size: number; sha256: string }>
  spool: Promise<UploadSpool>
  writing?: Promise<void>
  sha: Hash
  digest?: string
  deadline: number
  controller: AbortController
  finishing: boolean
  timer: ReturnType<typeof setTimeout>
}
const MAX_BYTES = 100 * 1024 * 1024
const QUOTA = 128 * 1024 * 1024
const TTL = 30 * 60_000
const BUSY = new Error('UPLOAD_BUSY')

/** Session-owned intake only. Durable bytes, receipts and GC roots belong to artifacts. */
export class OriginalUploads {
  private closed = false
  private rows = new Map<string, Upload>()
  private publishingBytes = 0
  private publications = new Set<Promise<FileUploadResult>>()
  private ended = new Map<string, AttachmentErrorCode>()
  constructor(private session: HostSession) {}
  async request(input: FileUploadRequest): Promise<FileUploadResult> {
    try {
      const session = this.session
      if (this.closed || session.d.log.isClosed) throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      if (input.sessionId !== session.key || input.laneId !== session.lane)
        throw new AttachmentError('ATTACHMENT_NOT_AUTHORIZED')
      const store = session.d.runtime.attachmentStore()
      if (!store) throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      for (const [id, row] of this.rows)
        if (row.deadline <= Date.now()) await this.cancel(id, 'ATTACHMENT_TIMEOUT')
      if (this.closed) throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      if (input.operation === 'limits')
        return { limits: { maxBytes: MAX_BYTES, chunkBytes: FILE_UPLOAD_CHUNK_BYTES, allowedMimeTypes: [] } }
      const id = input.uploadId
      if (!/^[a-f0-9-]{36}$/u.test(id)) throw new AttachmentError('ATTACHMENT_DATA')
      const ended = this.ended.get(id)
      if (ended) {
        if (input.operation === 'cancel' && ended !== 'ATTACHMENT_DATA') return {}
        throw new AttachmentError(ended)
      }
      const row = this.rows.get(id)
      if (input.operation === 'start') {
        if (
          !Number.isSafeInteger(input.size) ||
          input.size < 0 ||
          input.size > MAX_BYTES ||
          (session.computerUseAllowed() &&
            /^image\/(png|jpeg)$/u.test(input.mimeType) &&
            input.size > USER_IMAGE_ORIGINAL_LIMITS.maxBytesPerImage)
        )
          throw new AttachmentError('ATTACHMENT_BYTES')
        if (
          !input.name ||
          input.name.length > 256 ||
          [...input.name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          input.mimeType.length > 128 ||
          !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(input.mimeType)
        )
          throw new AttachmentError('ATTACHMENT_DATA')
        if (row) {
          if (
            row.size !== input.size ||
            row.mime !== input.mimeType ||
            row.name !== input.name ||
            row.finishing
          )
            throw new AttachmentError('ATTACHMENT_DATA')
          return { offset: row.offset }
        }
        if (
          this.rows.size >= 4 ||
          this.ended.size >= 1024 ||
          [...this.rows.values()].reduce((n, r) => n + r.size, input.size + this.publishingBytes) > QUOTA
        )
          throw new AttachmentError('ATTACHMENT_QUOTA')
        const timer = setTimeout(() => {
          void this.cancel(id, 'ATTACHMENT_TIMEOUT').catch(() => undefined)
        }, TTL)
        timer.unref?.()
        const upload: Upload = {
          timer,
          name: input.name,
          mime: input.mimeType,
          size: input.size,
          offset: 0,
          chunks: new Map(),
          spool: UploadSpool.create(),
          sha: createHash('sha256'),
          deadline: Date.now() + TTL,
          controller: new AbortController(),
          finishing: false,
        }
        this.rows.set(id, upload)
        // Observe creation failures here; cancel/close also await the same owned resource.
        try {
          await upload.spool
        } catch (error) {
          await this.cancel(id).catch(() => undefined)
          throw error
        }
        if (this.closed || this.ended.has(id)) throw new AttachmentError('ATTACHMENT_CANCELLED')
        return { offset: 0 }
      }
      if (input.operation === 'cancel') {
        await this.cancel(id)
        return {}
      }
      if (!row) throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      if (row.finishing) throw new AttachmentError('ATTACHMENT_DATA')
      if (input.operation === 'status') return { offset: row.offset }
      if (row.writing) throw BUSY
      if (input.operation === 'chunk') {
        if (input.data.length > Math.ceil(FILE_UPLOAD_CHUNK_BYTES / 3) * 4)
          throw new AttachmentError('ATTACHMENT_BYTES')
        const bytes = Buffer.from(input.data, 'base64')
        if (
          !bytes.length ||
          bytes.length > FILE_UPLOAD_CHUNK_BYTES ||
          bytes.toString('base64') !== input.data ||
          !Number.isSafeInteger(input.offset) ||
          input.offset < 0 ||
          input.offset + bytes.length > row.size
        )
          throw new AttachmentError('ATTACHMENT_DATA')
        if (createHash('sha256').update(bytes).digest('hex') !== input.sha256)
          throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
        if (input.offset < row.offset) {
          const previous = row.chunks.get(input.offset)
          if (previous?.size === bytes.length && previous.sha256 === input.sha256)
            return { offset: row.offset }
          throw new AttachmentError('ATTACHMENT_DATA')
        }
        if (input.offset !== row.offset) throw new AttachmentError('ATTACHMENT_DATA')
        if (row.chunks.size >= 1024) throw new AttachmentError('ATTACHMENT_QUOTA')
        row.writing = (async () => {
          const spool = await row.spool
          if (row.controller.signal.aborted) throw new AttachmentError('ATTACHMENT_CANCELLED')
          await spool.append(bytes, row.offset)
          if (row.controller.signal.aborted) throw new AttachmentError('ATTACHMENT_CANCELLED')
          row.chunks.set(row.offset, { size: bytes.length, sha256: input.sha256 })
          row.sha.update(bytes)
          row.offset += bytes.length
        })()
        try {
          await row.writing
        } finally {
          delete row.writing
        }
        return { offset: row.offset }
      }
      if (input.operation !== 'finish') throw new AttachmentError('ATTACHMENT_DATA')
      if (row.offset !== row.size) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      row.digest ??= row.sha.digest('hex')
      if (row.digest !== input.sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      row.finishing = true
      const publication = this.publish(row, store).finally(async () => {
        clearTimeout(row.timer)
        this.rows.delete(id)
        if (!this.ended.has(id) && this.ended.size < 1024) this.ended.set(id, 'ATTACHMENT_DATA')
        await (await row.spool).close()
      })
      this.publications.add(publication)
      try {
        return await publication
      } finally {
        this.publications.delete(publication)
      }
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', {
        reason:
          error === BUSY ? 'UPLOAD_BUSY' : error instanceof AttachmentError ? error.code : 'ATTACHMENT_DATA',
      })
    }
  }
  private async publish(
    row: Upload,
    store: NonNullable<ReturnType<HostSession['d']['runtime']['attachmentStore']>>,
  ): Promise<FileUploadResult> {
    const session = this.session
    const scope = { sessionKey: session.key, lane: session.lane }
    const digest = row.digest
    if (!digest) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
    const signal = AbortSignal.any([row.controller.signal, AbortSignal.timeout(30_000)])
    const spool = await row.spool
    // Native image preflight has its own smaller byte cap. Ordinary originals never materialize.
    const imageBytes =
      session.computerUseAllowed() && /^image\/(png|jpeg)$/u.test(row.mime)
        ? await spool.bytes(row.size, signal)
        : undefined
    const image = imageBytes
      ? decodeSafeImageBytes({ bytes: imageBytes, mimeType: row.mime }, USER_IMAGE_ORIGINAL_LIMITS)
      : undefined
    this.publishingBytes += row.size
    const storing = Promise.resolve()
      .then(async () =>
        store.storeStream
          ? store.storeStream(
              scope,
              spool.source(row.size, signal),
              { sha256: digest, size: row.size, mime: row.mime },
              signal,
            )
          : store.store(scope, await spool.bytes(row.size, signal), row.mime, signal),
      )
      .finally(() => {
        this.publishingBytes -= row.size
      })
    void storing
      .then(async (receipt) => {
        if (signal.aborted) await store.discard(scope, receipt.id)
      })
      .catch(() => undefined)
    const receipt = await new Promise<Awaited<typeof storing>>((resolve, reject) => {
      const abort = () =>
        reject(
          new AttachmentError(row.controller.signal.aborted ? 'ATTACHMENT_CANCELLED' : 'ATTACHMENT_TIMEOUT'),
        )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      storing.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
    if (
      receipt.artifact.sha256 !== row.digest ||
      receipt.artifact.size !== row.size ||
      receipt.artifact.mime !== row.mime
    ) {
      await store.discard(scope, receipt.id)
      throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
    }
    if (signal.aborted) {
      await store.discard(scope, receipt.id)
      throw new AttachmentError(row.controller.signal.aborted ? 'ATTACHMENT_CANCELLED' : 'ATTACHMENT_TIMEOUT')
    }
    return {
      offset: row.size,
      attachment: attachmentLink(receipt.artifact, row.name, {
        receiptId: receipt.id,
        ...(image ? { image: { width: image.width, height: image.height } } : {}),
      }),
    }
  }
  private async cancel(id: string, reason: AttachmentErrorCode = 'ATTACHMENT_CANCELLED') {
    const row = this.rows.get(id)
    this.rows.delete(id)
    if (this.ended.size < 1024) this.ended.set(id, reason)
    if (row) {
      clearTimeout(row.timer)
      row.controller.abort()
      row.chunks.clear()
      if (!row.finishing) {
        await row.writing?.catch(() => undefined)
        await (await row.spool).close()
      }
    }
  }
  async close() {
    this.closed = true
    for (const id of this.rows.keys()) await this.cancel(id)
    await Promise.allSettled(this.publications)
  }
}
