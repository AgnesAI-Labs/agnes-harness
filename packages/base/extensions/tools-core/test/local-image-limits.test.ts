import type { ToolContext } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'

const codec = vi.hoisted(() => ({
  metadata: { width: 16, height: 16, channels: 4, depth: 'uchar', format: 'png', isProgressive: false },
  waits: [] as Promise<unknown>[],
}))
vi.mock('node:module', () => ({
  createRequire: () => () => {
    const factory = () => ({
      metadata: () => codec.waits.shift() ?? Promise.resolve(codec.metadata),
      clone() {
        return this
      },
      rotate() {
        return this
      },
      resize() {
        return this
      },
      timeout() {
        return this
      },
      png() {
        return this
      },
      jpeg() {
        return this
      },
      toBuffer: async () => new Uint8Array([1]),
    })
    factory.cache = () => undefined
    return factory
  },
}))

import { IMAGE_PREPARE_TIMEOUT_MS, readLocalImage } from '../src/tools/local-image.js'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const metadata = { ...codec.metadata }
function context(signal = new AbortController().signal) {
  const base = fakeToolContext(),
    images: unknown[] = []
  const ctx: ToolContext = {
    ...base,
    signal,
    session: {
      ...base.session,
      imageInputPolicy: async () => ({
        supported: true,
        maxWidth: 1456,
        maxHeight: 1456,
        maxBytes: 1024,
        maxPixels: 1456 * 1456,
      }),
      imageInput: async (image) => {
        images.push(image)
        return { content: [{ type: 'text', text: 'prepared' }] }
      },
    },
  }
  return { ctx, images }
}
afterEach(() => {
  codec.metadata = { ...metadata }
  codec.waits = []
  vi.useRealTimers()
})

it.each([
  { width: 8001, height: 8000 },
  { width: 8000, height: 8000, depth: 'ushort' },
  { width: 5000, height: 4000, isProgressive: true },
])('refuses a decoded memory/pixel boundary before sending pixels: %j', async (change) => {
  codec.metadata = { ...metadata, ...change }
  const f = context()
  expect(await readLocalImage(png, 'large.png', f.ctx)).toMatchObject({
    isError: true,
    details: { code: 'FS_IMAGE_DECODE_LIMIT' },
    content: [{ text: expect.stringContaining('Resize/export') }],
  })
  expect(f.images).toEqual([])
})

it('holds a cancelled native decode slot until that work stops, while respecting the process bound', async () => {
  let releaseA!: (value: unknown) => void, releaseB!: (value: unknown) => void
  codec.waits = [
    new Promise((resolve) => {
      releaseA = resolve
    }),
    new Promise((resolve) => {
      releaseB = resolve
    }),
  ]
  const abort = new AbortController(),
    a = context(abort.signal),
    b = context(),
    c = context()
  const first = readLocalImage(png, 'a.png', a.ctx).catch((error) => error)
  const second = readLocalImage(png, 'b.png', b.ctx)
  const third = readLocalImage(png, 'c.png', c.ctx)
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  abort.abort()
  expect(await first).toMatchObject({ name: 'AbortError' })
  expect(c.images).toEqual([])
  releaseA(metadata)
  expect((await third).isError).not.toBe(true)
  expect(c.images).toHaveLength(1)
  releaseB(metadata)
  await second
  expect(a.images).toEqual([])
})

it('applies one total deadline to queued and running work without emitting late pixels', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let finish!: (value: unknown) => void
  codec.waits = [
    new Promise((resolve) => {
      finish = resolve
    }),
  ]
  const f = context()
  const pending = readLocalImage(png, 'slow.png', f.ctx)
  await vi.advanceTimersByTimeAsync(IMAGE_PREPARE_TIMEOUT_MS + 1)
  expect(await pending).toMatchObject({
    isError: true,
    content: [{ text: expect.stringContaining('total time limit') }],
  })
  finish(metadata)
  await Promise.resolve()
  await Promise.resolve()
  expect(f.images).toEqual([])
})
