import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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

export interface RequestVersionCache {
  getOrCreate(
    source: Readonly<{ sha256: string; bytes: number; mimeType: string }>,
    t: RequestImageTransform,
    signal?: AbortSignal,
  ): Promise<Readonly<{ id: string; object: StoredObject; image: EncodedImage }>>
  trim(): Promise<void>
}

/**
 * Derived images keyed by `requestVersionId`. The bytes live in the attachment store; this directory
 * only holds a small index entry per version, used for reuse and for least-recently-used trimming.
 * A version identical to its source is never indexed: the source object is used as it is.
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
    Promise<Readonly<{ id: string; object: StoredObject; image: EncodedImage }>>
  >()
  const entryPath = (id: string) => join(o.root, `${id}.json`)
  const writeEntry = async (entry: IndexEntry) => {
    await mkdir(o.root, { recursive: true })
    const tmp = `${entryPath(entry.id)}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(entry))
    await rename(tmp, entryPath(entry.id))
  }
  const readEntry = async (id: string): Promise<IndexEntry | undefined> => {
    const text = await readFile(entryPath(id), 'utf8').catch(() => undefined)
    return text === undefined ? undefined : (JSON.parse(text) as IndexEntry)
  }

  async function make(
    source: Readonly<{ sha256: string; bytes: number; mimeType: string }>,
    t: RequestImageTransform,
    id: string,
    signal?: AbortSignal,
  ) {
    const cached = await readEntry(id)
    if (cached) {
      try {
        const bytes = await o.store.read(cached.sha256, undefined, signal)
        await writeEntry({ ...cached, lastUsedMs: clock() })
        const image: EncodedImage = {
          bytes,
          mimeType: cached.mimeType,
          width: cached.width,
          height: cached.height,
        }
        return { id, object: { sha256: cached.sha256, bytes: cached.bytes }, image }
      } catch {
        await rm(entryPath(id), { force: true })
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
      const id = requestVersionId(source.sha256, t)
      const running = inflight.get(id)
      if (running) return running
      const next = make(source, t, id, signal).finally(() => inflight.delete(id))
      inflight.set(id, next)
      return next
    },
    async trim() {
      const names = await readdir(o.root).catch(() => [] as string[])
      const entries = (
        await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readEntry(n.slice(0, -5))))
      ).filter((e): e is IndexEntry => e !== undefined)
      let total = entries.reduce((n, e) => n + e.bytes, 0)
      for (const entry of entries.sort((a, b) => a.lastUsedMs - b.lastUsedMs)) {
        if (total <= o.maxBytes) break
        await rm(entryPath(entry.id), { force: true })
        total -= entry.bytes
        const shared = entries.some((other) => other.id !== entry.id && other.sha256 === entry.sha256)
        if (!shared && !(await o.store.userAttachment(entry.sha256)))
          await rm(join(o.store.root, 'sha256', entry.sha256.slice(0, 2), entry.sha256), { force: true })
      }
    },
  }
}
