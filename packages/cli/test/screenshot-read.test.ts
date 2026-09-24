import { ARTIFACT_RECLAIMED_FAILURE, REQUEST_MEDIA_ARTIFACT_RECLAIMED } from '@agnes/host'
import { describe, expect, it, vi } from 'vitest'
import { readScreenshotBytes } from '../src/boot/screenshot-read.js'

const sha256 = 'a'.repeat(64)
const signal = new AbortController().signal

function store(get: (mime: string) => Promise<Uint8Array>) {
  return {
    inspect: vi.fn(async ({ mime }: { sha256: string; mime: string }) => ({ sha256, size: 1, mime })),
    get: vi.fn(async (ref: { mime: string }) => get(ref.mime)),
  }
}

describe('local screenshot read for request media', () => {
  it('returns the reclaimed sentinel at the first MIME, after re-checking the reader', async () => {
    const artifacts = store(async () => {
      throw ARTIFACT_RECLAIMED_FAILURE
    })
    const stillAuthorized = vi.fn(() => true)
    await expect(readScreenshotBytes(artifacts, sha256, signal, stillAuthorized)).resolves.toBe(
      REQUEST_MEDIA_ARTIFACT_RECLAIMED,
    )
    expect(artifacts.inspect).toHaveBeenCalledOnce()
    expect(stillAuthorized).toHaveBeenCalledOnce()
  })

  it('gives nothing once the reader lost its authority, reclaimed or not', async () => {
    const reclaimed = store(async () => {
      throw ARTIFACT_RECLAIMED_FAILURE
    })
    await expect(readScreenshotBytes(reclaimed, sha256, signal, () => false)).resolves.toBeUndefined()
    const present = store(async () => new Uint8Array([1]))
    await expect(readScreenshotBytes(present, sha256, signal, () => false)).resolves.toBeUndefined()
  })

  it('tries the other MIME after an ordinary failure and fails closed when both fail', async () => {
    const jpeg = store(async (mime) => {
      if (mime === 'image/png') throw new Error('not png')
      return new Uint8Array([2])
    })
    await expect(readScreenshotBytes(jpeg, sha256, signal, () => true)).resolves.toEqual(new Uint8Array([2]))
    const missing = store(async () => {
      throw new Error('artifact bytes unavailable')
    })
    await expect(readScreenshotBytes(missing, sha256, signal, () => true)).resolves.toBeUndefined()
    expect(missing.inspect).toHaveBeenCalledTimes(2)
  })
})
