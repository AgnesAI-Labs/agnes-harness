import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestImageTransform } from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createAttachmentStore } from '../src/attachment-store.js'
import {
  createRequestVersionCache,
  type ImageVersionEncoder,
  identityImageEncoder,
} from '../src/request-versions.js'

// 1x1 PNG
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64',
  ),
)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const setup = (encoder: ImageVersionEncoder = identityImageEncoder) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agh-rv-'))
  dirs.push(dataDir)
  const store = createAttachmentStore({ dataDir })
  return {
    store,
    cache: createRequestVersionCache({
      store,
      root: join(dataDir, 'artifacts', 'request-versions'),
      maxBytes: 1024,
      encoder,
    }),
  }
}
const fits = requestImageTransform({
  maxWidth: 1456,
  maxHeight: 1456,
  maxPixels: 2_119_936,
  maxBytes: 4 << 20,
})
const tiny = requestImageTransform({ maxWidth: 1, maxHeight: 1, maxPixels: 1, maxBytes: 10 })

describe('request version cache', () => {
  it('returns the source object unchanged when it already fits', async () => {
    const { store, cache } = setup()
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    const out = await cache.getOrCreate({ ...src, mimeType: 'image/png' }, fits)
    expect(out.object).toEqual(src)
    expect([out.image.width, out.image.height]).toEqual([1, 1])
  })

  it('refuses with IMAGE_RESIZE_REQUIRED when the identity encoder cannot satisfy the target', async () => {
    const { store, cache } = setup()
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    await expect(cache.getOrCreate({ ...src, mimeType: 'image/png' }, tiny)).rejects.toMatchObject({
      code: 'IMAGE_RESIZE_REQUIRED',
    })
  })

  it('stores a transformed version once, even for concurrent callers, and reuses it', async () => {
    let calls = 0
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode() {
        calls++
        await new Promise((r) => setTimeout(r, 5))
        return { bytes: Uint8Array.of(1, 2, 3), mimeType: 'image/jpeg', width: 1, height: 1 }
      },
    }
    const { store, cache } = setup(encoder)
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    const [a, b] = await Promise.all([
      cache.getOrCreate({ ...src, mimeType: 'image/png' }, tiny),
      cache.getOrCreate({ ...src, mimeType: 'image/png' }, tiny),
    ])
    expect(calls).toBe(1)
    expect(a.object).toEqual(b.object)
    await cache.getOrCreate({ ...src, mimeType: 'image/png' }, tiny)
    expect(calls).toBe(1)
  })

  it('trims least recently used versions under the byte budget without touching user attachments', async () => {
    let n = 0
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode() {
        n++
        return { bytes: new Uint8Array(600).fill(n), mimeType: 'image/jpeg', width: 1, height: 1 }
      },
    }
    const { store, cache } = setup(encoder)
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    await store.markUserAttachment(src, { mimeType: 'image/png' })
    const first = await cache.getOrCreate({ ...src, mimeType: 'image/png' }, tiny)
    await cache.getOrCreate({ ...src, mimeType: 'image/png' }, { ...tiny, maxBytes: 11 })
    await cache.trim()
    expect(await store.stat(first.object.sha256)).toBeUndefined()
    expect(await store.stat(src.sha256)).toEqual(src)
  })
})
