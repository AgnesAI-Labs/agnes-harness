import { ARTIFACT_RECLAIMED_FAILURE, REQUEST_MEDIA_ARTIFACT_RECLAIMED } from '@agnes/host'
import type { EventEnvelope } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { readScreenshotBytes, requestMediaOriginIsValid } from '../src/boot/screenshot-read.js'

const sha256 = 'a'.repeat(64)
const signal = new AbortController().signal

function store(get: (mime: string) => Promise<Uint8Array>) {
  return {
    inspect: vi.fn(async ({ mime }: { sha256: string; mime: string }) => ({ sha256, size: 1, mime })),
    get: vi.fn(async (ref: { mime: string }) => get(ref.mime)),
  }
}

describe('local screenshot read for request media', () => {
  it.each([
    ['tool:read', 'trusted', true],
    ['tool:read', 'untrusted', false],
    ['tool:computer_use', 'untrusted', true],
    ['tool:computer_use', 'trusted', false],
    ['tool:document_read', 'untrusted', true],
    ['tool:document_read', 'trusted', false],
    ['tool:other', 'trusted', false],
    ['tool:other', 'untrusted', false],
  ] as const)('checks image result origin %s and trust %s', (origin, trust, allowed) => {
    expect(requestMediaOriginIsValid({ origin, trust })).toBe(allowed)
  })
  it.each([
    ['a trusted result of a call that declared images', true, 'tool:read_device', 'trusted', 2, true],
    ['a trusted result of a call that did not declare them', false, 'tool:read_device', 'trusted', 2, false],
    ['an untrusted result of a call that declared images', true, 'tool:read_device', 'untrusted', 2, false],
    ['a result naming another call as its source', true, 'tool:read_device', 'trusted', 1, false],
    ['a result under another tool name', true, 'tool:other', 'trusted', 2, false],
  ] as const)(
    'another tool: allows %s only when declared',
    (_label, declared, origin, trust, source, allowed) => {
      const call = {
        seq: 2,
        lane: 'main',
        type: 'tool/call',
        origin: 'model',
        trust: 'trusted',
        data: {
          toolUseId: 'call-1',
          name: 'read_device',
          resolvedPolicy: declared ? { returnsImages: true } : {},
        },
      } as unknown as EventEnvelope
      const result = { origin, trust, lane: 'main', sourceEventSeqs: [source], data: { toolUseId: 'call-1' } }
      expect(requestMediaOriginIsValid(result, call)).toBe(allowed)
    },
  )
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
