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
  /** The last start or chunk; a status query does not keep an upload alive. */
  touched: number
  /** When the upload started; it is dropped this long after whatever it does. */
  started: number
  /** A thumbnail's bytes as they arrive (at most 256 KiB), so they can be checked before they are stored. */
  buffered?: Buffer[]
  /** The digest of the bytes received so far, to tell at finish whether the object was already stored. */
  hash: ReturnType<typeof createHash>
  lastChunk?: { offset: number; sha256: string }
  /** Gives back the room held for the upload, counting what it stored. */
  settle(stored?: number): void
  /** Steps of one upload run one after another, in the order they arrived. */
  tail: Promise<unknown>
  cancelled: boolean
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
/** An upload with no start or chunk for this long is dropped, and its staged bytes with it. */
export const UPLOAD_EXPIRE_MS = 30 * 60_000
/** However active, an upload is dropped this long after it started. */
export const UPLOAD_LIFETIME_MS = 6 * 60 * 60_000
/** How often idle uploads are looked for when no request arrives. */
export const UPLOAD_SWEEP_MS = 60_000
export const MAX_UPLOADS_PER_SESSION = 4
/** Open uploads of one principal over all its sessions, and of the whole process. */
export const MAX_UPLOADS_PER_PRINCIPAL = 16
export const MAX_UPLOADS_PER_PROCESS = 64

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
  /** Interval of the idle sweep; 0 turns the timer off (requests still sweep). */
  sweepEveryMs?: number
}) {
  const clock = o.clock ?? (() => Date.now())
  const uploads = new Map<string, Upload>()
  /**
   * Starts between their checks and their entry in `uploads`: counted against the caps at once, so
   * starts racing through the awaits below cannot pass a cap together.
   */
  const starting = new Map<string, { sessionId: string; principalId: string }>()
  const key = (sessionId: string, id: string) => `${sessionId}\u0000${id}`
  const open = () => [...uploads.values(), ...starting.values()]
  const drop = async (k: string, u: Upload) => {
    if (uploads.get(k) === u) uploads.delete(k)
    u.cancelled = true
    await u.tail
    u.settle()
    await u.staging.abort().catch(() => undefined)
  }
  /** Drops an upload from inside one of its own steps, which must not wait for its own tail. */
  const failed = (sessionId: string, id: string, u: Upload) => {
    const k = key(sessionId, id)
    if (uploads.get(k) === u) uploads.delete(k)
    u.cancelled = true
    u.settle()
    void u.staging.abort().catch(() => undefined)
  }
  const sweep = async () => {
    const now = clock()
    for (const [k, u] of uploads)
      if (now - u.touched > UPLOAD_EXPIRE_MS || now - u.started > UPLOAD_LIFETIME_MS) await drop(k, u)
  }
  // Abandoned uploads are reclaimed even when no further upload request arrives.
  const timer =
    (o.sweepEveryMs ?? UPLOAD_SWEEP_MS) > 0
      ? setInterval(() => void sweep().catch(() => undefined), o.sweepEveryMs ?? UPLOAD_SWEEP_MS)
      : undefined
  timer?.unref?.()
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
  const step = <T>(u: Upload, run: () => Promise<T>, touch = false): Promise<T> => {
    const next = u.tail.then(() => {
      if (u.cancelled) throw new UploadRefused('UPLOAD_CANCELLED')
      if (touch) u.touched = clock()
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
        return step(existing, async () => ({ offset: existing.staging.bytes }), true)
      }
      if (starting.has(key(i.sessionId, i.uploadId))) throw new UploadRefused('UPLOAD_BUSY')
      const limit = i.purpose === 'thumbnail' ? USER_ATTACHMENT_THUMBNAIL.maxBytes : o.maxBytes()
      if (!Number.isSafeInteger(i.size) || i.size < 0 || i.size > limit)
        throw new UploadRefused('UPLOAD_SIZE_LIMIT')
      // Each open upload holds a staging file and room in the quota: bounded per session, per principal
      // and per process. The slot is taken before the first await, so concurrent starts count each other.
      const all = open()
      if (
        all.filter((u) => u.sessionId === i.sessionId).length >= MAX_UPLOADS_PER_SESSION ||
        all.filter((u) => u.principalId === i.principalId).length >= MAX_UPLOADS_PER_PRINCIPAL ||
        all.length >= MAX_UPLOADS_PER_PROCESS
      )
        throw new UploadRefused('UPLOAD_BUSY')
      const k = key(i.sessionId, i.uploadId)
      starting.set(k, { sessionId: i.sessionId, principalId: i.principalId })
      let settle: (stored?: number) => void = () => undefined
      let staging: AttachmentStaging
      try {
        // The session's bytes already referenced are not known here, so the per-session quota is enforced
        // only when the upload is sent (admission checks again with them): a session near its quota can
        // still stage an upload that its send then refuses. The global quota and free space hold here.
        if (o.reserve)
          try {
            settle = await o.reserve(i.size)
          } catch (error) {
            throw new UploadRefused(
              (error as { code?: unknown }).code === 'UPLOAD_QUOTA' ? 'UPLOAD_QUOTA' : 'UPLOAD_UNAVAILABLE',
            )
          }
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
      } finally {
        starting.delete(k)
      }
      const now = clock()
      uploads.set(k, {
        id: i.uploadId,
        sessionId: i.sessionId,
        principalId: i.principalId,
        name: i.name,
        mimeType: i.mimeType,
        size: i.size,
        purpose: i.purpose,
        staging,
        settle,
        touched: now,
        started: now,
        hash: createHash('sha256'),
        ...(i.purpose === 'thumbnail' ? { buffered: [] } : {}),
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
      return step(
        u,
        async () => {
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
          try {
            await u.staging.write(bytes)
          } catch (error) {
            // The store closed the stage (a full disk, an I/O error, the write's deadline): the upload
            // cannot go on, so it is dropped here, giving back its room and its slot, rather than kept
            // alive by the client's retries. This chunk is answered `UPLOAD_UNAVAILABLE`, later steps
            // `UPLOAD_EXPIRED`; the client starts the upload again from its first byte.
            failed(i.sessionId, i.uploadId, u)
            throw error
          }
          u.buffered?.push(bytes)
          u.hash.update(bytes)
          u.lastChunk = { offset: i.offset, sha256: i.sha256 }
          return { offset: u.staging.bytes }
        },
        true,
      )
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
     * `settle` with the bytes it newly stored (or nothing when it refused the object). A thumbnail's
     * bytes are given to `inspect` first, and a refusal there stores nothing.
     */
    async finish(
      i: { sessionId: string; uploadId: string; principalId: string; sha256?: string },
      inspect?: (thumbnail: Uint8Array, mimeType: string) => Promise<void> | void,
    ): Promise<{
      object: StoredObject
      name: string
      mimeType: string
      purpose: UploadPurpose
      /** Whether the store held these bytes before this upload committed them. */
      existed: boolean
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
          if (u.buffered && inspect) await inspect(Buffer.concat(u.buffered), u.mimeType)
        } catch (error) {
          u.settle()
          await u.staging.abort().catch(() => undefined)
          throw error
        }
        try {
          const sha256 = u.hash.digest('hex')
          // Bytes already stored as a user attachment are marked as seen before this upload relies on
          // them, as a send does: the attachment sweep judges the mark once more before it deletes.
          const marker = await o.store.userAttachment(sha256).catch(() => undefined)
          if (marker)
            await o.store
              .markUserAttachment({ sha256, bytes: marker.bytes }, { mimeType: marker.mimeType })
              .catch(() => undefined)
          const existed = (await o.store.stat(sha256).catch(() => undefined)) !== undefined
          const object = await u.staging.commit(i.sha256)
          return { object, name: u.name, mimeType: u.mimeType, purpose: u.purpose, existed, settle: u.settle }
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
    /** Stops the idle sweep and drops every open upload, closing its staging file. */
    async dispose(): Promise<void> {
      if (timer) clearInterval(timer)
      for (const [k, u] of uploads) await drop(k, u)
    },
  }
}
