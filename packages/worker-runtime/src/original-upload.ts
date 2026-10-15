import type { HostSession } from '@agnes/host'
import {
  AttachmentError,
  type AttachmentErrorCode,
  attachmentLink,
  decodeSafeImageBytes,
  FILE_UPLOAD_CHUNK_BYTES,
  type FileUploadRequest,
  type FileUploadResult,
  IncrementalSha256,
  rpcError,
  USER_IMAGE_ORIGINAL_LIMITS,
} from '@agnes/protocol'

type Upload = {
  name: string
  mime: string
  size: number
  offset: number
  chunks: Uint8Array[]
  sha: IncrementalSha256
  digest?: string
  deadline: number
  controller: AbortController
  finishing: boolean
  timer: ReturnType<typeof setTimeout>
}
const MAX_BYTES = 100 * 1024 * 1024
const QUOTA = 128 * 1024 * 1024
const TTL = 30 * 60_000

/** Session-owned intake only. Durable bytes, receipts and GC roots belong to artifacts. */
export class OriginalUploads {
  private closed = false
  private rows = new Map<string, Upload>()
  private publishingBytes = 0
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
      const scope = { sessionKey: session.key, lane: session.lane }
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
        this.rows.set(id, {
          timer,
          name: input.name,
          mime: input.mimeType,
          size: input.size,
          offset: 0,
          chunks: [],
          sha: new IncrementalSha256(),
          deadline: Date.now() + TTL,
          controller: new AbortController(),
          finishing: false,
        })
        return { offset: 0 }
      }
      if (input.operation === 'cancel') {
        await this.cancel(id)
        return {}
      }
      if (!row) throw new AttachmentError('ATTACHMENT_UNAVAILABLE')
      if (row.finishing) throw new AttachmentError('ATTACHMENT_DATA')
      if (input.operation === 'status') return { offset: row.offset }
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
        if (new IncrementalSha256().update(bytes).digest() !== input.sha256)
          throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
        if (input.offset < row.offset) {
          let at = 0
          for (const previous of row.chunks) {
            if (
              at === input.offset &&
              previous.length === bytes.length &&
              new IncrementalSha256().update(previous).digest() === input.sha256
            )
              return { offset: row.offset }
            at += previous.length
          }
          throw new AttachmentError('ATTACHMENT_DATA')
        }
        if (input.offset !== row.offset) throw new AttachmentError('ATTACHMENT_DATA')
        if (row.chunks.length >= 1024) throw new AttachmentError('ATTACHMENT_QUOTA')
        row.chunks.push(bytes)
        row.sha.update(bytes)
        row.offset += bytes.length
        return { offset: row.offset }
      }
      if (input.operation !== 'finish') throw new AttachmentError('ATTACHMENT_DATA')
      if (row.offset !== row.size) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      row.digest ??= row.sha.digest()
      if (row.digest !== input.sha256) throw new AttachmentError('ATTACHMENT_HASH_MISMATCH')
      row.finishing = true
      try {
        const signal = AbortSignal.any([row.controller.signal, AbortSignal.timeout(30_000)])
        const bytes = new Uint8Array(row.size)
        let at = 0
        for (const chunk of row.chunks) {
          bytes.set(chunk, at)
          at += chunk.length
        }
        row.chunks = []
        const image =
          session.computerUseAllowed() && /^image\/(png|jpeg)$/u.test(row.mime)
            ? decodeSafeImageBytes({ bytes, mimeType: row.mime }, USER_IMAGE_ORIGINAL_LIMITS)
            : undefined
        this.publishingBytes += row.size
        const storing = Promise.resolve()
          .then(() => store.store(scope, bytes, row.mime, signal))
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
              new AttachmentError(
                row.controller.signal.aborted ? 'ATTACHMENT_CANCELLED' : 'ATTACHMENT_TIMEOUT',
              ),
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
          throw new AttachmentError(
            row.controller.signal.aborted ? 'ATTACHMENT_CANCELLED' : 'ATTACHMENT_TIMEOUT',
          )
        }
        return {
          offset: row.size,
          attachment: attachmentLink(receipt.artifact, row.name, {
            receiptId: receipt.id,
            ...(image ? { image: { width: image.width, height: image.height } } : {}),
          }),
        }
      } finally {
        clearTimeout(row.timer)
        this.rows.delete(id)
        if (!this.ended.has(id) && this.ended.size < 1024) this.ended.set(id, 'ATTACHMENT_DATA')
      }
    } catch (error) {
      throw rpcError('SEMANTIC_REJECTED', {
        reason: error instanceof AttachmentError ? error.code : 'ATTACHMENT_DATA',
      })
    }
  }
  private async cancel(id: string, reason: AttachmentErrorCode = 'ATTACHMENT_CANCELLED') {
    const row = this.rows.get(id)
    if (row) {
      clearTimeout(row.timer)
      row.controller.abort()
      row.chunks = []
    }
    this.rows.delete(id)
    if (this.ended.size < 1024) this.ended.set(id, reason)
  }
  async close() {
    this.closed = true
    for (const id of this.rows.keys()) await this.cancel(id)
  }
}
