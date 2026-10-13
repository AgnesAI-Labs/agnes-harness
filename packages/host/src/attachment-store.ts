import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AttachmentKind = 'user-attachment' | 'request-version' | 'thumbnail'
export type StoredObject = Readonly<{ sha256: string; bytes: number }>
export type UserAttachmentMarker = Readonly<{
  schemaVersion: 1
  sha256: string
  bytes: number
  mimeType: string
  firstSeenMs: number
  receipts: readonly string[]
}>
export type AttachmentStoreErrorCode =
  | 'ATTACHMENT_HASH_MISMATCH'
  | 'ATTACHMENT_MISSING'
  | 'ATTACHMENT_CORRUPT'
  | 'ATTACHMENT_TOO_LARGE'
  | 'ATTACHMENT_TIMEOUT'
  | 'ATTACHMENT_STAGE_CLOSED'
  | 'ATTACHMENT_INVALID_ID'

export class AttachmentStoreError extends Error {
  constructor(
    readonly code: AttachmentStoreErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = 'AttachmentStoreError'
  }
}

export interface AttachmentStaging {
  readonly bytes: number
  write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>
  commit(expectedSha256?: string): Promise<StoredObject>
  abort(): Promise<void>
}

export interface AttachmentStore {
  readonly root: string
  stage(meta: { kind: AttachmentKind; mimeType: string; maxBytes?: number }): Promise<AttachmentStaging>
  put(bytes: Uint8Array, meta: { kind: AttachmentKind; mimeType: string }): Promise<StoredObject>
  stat(sha256: string): Promise<StoredObject | undefined>
  read(sha256: string, range?: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
  markUserAttachment(object: StoredObject, meta: { mimeType: string; receiptFor?: string }): Promise<void>
  userAttachment(sha256: string): Promise<UserAttachmentMarker | undefined>
  sweepStaging(nowMs: number): Promise<number>
}

const SHA256 = /^[0-9a-f]{64}$/u
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MIB = 1024 * 1024

/** At least 10 s, plus 2 s for every started MiB: the bound on one put, stage write or commit. */
export function attachmentDeadlineMs(bytes: number): number {
  return Math.max(10_000, Math.ceil(bytes / MIB) * 2_000)
}

/** The opaque per-session token kept in a marker; the session key itself never reaches the store. */
export function attachmentReceiptFor(sessionKey: string): string {
  return createHash('sha256').update(sessionKey, 'utf8').digest('hex').slice(0, 32)
}

async function withDeadline<T>(
  ms: number,
  run: () => Promise<T>,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = run()
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void onTimeout().finally(() => reject(new AttachmentStoreError('ATTACHMENT_TIMEOUT')))
    }, ms)
  })
  work.catch(() => undefined)
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

function checkId(sha256: string): void {
  if (!SHA256.test(sha256)) throw new AttachmentStoreError('ATTACHMENT_INVALID_ID')
}

async function ensureDir(path: string): Promise<void> {
  // Node ignores the mode on Windows, where the data directory's ACL applies.
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/**
 * Content-addressed attachment bytes beside the session database, in the same tree the bundled
 * artifact store and the artifact read RPC already use. Writes stream through a staging file whose
 * digest is computed as the bytes arrive; commit syncs it and renames it into place, so a crash
 * leaves either a stray staging file or a complete object, never a partial object.
 */
export function createAttachmentStore(o: {
  dataDir: string
  clock?: () => number
  verifyOnceAtBytes?: number
  /** Test seam: the per-operation bound; defaults to `attachmentDeadlineMs`. */
  deadlineMs?: (bytes: number) => number
}): AttachmentStore {
  const root = join(o.dataDir, 'artifacts')
  const objects = join(root, 'sha256')
  const staging = join(root, 'staging')
  const markers = join(root, 'user-attachment-meta')
  const clock = o.clock ?? (() => Date.now())
  const verifyOnceAt = o.verifyOnceAtBytes ?? 32 * MIB
  const deadline = o.deadlineMs ?? attachmentDeadlineMs
  const verified = new Map<string, string>()
  const markerLocks = new Map<string, Promise<unknown>>()
  const objectPath = (sha256: string) => join(objects, sha256.slice(0, 2), sha256)
  const markerPath = (sha256: string) => join(markers, sha256.slice(0, 2), `${sha256}.json`)

  async function stage(meta: {
    kind: AttachmentKind
    mimeType: string
    maxBytes?: number
  }): Promise<AttachmentStaging> {
    void meta.kind
    await ensureDir(staging)
    const path = join(staging, randomUUID())
    const file: FileHandle = await open(path, 'wx', 0o600)
    const hash = createHash('sha256')
    let written = 0
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await file.close().catch(() => undefined)
    }
    const discard = async () => {
      await close()
      await rm(path, { force: true })
    }
    return {
      get bytes() {
        return written
      },
      async write(chunk, signal) {
        if (closed) throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED')
        signal?.throwIfAborted()
        if (meta.maxBytes !== undefined && written + chunk.byteLength > meta.maxBytes) {
          await discard()
          throw new AttachmentStoreError('ATTACHMENT_TOO_LARGE')
        }
        const append = async () => {
          let at = 0
          while (at < chunk.byteLength) {
            const { bytesWritten } = await file.write(chunk, at, chunk.byteLength - at, written + at)
            if (bytesWritten === 0)
              throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED', 'staging write made no progress')
            at += bytesWritten
          }
          hash.update(chunk)
          written += chunk.byteLength
        }
        try {
          await withDeadline(deadline(chunk.byteLength), append, discard)
        } catch (error) {
          await discard()
          throw error
        }
      },
      async commit(expectedSha256) {
        if (closed) throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED')
        const sha256 = hash.digest('hex')
        if (expectedSha256 !== undefined && expectedSha256 !== sha256) {
          await discard()
          throw new AttachmentStoreError('ATTACHMENT_HASH_MISMATCH')
        }
        const publish = async () => {
          await file.sync()
          await close()
          const target = objectPath(sha256)
          await ensureDir(join(objects, sha256.slice(0, 2)))
          const existing = await stat(target).catch(() => undefined)
          if (existing?.isFile() && existing.size === written) await rm(path, { force: true })
          else await rename(path, target)
          return Object.freeze({ sha256, bytes: written })
        }
        try {
          return await withDeadline(deadline(written), publish, discard)
        } catch (error) {
          await discard()
          throw error
        }
      },
      abort: discard,
    }
  }

  async function verifyWhole(
    sha256: string,
    size: number,
    read: () => Promise<Uint8Array>,
  ): Promise<Uint8Array> {
    const info = await stat(objectPath(sha256))
    const identity = `${info.size}:${info.mtimeMs}:${info.ino}`
    const bytes = await read()
    if (bytes.byteLength !== size) throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
    if (size >= verifyOnceAt && verified.get(sha256) === identity) return bytes
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
    if (size >= verifyOnceAt) verified.set(sha256, identity)
    return bytes
  }

  const store: AttachmentStore = {
    root,
    stage,
    async put(bytes, meta) {
      const staged = await stage(meta)
      await staged.write(bytes)
      return staged.commit()
    },
    async stat(sha256) {
      checkId(sha256)
      const info = await stat(objectPath(sha256)).catch(() => undefined)
      return info?.isFile() ? Object.freeze({ sha256, bytes: info.size }) : undefined
    },
    async read(sha256, range, signal) {
      checkId(sha256)
      signal?.throwIfAborted()
      const info = await stat(objectPath(sha256)).catch(() => undefined)
      if (!info?.isFile()) throw new AttachmentStoreError('ATTACHMENT_MISSING')
      if (range) {
        if (range.offset < 0 || range.length < 0 || range.offset + range.length > info.size)
          throw new AttachmentStoreError('ATTACHMENT_CORRUPT', 'range outside object')
        const file = await open(objectPath(sha256), 'r')
        try {
          const out = new Uint8Array(range.length)
          let at = 0
          while (at < range.length) {
            const { bytesRead } = await file.read(out, at, range.length - at, range.offset + at)
            if (bytesRead === 0) throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
            at += bytesRead
          }
          return out
        } finally {
          await file.close()
        }
      }
      return verifyWhole(sha256, info.size, async () => new Uint8Array(await readFile(objectPath(sha256))))
    },
    async markUserAttachment(object, meta) {
      checkId(object.sha256)
      const previous = markerLocks.get(object.sha256) ?? Promise.resolve()
      const next = previous.then(async () => {
        const current = await store.userAttachment(object.sha256)
        const receipt = meta.receiptFor === undefined ? undefined : attachmentReceiptFor(meta.receiptFor)
        const receipts = [...(current?.receipts ?? [])]
        if (receipt && !receipts.includes(receipt)) receipts.push(receipt)
        if (current && receipts.length === current.receipts.length) return
        const marker: UserAttachmentMarker = {
          schemaVersion: 1,
          sha256: object.sha256,
          bytes: object.bytes,
          mimeType: current?.mimeType ?? meta.mimeType,
          firstSeenMs: current?.firstSeenMs ?? clock(),
          receipts,
        }
        await ensureDir(join(markers, object.sha256.slice(0, 2)))
        const temporary = `${markerPath(object.sha256)}.${randomUUID()}.tmp`
        await writeFile(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 })
        await rename(temporary, markerPath(object.sha256))
      })
      const tail = next.catch(() => undefined)
      markerLocks.set(object.sha256, tail)
      try {
        await next
      } finally {
        if (markerLocks.get(object.sha256) === tail) markerLocks.delete(object.sha256)
      }
    },
    async userAttachment(sha256) {
      checkId(sha256)
      const text = await readFile(markerPath(sha256), 'utf8').catch(() => undefined)
      if (text === undefined) return undefined
      let marker: UserAttachmentMarker
      try {
        marker = JSON.parse(text) as UserAttachmentMarker
      } catch {
        throw new AttachmentStoreError('ATTACHMENT_CORRUPT', 'unreadable attachment marker')
      }
      if (marker?.schemaVersion !== 1 || marker.sha256 !== sha256)
        throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
      return marker
    },
    async sweepStaging(nowMs) {
      await ensureDir(staging)
      let removed = 0
      for (const name of await readdir(staging)) {
        const info = await stat(join(staging, name)).catch(() => undefined)
        if (info && nowMs - info.mtimeMs > STAGING_MAX_AGE_MS) {
          await rm(join(staging, name), { force: true })
          removed++
        }
      }
      return removed
    },
  }
  return Object.freeze(store)
}
