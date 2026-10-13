import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type RequestImageTransform, requestVersionId } from '@agnes/core'
import { decodeSafeImageBytes, SafeImageError } from '@agnes/protocol-validation'
import type { AttachmentStore, StoredObject } from './attachment-store.js'

export type EncodedImage = Readonly<{
  bytes: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}>
export interface ImageVersionEncoder {
  readonly id: string
  encode(
    input: Readonly<{ bytes: Uint8Array; mimeType: string }>,
    target: RequestImageTransform,
    signal?: AbortSignal,
  ): Promise<EncodedImage>
}
export class ImageVersionError extends Error {
  constructor(readonly code: 'IMAGE_RESIZE_REQUIRED' | 'IMAGE_DECODE_FAILED') {
    super(code)
    this.name = 'ImageVersionError'
  }
}

/** Uses the source as it is when it already satisfies the target; this build has no image codec. */
export const identityImageEncoder: ImageVersionEncoder = Object.freeze<ImageVersionEncoder>({
  id: 'identity',
  async encode(input, target) {
    let image: ReturnType<typeof decodeSafeImageBytes>
    try {
      image = decodeSafeImageBytes(
        { bytes: input.bytes, mimeType: input.mimeType },
        {
          maxBytesPerImage: target.maxBytes,
          maxPixelsPerImage: target.maxPixels,
          maxAggregateBytes: target.maxBytes,
          maxAggregatePixels: target.maxPixels,
        },
      )
    } catch (error) {
      if (error instanceof SafeImageError && (error.code === 'BYTE_LIMIT' || error.code === 'PIXEL_LIMIT'))
        throw new ImageVersionError('IMAGE_RESIZE_REQUIRED')
      throw new ImageVersionError('IMAGE_DECODE_FAILED')
    }
    const format = image.mime === 'image/png' ? 'png' : 'jpeg'
    if (
      image.width > target.maxWidth ||
      image.height > target.maxHeight ||
      !target.encoder.formats.includes(format)
    )
      throw new ImageVersionError('IMAGE_RESIZE_REQUIRED')
    return { bytes: input.bytes, mimeType: image.mime, width: image.width, height: image.height }
  },
})

type IndexEntry = {
  id: string
  sha256: string
  bytes: number
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  lastUsedMs: number
}

type VersionResult = Readonly<{ id: string; object: StoredObject; image: EncodedImage }>

export interface RequestVersionCache {
  getOrCreate(
    source: Readonly<{ sha256: string; bytes: number; mimeType: string }>,
    t: RequestImageTransform,
    signal?: AbortSignal,
  ): Promise<VersionResult>
  trim(): Promise<void>
}

const ID = /^[0-9a-f]{64}$/
const TEMPORARY_MAX_AGE_MS = 60 * 60 * 1000
const wholeNumber = (v: unknown, min: number): v is number => Number.isSafeInteger(v) && (v as number) >= min

function validEntry(value: unknown, id: string): value is IndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e.id === id &&
    typeof e.sha256 === 'string' &&
    ID.test(e.sha256) &&
    wholeNumber(e.bytes, 0) &&
    (e.mimeType === 'image/png' || e.mimeType === 'image/jpeg') &&
    wholeNumber(e.width, 1) &&
    wholeNumber(e.height, 1) &&
    typeof e.lastUsedMs === 'number' &&
    Number.isFinite(e.lastUsedMs)
  )
}

const hasCode = (error: unknown, ...codes: string[]) =>
  typeof error === 'object' && error !== null && codes.includes((error as { code?: string }).code ?? '')

/**
 * Derived images keyed by `requestVersionId`. The bytes live in the attachment store; this directory
 * only holds a small index entry per version, used for reuse and for least-recently-used trimming.
 * A version identical to its source is never indexed: the source object is used as it is.
 *
 * A concurrent `trim` can delete an object right after `getOrCreate` returned it. A caller that goes
 * on to read the object must treat a missing or corrupt object as "redo `getOrCreate`", not as a
 * failure. Concurrent callers for one id share one piece of work; an aborting caller only leaves,
 * and the work stops once every caller has gone.
 */
export function createRequestVersionCache(o: {
  store: AttachmentStore
  root: string
  maxBytes: number
  encoder: ImageVersionEncoder
  clock?: () => number
}): RequestVersionCache {
  // Strictly increasing, so two versions made in the same millisecond still have a recency order.
  const now = o.clock ?? (() => Date.now())
  let lastTick = Number.NEGATIVE_INFINITY
  const clock = () => (lastTick = Math.max(now(), lastTick + 1))
  const inflight = new Map<
    string,
    { promise: Promise<VersionResult>; controller: AbortController; waiters: number }
  >()
  const entryPath = (id: string) => join(o.root, `${id}.json`)
  const writeEntry = async (entry: IndexEntry) => {
    await mkdir(o.root, { recursive: true })
    const tmp = `${entryPath(entry.id)}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(entry))
      await rename(tmp, entryPath(entry.id))
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }
  /** An unreadable, garbled or malformed index file is a miss, and is removed. */
  const readEntry = async (id: string): Promise<IndexEntry | undefined> => {
    const text = await readFile(entryPath(id), 'utf8').catch(() => undefined)
    if (text === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }
    if (validEntry(parsed, id)) return parsed
    await rm(entryPath(id), { force: true }).catch(() => undefined)
    return undefined
  }
  const isProtected = async (sha256: string) => {
    try {
      return (await o.store.userAttachment(sha256)) !== undefined
    } catch {
      return true // an unreadable marker is not a licence to delete
    }
  }

  async function make(
    source: Readonly<{ sha256: string; bytes: number; mimeType: string }>,
    t: RequestImageTransform,
    id: string,
    signal: AbortSignal,
  ): Promise<VersionResult> {
    const cached = await readEntry(id)
    if (cached) {
      let bytes: Uint8Array | undefined
      try {
        bytes = await o.store.read(cached.sha256, undefined, signal)
      } catch (error) {
        if (signal.aborted || !hasCode(error, 'ATTACHMENT_CORRUPT', 'ATTACHMENT_MISSING')) throw error
        // The object is gone or fails its digest: forget the entry, drop a corrupt file so the redo
        // rewrites it (a same-size file would otherwise be deduplicated), and make the version again.
        await rm(entryPath(id), { force: true })
        if (hasCode(error, 'ATTACHMENT_CORRUPT') && !(await isProtected(cached.sha256)))
          await rm(join(o.store.root, 'sha256', cached.sha256.slice(0, 2), cached.sha256), { force: true })
      }
      if (bytes) {
        await writeEntry({ ...cached, lastUsedMs: clock() }).catch(() => undefined) // recency only
        return {
          id,
          object: { sha256: cached.sha256, bytes: cached.bytes },
          image: { bytes, mimeType: cached.mimeType, width: cached.width, height: cached.height },
        }
      }
    }
    const input = await o.store.read(source.sha256, undefined, signal)
    const image = await o.encoder.encode({ bytes: input, mimeType: source.mimeType }, t, signal)
    if (
      image.bytes === input ||
      (image.bytes.byteLength === input.byteLength && Buffer.compare(image.bytes, input) === 0)
    )
      return { id, object: { sha256: source.sha256, bytes: source.bytes }, image }
    const object = await o.store.put(image.bytes, { kind: 'request-version', mimeType: image.mimeType })
    await writeEntry({
      id,
      ...object,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      lastUsedMs: clock(),
    })
    return { id, object, image }
  }

  return {
    getOrCreate(source, t, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      const id = requestVersionId(source.sha256, t)
      let flight = inflight.get(id)
      if (!flight) {
        const controller = new AbortController()
        const created = { promise: undefined as unknown as Promise<VersionResult>, controller, waiters: 0 }
        created.promise = make(source, t, id, controller.signal).finally(() => {
          if (inflight.get(id) === created) inflight.delete(id)
        })
        created.promise.catch(() => undefined) // reported to the callers still waiting, if any
        inflight.set(id, created)
        flight = created
      }
      const shared = flight
      shared.waiters++
      return new Promise<VersionResult>((resolve, reject) => {
        let left = false
        const leave = () => {
          if (left) return false
          left = true
          signal?.removeEventListener('abort', onAbort)
          shared.waiters--
          return true
        }
        const onAbort = () => {
          if (!leave()) return
          reject(signal?.reason)
          if (shared.waiters === 0) {
            // Nobody wants the result any more: stop the work, and let a later caller start afresh.
            if (inflight.get(id) === shared) inflight.delete(id)
            shared.controller.abort(signal?.reason)
          }
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        shared.promise.then(
          (value) => leave() && resolve(value),
          (error) => leave() && reject(error),
        )
      })
    },
    async trim() {
      const names = await readdir(o.root).catch(() => [] as string[])
      const cutoff = Date.now() - TEMPORARY_MAX_AGE_MS
      for (const name of names) {
        if (!name.endsWith('.tmp')) continue
        const info = await stat(join(o.root, name)).catch(() => undefined)
        if (info && info.mtimeMs < cutoff) await rm(join(o.root, name), { force: true })
      }
      const ids = names
        .filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5)))
        .map((n) => n.slice(0, -5))
      const entries = (await Promise.all(ids.map((id) => readEntry(id)))).filter(
        (e): e is IndexEntry => e !== undefined,
      )
      // Objects that outlive their index entry (a user attachment) free nothing, so they neither count
      // toward the budget nor get evicted; an object shared by several entries counts once.
      const protectedShas = new Set<string>()
      for (const sha of new Set(entries.map((e) => e.sha256)))
        if (await isProtected(sha)) protectedShas.add(sha)
      const references = new Map<string, number>()
      const sizes = new Map<string, number>()
      for (const e of entries) {
        references.set(e.sha256, (references.get(e.sha256) ?? 0) + 1)
        sizes.set(e.sha256, e.bytes)
      }
      let total = 0
      for (const [sha, bytes] of sizes) if (!protectedShas.has(sha)) total += bytes
      for (const entry of entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs)) {
        if (total <= o.maxBytes) break
        if (protectedShas.has(entry.sha256)) continue
        await rm(entryPath(entry.id), { force: true })
        const left = (references.get(entry.sha256) ?? 1) - 1
        references.set(entry.sha256, left)
        if (left > 0) continue
        await rm(join(o.store.root, 'sha256', entry.sha256.slice(0, 2), entry.sha256), { force: true })
        total -= entry.bytes
      }
    },
  }
}
