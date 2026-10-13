import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { requestImageTransform } from '@agnes/core'
import { afterEach, describe, expect, it } from 'vitest'
import { type AttachmentStore, createAttachmentStore } from '../src/attachment-store.js'
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
const setup = (
  encoder: ImageVersionEncoder = identityImageEncoder,
  extra: { clock?: () => number; wrap?: (store: AttachmentStore) => AttachmentStore } = {},
) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agh-rv-'))
  dirs.push(dataDir)
  const store = createAttachmentStore({ dataDir })
  const root = join(dataDir, 'artifacts', 'request-versions')
  return {
    store,
    root,
    dataDir,
    cache: createRequestVersionCache({
      store: extra.wrap ? extra.wrap(store) : store,
      root,
      maxBytes: 1024,
      encoder,
      ...(extra.clock ? { clock: extra.clock } : {}),
    }),
  }
}
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}
/** An 8-bit grey PNG of the given size. */
const grey = (w: number, h: number) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  const rows = Buffer.alloc((w + 1) * h)
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}
const png = { mimeType: 'image/png' }
const indexFiles = (root: string) => readdirSync(root).filter((n) => n.endsWith('.json'))
const objectPath = (store: AttachmentStore, sha: string) => join(store.root, 'sha256', sha.slice(0, 2), sha)
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
    const second = await cache.getOrCreate({ ...src, mimeType: 'image/png' }, { ...tiny, maxBytes: 11 })
    await cache.trim()
    expect(await store.stat(first.object.sha256)).toBeUndefined()
    expect(await store.stat(second.object.sha256)).toEqual(second.object)
    expect(await store.stat(src.sha256)).toEqual(src)
  })

  it('keeps a version that is also a user attachment, and counts only what trimming can free', async () => {
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
    const first = await cache.getOrCreate({ ...src, ...png }, tiny)
    const second = await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 11 })
    await store.markUserAttachment(first.object, { mimeType: 'image/jpeg' })
    await cache.trim()
    expect(await store.stat(first.object.sha256)).toEqual(first.object)
    expect(await store.stat(second.object.sha256)).toEqual(second.object)
  })

  it('keeps an object while another index entry still references it', async () => {
    const fill = new Map([
      [11, 7],
      [12, 8],
      [13, 7],
    ])
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode(_input, target) {
        return {
          bytes: new Uint8Array(600).fill(fill.get(target.maxBytes) ?? 0),
          mimeType: 'image/jpeg',
          width: 1,
          height: 1,
        }
      },
    }
    const { store, cache, root } = setup(encoder)
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    const a = await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 11 })
    const x = await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 12 })
    const b = await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 13 })
    expect(a.object).toEqual(b.object)
    await cache.trim()
    expect(await store.stat(x.object.sha256)).toBeUndefined()
    expect(await store.stat(a.object.sha256)).toEqual(a.object)
    expect(indexFiles(root)).toEqual([`${b.id}.json`])
  })

  it('treats a garbled or malformed index file as a miss and heals it', async () => {
    let calls = 0
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode() {
        calls++
        return { bytes: Uint8Array.of(1, 2, 3), mimeType: 'image/jpeg', width: 1, height: 1 }
      },
    }
    const { store, cache, root } = setup(encoder)
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    const made = await cache.getOrCreate({ ...src, ...png }, tiny)
    const file = join(root, `${made.id}.json`)
    writeFileSync(file, '{"id":')
    expect((await cache.getOrCreate({ ...src, ...png }, tiny)).object).toEqual(made.object)
    expect(calls).toBe(2)
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe(made.id)
    writeFileSync(
      file,
      JSON.stringify({
        id: made.id,
        sha256: '../../etc/passwd',
        bytes: 3,
        mimeType: 'image/png',
        width: 1,
        height: 1,
        lastUsedMs: 1,
      }),
    )
    await cache.getOrCreate({ ...src, ...png }, tiny)
    expect(calls).toBe(3)
  })

  it('trim skips and removes bad index files and still trims the rest', async () => {
    let n = 0
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode() {
        n++
        return { bytes: new Uint8Array(600).fill(n), mimeType: 'image/jpeg', width: 1, height: 1 }
      },
    }
    const { store, cache, root } = setup(encoder)
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    const first = await cache.getOrCreate({ ...src, ...png }, tiny)
    const second = await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 11 })
    const bad = 'c'.repeat(64)
    writeFileSync(join(root, `${bad}.json`), 'not json')
    writeFileSync(
      join(root, `${'d'.repeat(64)}.json`),
      JSON.stringify({ id: 'd'.repeat(64), sha256: '../x', bytes: 1 }),
    )
    await cache.trim()
    expect(indexFiles(root).sort()).toEqual([`${second.id}.json`])
    expect(await store.stat(first.object.sha256)).toBeUndefined()
  })

  it('sweeps stale temporary index files but not fresh ones', async () => {
    const { cache, root, store } = setup()
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    await cache.getOrCreate({ ...src, ...png }, fits)
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'old.json.1.tmp'), '{}')
    writeFileSync(join(root, 'new.json.2.tmp'), '{}')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(join(root, 'old.json.1.tmp'), old, old)
    await cache.trim()
    expect(readdirSync(root).filter((n) => n.endsWith('.tmp'))).toEqual(['new.json.2.tmp'])
  })

  it('does not index a result identical to its source', async () => {
    const { store, cache, root } = setup()
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    await cache.getOrCreate({ ...src, ...png }, fits)
    expect(existsSync(root) ? indexFiles(root) : []).toEqual([])
  })

  it('stamps versions made in one millisecond in strictly increasing order', async () => {
    const encoder: ImageVersionEncoder = {
      id: 'test',
      async encode(_input, target) {
        return { bytes: Uint8Array.of(target.maxBytes), mimeType: 'image/jpeg', width: 1, height: 1 }
      },
    }
    const { store, cache, root } = setup(encoder, { clock: () => 5 })
    const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
    await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 11 })
    await cache.getOrCreate({ ...src, ...png }, { ...tiny, maxBytes: 12 })
    const stamps = indexFiles(root).map(
      (n) => JSON.parse(readFileSync(join(root, n), 'utf8')).lastUsedMs as number,
    )
    expect(stamps.sort()).toEqual([5, 6])
  })

  describe('self-healing on a hit', () => {
    const counting = () => {
      let calls = 0
      const encoder: ImageVersionEncoder = {
        id: 'test',
        async encode() {
          calls++
          return { bytes: Uint8Array.of(1, 2, 3, calls), mimeType: 'image/jpeg', width: 1, height: 1 }
        },
      }
      return { encoder, calls: () => calls }
    }

    const fixed = () => {
      let calls = 0
      const encoder: ImageVersionEncoder = {
        id: 'test',
        async encode() {
          calls++
          return { bytes: Uint8Array.of(1, 2, 3, 4), mimeType: 'image/jpeg', width: 1, height: 1 }
        },
      }
      return { encoder, calls: () => calls }
    }

    it('redoes a version whose bytes no longer match their digest, replacing the corrupt file', async () => {
      const { encoder, calls } = fixed()
      const { store, cache, root } = setup(encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const made = await cache.getOrCreate({ ...src, ...png }, tiny)
      writeFileSync(objectPath(store, made.object.sha256), Uint8Array.of(9, 9, 9, 9))
      const again = await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(calls()).toBe(2)
      expect(again.object).toEqual(made.object)
      expect(await store.read(again.object.sha256)).toEqual(Uint8Array.of(1, 2, 3, 4))
      expect(indexFiles(root)).toEqual([`${made.id}.json`])
    })

    it('leaves a corrupt object alone when it is also a user attachment', async () => {
      const { encoder } = fixed()
      const { store, cache } = setup(encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const made = await cache.getOrCreate({ ...src, ...png }, tiny)
      await store.markUserAttachment(made.object, { mimeType: 'image/jpeg' })
      writeFileSync(objectPath(store, made.object.sha256), Uint8Array.of(9, 9, 9, 9))
      await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(new Uint8Array(readFileSync(objectPath(store, made.object.sha256)))).toEqual(
        Uint8Array.of(9, 9, 9, 9),
      )
    })

    it('does not delete an object that was replaced between the failed read and the delete', async () => {
      const { encoder } = fixed()
      let swapped = false
      let presentAtRedo: boolean | undefined
      let version: { sha256: string } | undefined
      const { store, cache } = setup(encoder, {
        wrap: (inner) => ({
          ...inner,
          async read(sha, range, signal) {
            if (sha === version?.sha256 && !swapped) {
              swapped = true
              // A concurrent writer puts the correct bytes in place under a new file, then our read fails.
              const fresh = `${objectPath(inner, sha)}.fresh`
              writeFileSync(fresh, Uint8Array.of(1, 2, 3, 4))
              renameSync(fresh, objectPath(inner, sha))
              throw Object.assign(new Error('corrupt'), { code: 'ATTACHMENT_CORRUPT' })
            }
            return inner.read(sha, range, signal)
          },
          async put(bytes, meta) {
            if (swapped)
              presentAtRedo = existsSync(objectPath(inner, createHash('sha256').update(bytes).digest('hex')))
            return inner.put(bytes, meta)
          },
        }),
      })
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const made = await cache.getOrCreate({ ...src, ...png }, tiny)
      version = made.object
      writeFileSync(objectPath(store, made.object.sha256), Uint8Array.of(9, 9, 9, 9))
      await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(presentAtRedo).toBe(true)
      expect(await store.read(made.object.sha256)).toEqual(Uint8Array.of(1, 2, 3, 4))
    })

    it('redoes a version whose object is gone', async () => {
      const { encoder, calls } = counting()
      const { store, cache } = setup(encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const made = await cache.getOrCreate({ ...src, ...png }, tiny)
      rmSync(objectPath(store, made.object.sha256))
      await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(calls()).toBe(2)
    })

    it('keeps the entry when the read is aborted or fails for another reason', async () => {
      const { encoder, calls } = counting()
      let mode: 'ok' | 'hang' | 'timeout' = 'ok'
      let hangStarted = () => {}
      const hanging = new Promise<void>((resolve) => {
        hangStarted = resolve
      })
      const { store, cache, root } = setup(encoder, {
        wrap: (inner) => ({
          ...inner,
          async read(sha, range, signal) {
            if (mode === 'hang' && sha !== src.sha256)
              await new Promise((_, reject) => {
                signal?.addEventListener('abort', () => reject(signal.reason))
                hangStarted()
              })
            if (mode === 'timeout' && sha !== src.sha256)
              throw Object.assign(new Error('late'), { code: 'ATTACHMENT_TIMEOUT' })
            return inner.read(sha, range, signal)
          },
        }),
      })
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const made = await cache.getOrCreate({ ...src, ...png }, tiny)
      mode = 'hang'
      const controller = new AbortController()
      const pending = cache.getOrCreate({ ...src, ...png }, tiny, controller.signal)
      await hanging
      controller.abort()
      await expect(pending).rejects.toBeDefined()
      mode = 'timeout'
      await expect(cache.getOrCreate({ ...src, ...png }, tiny)).rejects.toMatchObject({
        code: 'ATTACHMENT_TIMEOUT',
      })
      expect(indexFiles(root)).toEqual([`${made.id}.json`])
      expect(await store.stat(made.object.sha256)).toEqual(made.object)
      mode = 'ok'
      await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(calls()).toBe(1)
    })

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'still returns a hit when the recency stamp cannot be written',
      async () => {
        const { encoder, calls } = counting()
        const { store, cache, root } = setup(encoder)
        const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
        const made = await cache.getOrCreate({ ...src, ...png }, tiny)
        chmodSync(root, 0o500)
        try {
          const again = await cache.getOrCreate({ ...src, ...png }, tiny)
          expect(again.object).toEqual(made.object)
        } finally {
          chmodSync(root, 0o700)
        }
        expect(calls()).toBe(1)
        expect(indexFiles(root)).toEqual([`${made.id}.json`])
      },
    )
  })

  describe('callers sharing one piece of work', () => {
    const slow = () => {
      let calls = 0
      let encoderSignal: AbortSignal | undefined
      let started = () => {}
      const encoding = new Promise<void>((resolve) => {
        started = resolve
      })
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const encoder: ImageVersionEncoder = {
        id: 'test',
        async encode(_input, _target, signal) {
          calls++
          encoderSignal = signal
          started()
          await new Promise<void>((resolve, reject) => {
            gate.then(resolve)
            signal?.addEventListener('abort', () => reject(signal.reason))
          })
          return { bytes: Uint8Array.of(1, 2, 3), mimeType: 'image/jpeg', width: 1, height: 1 }
        },
      }
      return { encoder, encoding, release, calls: () => calls, signal: () => encoderSignal }
    }

    it('lets one caller abort without failing the other', async () => {
      const probe = slow()
      const { store, cache } = setup(probe.encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const a = new AbortController()
      const first = cache.getOrCreate({ ...src, ...png }, tiny, a.signal)
      const second = cache.getOrCreate({ ...src, ...png }, tiny)
      first.catch(() => undefined)
      await probe.encoding
      a.abort()
      await expect(first).rejects.toBeDefined()
      probe.release()
      expect((await second).object.bytes).toBe(3)
      expect(probe.calls()).toBe(1)
      expect(probe.signal()?.aborted).toBe(false)
    })

    it('stops the work when every caller has left, and starts afresh for the next one', async () => {
      const probe = slow()
      const { store, cache } = setup(probe.encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      const a = new AbortController()
      const b = new AbortController()
      const one = cache.getOrCreate({ ...src, ...png }, tiny, a.signal)
      const two = cache.getOrCreate({ ...src, ...png }, tiny, b.signal)
      await probe.encoding
      a.abort()
      b.abort()
      await expect(one).rejects.toBeDefined()
      await expect(two).rejects.toBeDefined()
      expect(probe.signal()?.aborted).toBe(true)
      probe.release()
      const next = await cache.getOrCreate({ ...src, ...png }, tiny)
      expect(next.object.bytes).toBe(3)
      expect(probe.calls()).toBe(2)
    })

    it('rejects at once for a signal that is already aborted', async () => {
      const probe = slow()
      const { store, cache } = setup(probe.encoder)
      const src = await store.put(PNG, { kind: 'user-attachment', mimeType: 'image/png' })
      await expect(cache.getOrCreate({ ...src, ...png }, tiny, AbortSignal.abort())).rejects.toBeDefined()
      expect(probe.calls()).toBe(0)
    })
  })
})

describe('identity image encoder', () => {
  const big = requestImageTransform({ maxWidth: 100, maxHeight: 100, maxPixels: 10_000, maxBytes: 1 << 20 })
  const encode = (bytes: Uint8Array, target = big) =>
    identityImageEncoder.encode({ bytes, mimeType: 'image/png' }, target)

  it('returns the source with its real dimensions', async () => {
    const bytes = grey(3, 2)
    const out = await encode(bytes)
    expect([out.width, out.height, out.mimeType]).toEqual([3, 2, 'image/png'])
    expect(out.bytes).toBe(bytes)
  })

  it('asks for a resize on width, height, pixels, bytes and format', async () => {
    await expect(encode(grey(3, 2), { ...big, maxWidth: 2 })).rejects.toMatchObject({
      code: 'IMAGE_RESIZE_REQUIRED',
    })
    await expect(encode(grey(3, 2), { ...big, maxHeight: 1 })).rejects.toMatchObject({
      code: 'IMAGE_RESIZE_REQUIRED',
    })
    await expect(encode(grey(3, 2), { ...big, maxPixels: 5 })).rejects.toMatchObject({
      code: 'IMAGE_RESIZE_REQUIRED',
    })
    await expect(encode(grey(3, 2), { ...big, maxBytes: 20 })).rejects.toMatchObject({
      code: 'IMAGE_RESIZE_REQUIRED',
    })
    await expect(
      encode(grey(3, 2), { ...big, encoder: { formats: ['jpeg'], jpegQualities: [85] } }),
    ).rejects.toMatchObject({ code: 'IMAGE_RESIZE_REQUIRED' })
  })

  it('reports bytes that are not an image as undecodable', async () => {
    await expect(encode(Uint8Array.of(1, 2, 3, 4))).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' })
  })
})
