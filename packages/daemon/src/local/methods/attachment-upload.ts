import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type AttachmentStore, attachmentLimit, type StoredObject } from '@agnes/host'
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  type ContentBlock,
  rpcError,
  USER_ATTACHMENT_THUMBNAIL,
  USER_MESSAGE_IMAGE_LIMITS,
  validateUserAttachments,
} from '@agnes/protocol'
import { decodeSafeImageBytes } from '@agnes/protocol-validation'
import type { CallContext, LocalEndpoint } from '../endpoint.js'
import {
  createUploads,
  MAX_UPLOADS_PER_SESSION,
  type UploadPurpose,
  UploadRefused,
  type Uploads,
} from '../uploads.js'

/**
 * What the upload method needs, built once per daemon process and shared by every connection, so an
 * upload a dropped connection left behind resumes on the next one.
 */
export type AttachmentUploadService = Readonly<{
  store: AttachmentStore
  uploads: Uploads
  /** `attachments.max_upload_bytes`. */
  maxBytes(): number
}>

/** The upload service over one attachment store, with the profile's upload limit. */
export function createAttachmentUploadService(o: {
  store: AttachmentStore
  limits: Readonly<Record<string, number>>
  /** The user attachment port's reservation: room held against the quotas until the upload settles. */
  reserve(input: { add: number; sessionBytes: number }): Promise<(stored?: number) => void>
  clock?: () => number
  sweepEveryMs?: number
}): AttachmentUploadService {
  const maxBytes = () => attachmentLimit(o.limits, 'attachments.max_upload_bytes')
  return {
    store: o.store,
    uploads: createUploads({
      store: o.store,
      maxBytes,
      // The session's bytes already referenced are not known here; admission checks again with them.
      reserve: (size) => o.reserve({ add: size, sessionBytes: 0 }),
      ...(o.clock ? { clock: o.clock } : {}),
      ...(o.sweepEveryMs !== undefined ? { sweepEveryMs: o.sweepEveryMs } : {}),
    }),
    maxBytes,
  }
}

/** Chunks this process handles at once, over every upload and connection. */
const MAX_CHUNKS_IN_FLIGHT = 4
let chunksInFlight = 0

const NATIVE_IMAGE = new Set(['image/png', 'image/jpeg'])

type Params =
  | { operation: 'limits'; sessionId: string }
  | {
      operation: 'start'
      sessionId: string
      uploadId: string
      name: string
      mimeType: string
      size: number
      purpose?: UploadPurpose
    }
  | { operation: 'chunk'; sessionId: string; uploadId: string; offset: number; data: string; sha256: string }
  | { operation: 'status' | 'cancel'; sessionId: string; uploadId: string }
  | { operation: 'finish'; sessionId: string; uploadId: string; sha256?: string }

const refusal = (code: string) => rpcError('SEMANTIC_REJECTED', { code, reason: code })

/** Reads a committed image whole and checks its header. */
async function storedImage(
  store: AttachmentStore,
  object: StoredObject,
  mimeType: string,
  limits: Parameters<typeof decodeSafeImageBytes>[1],
) {
  const bytes = await store.read(object.sha256)
  try {
    return decodeSafeImageBytes({ bytes, mimeType }, limits)
  } catch {
    throw new UploadRefused('UPLOAD_NOT_IMAGE')
  }
}

const THUMBNAIL_EDGE = USER_ATTACHMENT_THUMBNAIL.maxEdge

/** A thumbnail must be a JPEG of at most 320 pixels a side; checked before anything is stored. */
function thumbnailImage(bytes: Uint8Array, mimeType: string) {
  if (mimeType !== 'image/jpeg' || bytes.byteLength === 0) throw new UploadRefused('UPLOAD_NOT_IMAGE')
  let image: ReturnType<typeof decodeSafeImageBytes>
  try {
    image = decodeSafeImageBytes(
      { bytes, mimeType: 'image/jpeg' },
      {
        maxBytesPerImage: USER_ATTACHMENT_THUMBNAIL.maxBytes,
        maxAggregateBytes: USER_ATTACHMENT_THUMBNAIL.maxBytes,
        maxPixelsPerImage: THUMBNAIL_EDGE * THUMBNAIL_EDGE,
        maxAggregatePixels: THUMBNAIL_EDGE * THUMBNAIL_EDGE,
      },
    )
  } catch {
    throw new UploadRefused('UPLOAD_NOT_IMAGE')
  }
  if (image.mime !== 'image/jpeg') throw new UploadRefused('UPLOAD_NOT_IMAGE')
  if (image.width > THUMBNAIL_EDGE || image.height > THUMBNAIL_EDGE)
    throw new UploadRefused('UPLOAD_SIZE_LIMIT')
  return image
}

/**
 * An object this upload stored and then refused (not a valid image) is removed again, so it takes no
 * room outside the quota. One that was stored before, or that something marked meanwhile, is kept.
 */
async function discardRefused(store: AttachmentStore, object: StoredObject, existed: boolean): Promise<void> {
  if (existed) return
  if (await store.userAttachment(object.sha256).catch(() => 'unknown')) return
  await rm(join(store.root, 'sha256', object.sha256.slice(0, 2), object.sha256), { force: true }).catch(
    () => undefined,
  )
}

/**
 * The finished upload as the client sends it on: a thumbnail's digest, size and dimensions, an image
 * reference with the dimensions read from its header, or a file reference. Every finished upload is
 * marked as a user attachment with this session's receipt, which is what lets the session reference it.
 */
async function finished(
  service: AttachmentUploadService,
  sessionId: string,
  done: {
    object: StoredObject
    name: string
    mimeType: string
    purpose: UploadPurpose
    existed: boolean
    thumbnail?: { width: number; height: number }
  },
): Promise<ContentBlock | { sha256: string; bytes: number; width: number; height: number }> {
  const { object, name, mimeType, purpose } = done
  if (purpose === 'thumbnail') {
    // Checked before it was stored (see `finish`).
    const image = done.thumbnail as { width: number; height: number }
    await service.store.markUserAttachment(object, { mimeType: 'image/jpeg', receiptFor: sessionId })
    return { sha256: object.sha256, bytes: object.bytes, width: image.width, height: image.height }
  }
  const attachment = { sha256: object.sha256, bytes: object.bytes }
  // A PNG or JPEG is an image reference when it can be one; a larger one is sent on as a file.
  if (NATIVE_IMAGE.has(mimeType) && object.bytes <= USER_MESSAGE_IMAGE_LIMITS.maxBytesPerImage) {
    let image: Awaited<ReturnType<typeof storedImage>>
    try {
      image = await storedImage(service.store, object, mimeType, USER_MESSAGE_IMAGE_LIMITS)
    } catch (error) {
      await discardRefused(service.store, object, done.existed)
      throw error
    }
    await service.store.markUserAttachment(object, { mimeType: image.mime, receiptFor: sessionId })
    return {
      type: 'image',
      mimeType: image.mime,
      attachment,
      width: image.width,
      height: image.height,
      name,
    } as ContentBlock
  }
  await service.store.markUserAttachment(object, { mimeType, receiptFor: sessionId })
  return { type: 'file', mimeType, name, attachment } as ContentBlock
}

/**
 * `_agnes/v1/attachment.upload`: chunked uploads over the client connection, for the session's owner
 * only (the same check as `session.attachmentRead`). Nothing reaches a session's ledger here; the
 * reference block it returns is what the client then sends, and admission checks it like any other.
 */
export function registerAttachmentUpload(
  ep: LocalEndpoint,
  requireOwner: (method: string, sessionId: string, call: CallContext) => void,
  service: AttachmentUploadService | undefined,
): void {
  ep.register('_agnes/v1/attachment.upload', async (params, call) => {
    const p = params as Params
    requireOwner('attachment.upload', p.sessionId, call)
    if (!service) throw refusal('UPLOAD_UNAVAILABLE')
    const principalId = call.conn.principalId
    const base = { sessionId: p.sessionId, principalId }
    try {
      switch (p.operation) {
        case 'limits':
          return {
            limits: {
              maxBytes: service.maxBytes(),
              chunkBytes: ATTACHMENT_UPLOAD_CHUNK_BYTES,
              maxConcurrent: MAX_UPLOADS_PER_SESSION,
            },
          }
        case 'start': {
          const purpose = p.purpose ?? 'attachment'
          if (purpose === 'attachment') {
            // The name and type must be ones a reference block may carry, or the prompt is refused later.
            try {
              validateUserAttachments([
                {
                  type: 'file',
                  mimeType: p.mimeType,
                  name: p.name,
                  attachment: { sha256: '0'.repeat(64), bytes: p.size },
                } as ContentBlock,
              ])
            } catch {
              throw new UploadRefused('UPLOAD_INVALID')
            }
          }
          return await service.uploads.start({
            ...base,
            uploadId: p.uploadId,
            name: p.name,
            mimeType: p.mimeType,
            size: p.size,
            purpose,
          })
        }
        case 'chunk': {
          if (chunksInFlight >= MAX_CHUNKS_IN_FLIGHT) throw new UploadRefused('UPLOAD_BUSY')
          chunksInFlight++
          try {
            return await service.uploads.chunk({
              ...base,
              uploadId: p.uploadId,
              offset: p.offset,
              data: p.data,
              sha256: p.sha256,
            })
          } finally {
            chunksInFlight--
          }
        }
        case 'status':
          return await service.uploads.status({ ...base, uploadId: p.uploadId })
        case 'cancel':
          return await service.uploads.cancel({ ...base, uploadId: p.uploadId })
        case 'finish': {
          let thumbnail: { width: number; height: number } | undefined
          const done = await service.uploads.finish(
            { ...base, uploadId: p.uploadId, ...(p.sha256 ? { sha256: p.sha256 } : {}) },
            (bytes, mimeType) => {
              const image = thumbnailImage(bytes, mimeType)
              thumbnail = { width: image.width, height: image.height }
            },
          )
          // Counted only when this upload wrote the object's first marker; bytes stored before are counted.
          const known = await service.store.userAttachment(done.object.sha256).catch(() => undefined)
          let attachment: Awaited<ReturnType<typeof finished>>
          try {
            attachment = await finished(service, p.sessionId, {
              ...done,
              ...(thumbnail ? { thumbnail } : {}),
            })
          } catch (error) {
            done.settle()
            throw error
          }
          done.settle(known ? 0 : done.object.bytes)
          return { offset: done.object.bytes, attachment }
        }
        default:
          throw new UploadRefused('UPLOAD_INVALID')
      }
    } catch (error) {
      if (error instanceof UploadRefused) throw refusal(error.code)
      const code = (error as { code?: unknown } | null)?.code
      // The store's own refusals are named; anything else (a raw file system error naming paths in the
      // data directory) is reported as unavailable.
      if (code === 'ATTACHMENT_TOO_LARGE') throw refusal('UPLOAD_SIZE_LIMIT')
      if (code === 'ATTACHMENT_TIMEOUT' || code === 'ATTACHMENT_STAGE_CLOSED')
        throw refusal('UPLOAD_UNAVAILABLE')
      if ((error as { data?: unknown } | null)?.data !== undefined) throw error
      throw refusal('UPLOAD_UNAVAILABLE')
    }
  })
}
