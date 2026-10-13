import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { AttachmentReadPort } from '@agnes/core'
import { type AttachmentStore, attachmentReceiptFor, type StoredObject } from './attachment-store.js'

const SHA256 = /^[0-9a-f]{64}$/u
/** Sessions whose cache maps are kept in memory at once; an evicted map is read from disk again. */
const MAPS_HELD = 64

type CacheMap = Record<string, StoredObject>

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
    const e = entry as { sha256?: unknown; bytes?: unknown } | null
    if (
      /^[1-9][0-9]*\/(image|file)\/[1-9][0-9]*$/u.test(key) &&
      typeof e?.sha256 === 'string' &&
      SHA256.test(e.sha256) &&
      typeof e.bytes === 'number' &&
      Number.isSafeInteger(e.bytes) &&
      e.bytes >= 0
    )
      out[key] = Object.freeze({ sha256: e.sha256, bytes: e.bytes })
  }
  return out
}

/**
 * How a session reads user attachments from the host's attachment store, with a cache for old inline
 * attachments: the first read of one decodes it from its ledger row and keeps the bytes in the store,
 * and `<store>/user-attachment-cache/<session receipt>.json` maps its place in the session
 * (`<seq>/<kind>/<index>`) to the stored object, so later reads skip the row. The ledger is never
 * written. A lost or damaged map only costs one more read of the row.
 *
 * `cacheInline: false` leaves only the reads (old inline attachments are then decoded from their row
 * on every read). The map is replaced whole through a temporary file and a rename; writes for one session are
 * serialized in this process, which is the process hosting that session. The copy is marked as a user
 * attachment only when the object has no marker yet, and never with a receipt: keeping a cache copy
 * grants no session the right to reference the object.
 */
export function createUserAttachmentReader(o: {
  store: AttachmentStore
  cacheInline?: boolean
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

  const read = (sha256: string, range?: { offset: number; length: number }, signal?: AbortSignal) =>
    o.store.read(sha256, range, signal)
  if (o.cacheInline === false) return Object.freeze({ read })
  return Object.freeze({
    read,
    async cachedInline(sessionKey: string, seq: number, kind: string, index: number) {
      const key = keyOf(seq, kind, index)
      if (!key) return undefined
      return (await load(fileFor(sessionKey)))[key]
    },
    async cacheInline(input: {
      sessionKey: string
      seq: number
      kind: string
      index: number
      bytes: Uint8Array
      mimeType: string
    }): Promise<StoredObject> {
      const key = keyOf(input.seq, input.kind, input.index)
      if (!key) throw new TypeError('invalid attachment position')
      const object = await o.store.put(input.bytes, { kind: 'user-attachment', mimeType: input.mimeType })
      const marker = await o.store.userAttachment(object.sha256).catch(() => undefined)
      if (!marker) await o.store.markUserAttachment(object, { mimeType: input.mimeType })
      const file = fileFor(input.sessionKey)
      const previous = writes.get(file) ?? Promise.resolve()
      const next = previous.then(async () => {
        const map = { ...(await load(file)), [key]: object }
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
