import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { trimNativeHeap } from '../src/index.js'

const linux = process.platform === 'linux'

describe('trimNativeHeap', () => {
  it('resolves on every platform and shares a trim that is still running', async () => {
    const first = trimNativeHeap()
    expect(trimNativeHeap()).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(trimNativeHeap()).resolves.toBeUndefined()
  })

  it.runIf(linux)('trims the glibc heap through the Linux addon', async () => {
    const native = createRequire(import.meta.url)('../dist/native/agnes-system.node') as {
      trimNativeHeap(): Promise<boolean>
    }
    await expect(native.trimNativeHeap()).resolves.toBeTypeOf('boolean')
  })
})
