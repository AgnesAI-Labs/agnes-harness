import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { trimNativeHeap } from '../src/index.js'

const linux = process.platform === 'linux'

// The real addon unless a case replaces it: one that cannot load, or one whose trim rejects.
const fake = vi.hoisted(() => ({ addon: 'real' as 'real' | 'unloadable' | 'rejecting', trims: 0 }))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire: (url: string | URL) => {
      const real = actual.createRequire(url)
      return Object.assign((id: string) => {
        if (id !== '@agnes/system-node/native' || fake.addon === 'real') return real(id)
        if (fake.addon === 'unloadable') throw new Error('GLIBC_2.99 not found')
        return {
          abiVersion: 1,
          trimNativeHeap: () => {
            fake.trims++
            return Promise.reject(new Error('trim failed'))
          },
        }
      }, real)
    },
  }
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
async function loadAsLinux(): Promise<typeof import('../src/native-heap.js')> {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
  try {
    return await import('../src/native-heap.js')
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform)
  }
}

afterEach(() => {
  fake.addon = 'real'
  fake.trims = 0
})

describe('trimNativeHeap', () => {
  it('resolves on every platform and shares a trim that is still running', async () => {
    const first = trimNativeHeap()
    expect(trimNativeHeap()).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(trimNativeHeap()).resolves.toBeUndefined()
  })

  it.each([
    ['cannot be loaded', 'unloadable', 0],
    ['rejects the trim', 'rejecting', 1],
  ] as const)('still resolves on Linux when the addon %s', async (_case, addon, trims) => {
    fake.addon = addon
    const loaded = await loadAsLinux()
    await expect(loaded.trimNativeHeap()).resolves.toBeUndefined()
    expect(fake.trims).toBe(trims)
  })

  it.runIf(linux)('trims the glibc heap through the Linux addon', async () => {
    const native = createRequire(import.meta.url)('../dist/native/agnes-system.node') as {
      trimNativeHeap(): Promise<boolean>
    }
    await expect(native.trimNativeHeap()).resolves.toBeTypeOf('boolean')
  })
})
