import { describe, expect, it, vi } from 'vitest'
import { fakeToolContext } from '../../../testkit/tool-context.js'

const unavailable = vi.hoisted(() => ({ fail: true }))
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url)
      return (id: string) => {
        if (id === 'sharp' && unavailable.fail) throw new Error('synthetic unsupported native codec')
        return require(id)
      }
    },
  }
})

import { readTool } from '../src/tools/read.js'

describe('lazy image codec', () => {
  it('keeps ordinary tools usable without the optional codec and retries a failed load', async () => {
    const base = fakeToolContext()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const ctx = {
      ...base,
      fs: { ...base.fs, read: async () => bytes },
      session: {
        ...base.session,
        imageInputPolicy: async () => ({
          supported: true,
          maxWidth: 1456,
          maxHeight: 1456,
          maxBytes: 10000,
          maxPixels: 1456 * 1456,
        }),
        imageInput: async () => {
          throw new Error('invalid pixels must never reach the model')
        },
      },
    }
    expect(await readTool.execute({ path: 'image.png' }, ctx)).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('codec is unavailable') }],
    })
    const text = await readTool.execute(
      { path: 'notes.txt' },
      { ...ctx, fs: { ...ctx.fs, read: async () => new TextEncoder().encode('plain text') } },
    )
    expect(text.isError).not.toBe(true)
    expect(text.content).toMatchObject([{ text: expect.stringContaining('plain text') }])
    unavailable.fail = false
    const malformed = await readTool.execute({ path: 'image.png' }, ctx)
    expect(malformed).toMatchObject({ isError: true })
    expect(JSON.stringify(malformed)).not.toContain('codec is unavailable')
    expect(JSON.stringify(malformed)).not.toContain('synthetic unsupported')
  })
})
