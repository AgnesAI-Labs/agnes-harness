import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
/** `readFile` refuses anything larger; such objects are read by range. */
const MAX_WHOLE_READ = 2 ** 31 - 1

/** At least 10 s, plus 2 s for every started MiB: the bound on one put, stage write or commit. */
export function attachmentDeadlineMs(bytes: number): number {
  return Math.max(10_000, Math.ceil(bytes / MIB) * 2_000)
}

/** The opaque per-session token kept in a marker; the session key itself never reaches the store. */
export function attachmentReceiptFor(sessionKey: string): string {
  return createHash('sha256').update(sessionKey, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Rejects with `ATTACHMENT_TIMEOUT` as soon as the bound passes, then starts the cleanup without waiting
 * for it: closing a handle that has a stalled operation pending never settles, so the caller must not
 * depend on it.
 */
async function withDeadline<T>(ms: number, run: () => Promise<T>, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = run()
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new AttachmentStoreError('ATTACHMENT_TIMEOUT'))
      onTimeout()
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

const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

async function ensureDir(path: string): Promise<void> {
  // Node ignores the mode on Windows, where the data directory's ACL applies.
  await mkdir(path, { recursive: true, mode: 0o700 })
}

/** Best effort: makes a rename durable on POSIX; Windows cannot open a directory and skips it. */
async function syncDir(path: string): Promise<void> {
  try {
    const handle = await open(path, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Durability of the directory entry is an optimisation, never a correctness requirement.
  }
}

/** Removes entries older than the staging window; one entry that cannot be removed never stops the rest. */
async function sweepOld(dir: string, nowMs: number, wanted: (name: string) => boolean): Promise<number> {
  let removed = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!wanted(name)) continue
    const entry = join(dir, name)
    const info = await lstat(entry).catch(() => undefined)
    if (!info || nowMs - info.mtimeMs <= STAGING_MAX_AGE_MS) continue
    try {
      await rm(entry, { recursive: true, force: true })
      removed++
    } catch {
      // Left for the next sweep.
    }
  }
  return removed
}

/**
 * The public store: exactly the documented options. Staged writes are ordered and bounded; markers are
 * serialized within this process only, so receipts must be added by one process (the one that owns
 * uploads). A mark without a receipt only ever creates a missing marker, so any process may make it.
 * The internal factory below carries the test seams and is not exported from the package root.
 */
export function createAttachmentStore(o: { dataDir: string; clock?: () => number }): AttachmentStore {
  return createAttachmentStoreInternal({ dataDir: o.dataDir, ...(o.clock ? { clock: o.clock } : {}) })
}

/**
 * Content-addressed attachment bytes beside the session database, in the same tree the bundled
 * artifact store and the artifact read RPC already use. Writes stream through a staging file whose
 * digest is computed as the bytes arrive; commit syncs it and renames it into place, so a crash
 * leaves either a stray staging file or a complete object, never a partial object.
 *
 * A stage queues its writes in call order. A write after `commit` has started, or after the stage is
 * closed, fails with `ATTACHMENT_STAGE_CLOSED`; a second concurrent `commit` fails the same way.
 */
export function createAttachmentStoreInternal(o: {
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
    let reserved = 0
    let closed = false
    let committing = false
    let queue: Promise<unknown> = Promise.resolve()
    const close = async () => {
      if (closed) return
      closed = true
      await file.close().catch(() => undefined)
    }
    const discard = async () => {
      await close()
      await rm(path, { force: true })
    }
    const dropInBackground = () => void discard().catch(() => undefined)
    const alive = () => {
      if (closed) throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED')
    }
    const append = async (chunk: Uint8Array) => {
      let at = 0
      while (at < chunk.byteLength) {
        alive()
        const { bytesWritten } = await file.write(chunk, at, chunk.byteLength - at, written + at)
        if (bytesWritten === 0)
          throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED', 'staging write made no progress')
        at += bytesWritten
      }
      alive()
      hash.update(chunk)
      written += chunk.byteLength
    }
    const publish = async (sha256: string): Promise<StoredObject> => {
      await file.sync()
      await close()
      const target = objectPath(sha256)
      await ensureDir(dirname(target))
      try {
        // Always replace: the staged bytes are verified, so this also repairs a damaged object.
        await rename(path, target)
      } catch (error) {
        // Windows refuses to replace a file that is open elsewhere; an intact copy is the same object.
        const existing = await stat(target).catch(() => undefined)
        if (
          !['EPERM', 'EBUSY', 'EACCES'].includes(String(errorCode(error))) ||
          !existing?.isFile() ||
          existing.size !== written
        )
          throw error
        await rm(path, { force: true })
      }
      await syncDir(dirname(target))
      return Object.freeze({ sha256, bytes: written })
    }
    return {
      get bytes() {
        return written
      },
      async write(chunk, signal) {
        alive()
        if (committing) throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED', 'commit already started')
        signal?.throwIfAborted()
        if (meta.maxBytes !== undefined && reserved + chunk.byteLength > meta.maxBytes) {
          await discard()
          throw new AttachmentStoreError('ATTACHMENT_TOO_LARGE')
        }
        reserved += chunk.byteLength
        const op = queue.then(async () => {
          alive()
          signal?.throwIfAborted()
          await withDeadline(deadline(chunk.byteLength), () => append(chunk), dropInBackground)
        })
        queue = op.catch(() => undefined)
        try {
          await op
        } catch (error) {
          await discard()
          throw error
        }
      },
      async commit(expectedSha256) {
        alive()
        if (committing) throw new AttachmentStoreError('ATTACHMENT_STAGE_CLOSED', 'commit already started')
        committing = true
        try {
          if (expectedSha256 !== undefined) checkId(expectedSha256)
          await queue
          alive()
          const sha256 = hash.digest('hex')
          if (expectedSha256 !== undefined && expectedSha256 !== sha256)
            throw new AttachmentStoreError('ATTACHMENT_HASH_MISMATCH')
          return await withDeadline(deadline(written), () => publish(sha256), dropInBackground)
        } catch (error) {
          await discard()
          throw error
        }
      },
      abort: discard,
    }
  }

  async function verifyWhole(sha256: string, size: number, signal?: AbortSignal): Promise<Uint8Array> {
    const path = objectPath(sha256)
    const info = await stat(path).catch(() => undefined)
    if (!info?.isFile()) throw new AttachmentStoreError('ATTACHMENT_MISSING')
    const identity = `${info.size}:${info.mtimeMs}:${info.ino}`
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await readFile(path, signal ? { signal } : undefined))
    } catch (error) {
      if (error instanceof RangeError) throw tooLargeToReadWhole()
      if (errorCode(error) === 'ENOENT') throw new AttachmentStoreError('ATTACHMENT_MISSING')
      throw error
    }
    if (bytes.byteLength !== size) throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
    if (size >= verifyOnceAt && verified.get(sha256) === identity) return bytes
    if (createHash('sha256').update(bytes).digest('hex') !== sha256)
      throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
    if (size >= verifyOnceAt) verified.set(sha256, identity)
    return bytes
  }

  const tooLargeToReadWhole = () =>
    new AttachmentStoreError('ATTACHMENT_TOO_LARGE', 'object is too large to read whole; read it by range')

  /** `strict` reports a damaged marker; otherwise it counts as absent (a rewrite replaces it). */
  async function readMarker(sha256: string, strict: boolean): Promise<UserAttachmentMarker | undefined> {
    let text: string
    try {
      text = await readFile(markerPath(sha256), 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined
      throw error
    }
    let marker: UserAttachmentMarker | undefined
    try {
      marker = JSON.parse(text) as UserAttachmentMarker
    } catch {
      marker = undefined
    }
    if (marker?.schemaVersion !== 1 || marker.sha256 !== sha256 || !Array.isArray(marker.receipts)) {
      if (strict) throw new AttachmentStoreError('ATTACHMENT_CORRUPT', 'unreadable attachment marker')
      return undefined
    }
    return marker
  }

  /**
   * `createOnly` publishes with a hard link, which fails when a marker is already there instead of
   * replacing it; resolves false in that case. Without it the marker is replaced.
   */
  async function writeMarker(
    sha256: string,
    marker: UserAttachmentMarker,
    createOnly = false,
  ): Promise<boolean> {
    const directory = join(markers, sha256.slice(0, 2))
    await ensureDir(directory)
    const temporary = `${markerPath(sha256)}.${randomUUID()}.tmp`
    let created = true
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(marker)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (!createOnly) await rename(temporary, markerPath(sha256))
      else {
        try {
          await link(temporary, markerPath(sha256))
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error
          created = false
        }
        await rm(temporary, { force: true })
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    await syncDir(directory)
    return created
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
        // The error union is frozen, so a bad range reuses the closest code; CORRUPT stays for short reads.
        if (
          !Number.isSafeInteger(range.offset) ||
          !Number.isSafeInteger(range.length) ||
          range.offset < 0 ||
          range.length < 0 ||
          range.offset + range.length > info.size
        )
          throw new AttachmentStoreError('ATTACHMENT_INVALID_ID', 'range outside object')
        const file = await open(objectPath(sha256), 'r')
        try {
          const out = new Uint8Array(range.length)
          let at = 0
          while (at < range.length) {
            signal?.throwIfAborted()
            const { bytesRead } = await file.read(out, at, range.length - at, range.offset + at)
            if (bytesRead === 0) throw new AttachmentStoreError('ATTACHMENT_CORRUPT')
            at += bytesRead
          }
          return out
        } finally {
          await file.close()
        }
      }
      if (info.size > MAX_WHOLE_READ) throw tooLargeToReadWhole()
      return verifyWhole(sha256, info.size, signal)
    },
    async markUserAttachment(object, meta) {
      checkId(object.sha256)
      const previous = markerLocks.get(object.sha256) ?? Promise.resolve()
      const next = previous.then(async () => {
        const current = await readMarker(object.sha256, false)
        const receipt = meta.receiptFor === undefined ? undefined : attachmentReceiptFor(meta.receiptFor)
        const receipts = [...(current?.receipts ?? [])]
        if (receipt && !receipts.includes(receipt)) receipts.push(receipt)
        if (current && receipts.length === current.receipts.length) return
        const marker = {
          schemaVersion: 1 as const,
          sha256: object.sha256,
          bytes: object.bytes,
          mimeType: current?.mimeType ?? meta.mimeType,
          firstSeenMs: current?.firstSeenMs ?? clock(),
          receipts,
        }
        // A mark without a receipt only creates a missing marker and never replaces one, so any
        // process may make it: another process's receipt written since the read above survives.
        if (receipt) {
          await writeMarker(object.sha256, marker)
          return
        }
        if (await writeMarker(object.sha256, marker, true)) return
        // Already there: either intact (nothing to add) or damaged, which a rewrite repairs.
        if (!(await readMarker(object.sha256, false))) await writeMarker(object.sha256, marker)
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
      return readMarker(sha256, true)
    },
    /** Removes staging entries and stale marker temp files older than a day; returns how many went. */
    async sweepStaging(nowMs) {
      await ensureDir(staging)
      let removed = await sweepOld(staging, nowMs, () => true)
      for (const shard of await readdir(markers).catch(() => [] as string[]))
        removed += await sweepOld(join(markers, shard), nowMs, (name) => name.endsWith('.tmp'))
      return removed
    },
  }
  return Object.freeze(store)
}
