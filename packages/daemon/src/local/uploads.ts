import { createHash } from 'node:crypto'
import type { AttachmentStaging, AttachmentStore, StoredObject } from '@agnes/host'
import { ATTACHMENT_UPLOAD_CHUNK_BYTES, USER_ATTACHMENT_THUMBNAIL } from '@agnes/protocol'

export type UploadErrorCode =
  | 'UPLOAD_INVALID'
  | 'UPLOAD_SIZE_LIMIT'
  | 'UPLOAD_OFFSET'
  | 'UPLOAD_HASH_MISMATCH'
  | 'UPLOAD_INCOMPLETE'
  | 'UPLOAD_CANCELLED'
  | 'UPLOAD_BUSY'
  | 'UPLOAD_EXPIRED'
  | 'UPLOAD_QUOTA'
  | 'UPLOAD_UNAVAILABLE'
  | 'UPLOAD_NOT_IMAGE'

/** A refused upload step; the RPC answers it as SEMANTIC_REJECTED with this code. */
export class UploadRefused extends Error {
  constructor(readonly code: UploadErrorCode) {
    super(code)
    this.name = 'UploadRefused'
  }
}

export type UploadPurpose = 'attachment' | 'thumbnail'

type Upload = {
  id: string
  sessionId: string
  principalId: string
  name: string
  mimeType: string
  size: number
  purpose: UploadPurpose
  staging: AttachmentStaging
  touched: number
  lastChunk?: { offset: number; sha256: string }
  /** Gives back the room held for the upload, counting what it stored. */
  settle(stored?: number): void
  /** Steps of one upload run one after another, in the order they arrived. */
  tail: Promise<unknown>
  cancelled: boolean
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
/** An upload with no step for this long is dropped, and its staged bytes with it. */
export const UPLOAD_EXPIRE_MS = 30 * 60_000
export const MAX_UPLOADS_PER_SESSION = 4

export type Uploads = ReturnType<typeof createUploads>

/**
 * In-flight uploads of this daemon: in order, one chunk at a time per upload, hashed as they arrive,
 * written to a staging file and committed to the attachment store at finish. Resume state lives only
 * here; after a restart an unfinished upload is gone and its staging file is swept later.
 */
export function createUploads(o: {
  store: AttachmentStore
  maxBytes: () => number
  /** Holds room for `size` bytes against the quotas until settled; rejects with `code: 'UPLOAD_QUOTA'`. */
  reserve?: (size: number) => Promise<(stored?: number) => void>
  clock?: () => number
}) {
  const clock = o.clock ?? (() => Date.now())
  const uploads = new Map<string, Upload>()
  const key = (sessionId: string, id: string) => `${sessionId}\u0000${id}`
  const drop = async (k: string, u: Upload) => {
    if (uploads.get(k) === u) uploads.delete(k)
    u.cancelled = true
    await u.tail
    u.settle()
    await u.staging.abort().catch(() => undefined)
  }
  const sweep = async () => {
    const now = clock()
    for (const [k, u] of uploads) if (now - u.touched > UPLOAD_EXPIRE_MS) await drop(k, u)
  }
  const find = async (sessionId: string, id: string, principalId: string): Promise<Upload> => {
    await sweep()
    if (!ID.test(id)) throw new UploadRefused('UPLOAD_INVALID')
    const u = uploads.get(key(sessionId, id))
    if (!u) throw new UploadRefused('UPLOAD_EXPIRED')
    // Another principal's upload is not told apart from a missing one.
    if (u.principalId !== principalId) throw new UploadRefused('UPLOAD_EXPIRED')
    return u
  }
  /** Runs one step after the upload's earlier steps, refusing it once the upload was cancelled. */
  const step = <T>(u: Upload, run: () => Promise<T>): Promise<T> => {
    const next = u.tail.then(() => {
      if (u.cancelled) throw new UploadRefused('UPLOAD_CANCELLED')
      u.touched = clock()
      return run()
    })
    u.tail = next.catch(() => undefined)
    return next
  }
  return {
    async start(i: {
      sessionId: string
      uploadId: string
      principalId: string
      name: string
      mimeType: string
      size: number
      purpose: UploadPurpose
    }): Promise<{ offset: number }> {
      await sweep()
      if (!ID.test(i.uploadId)) throw new UploadRefused('UPLOAD_INVALID')
      const existing = uploads.get(key(i.sessionId, i.uploadId))
      if (existing) {
        if (
          existing.principalId !== i.principalId ||
          existing.size !== i.size ||
          existing.purpose !== i.purpose ||
          existing.name !== i.name ||
          existing.mimeType !== i.mimeType
        )
          throw new UploadRefused('UPLOAD_INVALID')
        return step(existing, async () => ({ offset: existing.staging.bytes }))
      }
      const limit = i.purpose === 'thumbnail' ? USER_ATTACHMENT_THUMBNAIL.maxBytes : o.maxBytes()
      if (!Number.isSafeInteger(i.size) || i.size < 0 || i.size > limit)
        throw new UploadRefused('UPLOAD_SIZE_LIMIT')
      if ([...uploads.values()].filter((u) => u.sessionId === i.sessionId).length >= MAX_UPLOADS_PER_SESSION)
        throw new UploadRefused('UPLOAD_BUSY')
      // The session's bytes already referenced are not known here; admission checks again with them.
      let settle: (stored?: number) => void = () => undefined
      if (o.reserve)
        try {
          settle = await o.reserve(i.size)
        } catch (error) {
          throw new UploadRefused(
            (error as { code?: unknown }).code === 'UPLOAD_QUOTA' ? 'UPLOAD_QUOTA' : 'UPLOAD_UNAVAILABLE',
          )
        }
      let staging: AttachmentStaging
      try {
        staging = await o.store.stage({
          kind: i.purpose === 'thumbnail' ? 'thumbnail' : 'user-attachment',
          mimeType: i.mimeType,
          maxBytes: i.size,
        })
      } catch (error) {
        settle()
        throw error
      }
      // Checked again: another start for the same id may have opened while this one waited.
      if (uploads.has(key(i.sessionId, i.uploadId))) {
        settle()
        await staging.abort().catch(() => undefined)
        throw new UploadRefused('UPLOAD_BUSY')
      }
      uploads.set(key(i.sessionId, i.uploadId), {
        id: i.uploadId,
        sessionId: i.sessionId,
        principalId: i.principalId,
        name: i.name,
        mimeType: i.mimeType,
        size: i.size,
        purpose: i.purpose,
        staging,
        settle,
        touched: clock(),
        tail: Promise.resolve(),
        cancelled: false,
      })
      return { offset: 0 }
    },
    async chunk(i: {
      sessionId: string
      uploadId: string
      principalId: string
      offset: number
      data: string
      sha256: string
    }): Promise<{ offset: number }> {
      const u = await find(i.sessionId, i.uploadId, i.principalId)
      return step(u, async () => {
        if (!SHA.test(i.sha256)) throw new UploadRefused('UPLOAD_INVALID')
        // The same chunk again (its answer was lost): nothing to write, report where the upload is.
        if (u.lastChunk && i.offset === u.lastChunk.offset && i.sha256 === u.lastChunk.sha256)
          return { offset: u.staging.bytes }
        if (i.offset !== u.staging.bytes) throw new UploadRefused('UPLOAD_OFFSET')
        const bytes = Buffer.from(i.data, 'base64')
        if (bytes.byteLength === 0 || bytes.byteLength > ATTACHMENT_UPLOAD_CHUNK_BYTES)
          throw new UploadRefused('UPLOAD_INVALID')
        if (createHash('sha256').update(bytes).digest('hex') !== i.sha256)
          throw new UploadRefused('UPLOAD_HASH_MISMATCH')
        if (u.staging.bytes + bytes.byteLength > u.size) throw new UploadRefused('UPLOAD_SIZE_LIMIT')
        await u.staging.write(bytes)
        u.lastChunk = { offset: i.offset, sha256: i.sha256 }
        return { offset: u.staging.bytes }
      })
    },
    async status(i: {
      sessionId: string
      uploadId: string
      principalId: string
    }): Promise<{ offset: number }> {
      const u = await find(i.sessionId, i.uploadId, i.principalId)
      return step(u, async () => ({ offset: u.staging.bytes }))
    },
    async cancel(i: { sessionId: string; uploadId: string; principalId: string }): Promise<object> {
      await sweep()
      const k = key(i.sessionId, i.uploadId)
      const u = uploads.get(k)
      if (u && u.principalId === i.principalId) await drop(k, u)
      return {}
    },
    /**
     * Commits the staged bytes; the caller turns the stored object into the reply block and then calls
     * `settle` with the bytes it newly stored (or nothing when it refused the object).
     */
    async finish(i: { sessionId: string; uploadId: string; principalId: string; sha256?: string }): Promise<{
      object: StoredObject
      name: string
      mimeType: string
      purpose: UploadPurpose
      settle(stored?: number): void
    }> {
      const k = key(i.sessionId, i.uploadId)
      const u = await find(i.sessionId, i.uploadId, i.principalId)
      return step(u, async () => {
        if (u.staging.bytes !== u.size) throw new UploadRefused('UPLOAD_INCOMPLETE')
        if (i.sha256 !== undefined && !SHA.test(i.sha256)) throw new UploadRefused('UPLOAD_INVALID')
        if (uploads.get(k) === u) uploads.delete(k)
        u.cancelled = true
        try {
          const object = await u.staging.commit(i.sha256)
          return { object, name: u.name, mimeType: u.mimeType, purpose: u.purpose, settle: u.settle }
        } catch (error) {
          u.settle()
          if ((error as { code?: unknown }).code === 'ATTACHMENT_HASH_MISMATCH')
            throw new UploadRefused('UPLOAD_HASH_MISMATCH')
          throw error
        }
      })
    },
    /** In-flight uploads; for tests and diagnostics. */
    get size(): number {
      return uploads.size
    },
  }
}
