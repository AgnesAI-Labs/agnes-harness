import { describe, expect, it, vi } from 'vitest'

const unavailable = vi.hoisted(() => ({ fail: true, loads: 0 }))
vi.mock('node:module', async (original) => {
  const actual = await original<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const require = actual.createRequire(url)
      return (id: string) => {
        if (id === 'sharp') {
          unavailable.loads++
          if (unavailable.fail) throw new Error('synthetic unsupported native codec')
        }
        return require(id)
      }
    },
  }
})

import { validateApplicationImage } from '../src/application-image.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==',
  'base64',
)

describe('lazy application image codec', () => {
  it('is not loaded until an image is checked, fails closed by name, and retries a failed load', async () => {
    // Evaluating the module must not touch the native codec: a single-executable build cannot
    // load it that way, and daemon start imports this module whether or not any image is checked.
    expect(unavailable.loads).toBe(0)
    await expect(validateApplicationImage(png, 'image/png')).rejects.toThrow(
      'application-asset-codec-unavailable',
    )
    expect(unavailable.loads).toBe(1)
    unavailable.fail = false
    await expect(validateApplicationImage(png, 'image/png')).resolves.toBeUndefined()
  })
})
