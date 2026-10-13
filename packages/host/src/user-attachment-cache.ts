import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentReadPort } from '@agnes/core'
import {
  type AttachmentStore,
  AttachmentStoreError,
  attachmentReceiptFor,
  type StoredObject,
} from './attachment-store.js'

const SHA256 = /^[0-9a-f]{64}$/u
/** Sessions whose cache maps are kept in memory at once; an evicted map is read from disk again. */
const MAPS_HELD = 64

type CacheEntry = Readonly<{ sha256: string; bytes: number; rowId: string }>
type CacheMap = Record<string, CacheEntry>

const keyOf = (seq: number, kind: string, index: number): string | undefined =>
  Number.isSafeInteger(seq) &&
  seq > 0 &&
  Number.isSafeInteger(index) &&
  index > 0 &&
  (kind === 'image' || kind === 'file')
    ? `${seq}/${kind}/${index}`
    : undefined

/** Only well-formed entries survive a read; a damaged file is an empty cache, rewritten by the next copy. */
function parse(text: string): CacheMap {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: CacheMap = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as { sha256?: unknown; bytes?: unknown; rowId?: unknown } | null
    if (
      /^[1-9][0-9]*\/(image|file)\/[1-9][0-9]*$/u.test(key) &&
      typeof e?.sha256 === 'string' &&
      SHA256.test(e.sha256) &&
      typeof e.bytes === 'number' &&
      Number.isSafeInteger(e.bytes) &&
      e.bytes >= 0 &&
      typeof e.rowId === 'string' &&
      e.rowId.length > 0
    )
      out[key] = Object.freeze({ sha256: e.sha256, bytes: e.bytes, rowId: e.rowId })
  }
  return out
}

/**
 * How a session reads user attachments from the host's attachment store.
 *
 * Only objects the store marks as user attachments (uploads, thumbnails, the copies below) are ever
 * served: `isUserAttachment` answers from the marker, and `read` refuses an unmarked object as if it
 * were missing. A digest a row names can therefore never fetch spilled tool output, a request
 * version or any other artifact, nor reveal that one exists.
 *
 * Old inline attachments are cached: the first read of one decodes it from its ledger row and keeps
 * the bytes in the store, and `<store>/user-attachment-cache/<session receipt>.json` maps its place in
 * the session (`<seq>/<kind>/<index>`) to the stored object and to the id of the row it came from, so
 * later reads skip the row and a reused seq never matches an old copy. The ledger is never written. A
 * lost or damaged map only costs one more read of the row.
 *
 * The copy itself is made by `keep`, the host port's quota-checked store: it is charged to the global
 * quota and the free-space floor like any stored attachment, and refused (the read still succeeds,
 * from the row) when there is no room. It is marked as a user attachment with the store's receipt-less
 * mark, which only ever creates a missing marker, so it never rewrites a marker an upload is adding a
 * receipt to; keeping a cache copy grants no session the right to reference the object. Without
 * `keep` only the reads are offered (old inline attachments are then decoded from their row on every
 * read). The map is replaced whole through a temporary file and a rename; writes for one session are
 * serialized in this process, which is the process hosting that session.
 *
 * Maps are not removed with a session: nothing on this build deletes a session that has attachments;
 * an unused map costs one small file and goes with the attachment sweep.
 */
export function createUserAttachmentReader(o: {
  store: AttachmentStore
  /** Stores and marks one cache copy, or refuses it; omitted, old inline attachments are not copied. */
  keep?: (bytes: Uint8Array, mimeType: string) => Promise<StoredObject>
}): AttachmentReadPort {
  const dir = join(o.store.root, 'user-attachment-cache')
  const held = new Map<string, Promise<CacheMap>>()
  const writes = new Map<string, Promise<unknown>>()
  const fileFor = (sessionKey: string) => join(dir, `${attachmentReceiptFor(sessionKey)}.json`)

  const load = (file: string): Promise<CacheMap> => {
    let map = held.get(file)
    if (map) {
      // Most recently used last, so eviction drops the coldest session.
      held.delete(file)
    } else {
      map = readFile(file, 'utf8').then(parse, () => ({}))
    }
    held.set(file, map)
    while (held.size > MAPS_HELD) held.delete(held.keys().next().value as string)
    return map
  }

  const save = async (file: string, map: CacheMap): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(map)}\n`)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, file)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  // Asked on every read, not remembered: a marker the sweep removes stops serving the object at once.
  // A damaged marker or a malformed digest is not a marker.
  const isUserAttachment = async (sha256: string): Promise<boolean> =>
    (await o.store.userAttachment(sha256).catch(() => undefined)) !== undefined
  const read = async (sha256: string, range?: { offset: number; length: number }, signal?: AbortSignal) => {
    if (!(await isUserAttachment(sha256))) throw new AttachmentStoreError('ATTACHMENT_MISSING')
    return o.store.read(sha256, range, signal)
  }
  const keep = o.keep
  if (!keep) return Object.freeze({ isUserAttachment, read })
  return Object.freeze({
    isUserAttachment,
    read,
    async cachedInline(sessionKey: string, seq: number, kind: string, index: number, rowId: string) {
      const key = keyOf(seq, kind, index)
      if (!key) return undefined
      const entry = (await load(fileFor(sessionKey)))[key]
      return entry && entry.rowId === rowId ? { sha256: entry.sha256, bytes: entry.bytes } : undefined
    },
    async cacheInline(input: {
      sessionKey: string
      seq: number
      kind: string
      index: number
      rowId: string
      bytes: Uint8Array
      mimeType: string
    }): Promise<StoredObject> {
      const key = keyOf(input.seq, input.kind, input.index)
      if (!key || typeof input.rowId !== 'string' || input.rowId.length === 0)
        throw new TypeError('invalid attachment position')
      const object = await keep(input.bytes, input.mimeType)
      const file = fileFor(input.sessionKey)
      const entry: CacheEntry = Object.freeze({ ...object, rowId: input.rowId })
      const previous = writes.get(file) ?? Promise.resolve()
      const next = previous.then(async () => {
        const map = { ...(await load(file)), [key]: entry }
        await save(file, map)
        held.set(file, Promise.resolve(map))
      })
      const settled = next.catch(() => undefined)
      writes.set(file, settled)
      void settled.then(() => {
        if (writes.get(file) === settled) writes.delete(file)
      })
      await next
      return object
    },
  })
}
