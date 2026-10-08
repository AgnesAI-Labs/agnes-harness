import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  composeProductionRequestMedia,
  createProductionImageInputTokenFallback,
  type ProductionRequestMediaConfiguration,
} from '../src/request-media-runtime.js'

const configuration = (): ProductionRequestMediaConfiguration => ({
  readArtifact: vi.fn(async () => undefined),
  surfaceLimits: {
    maxLedgerEvents: 64,
    maxSurfaceNodes: 32,
    maxContentBlocks: 32,
    maxManifestEntries: 8,
    maxCandidateBytes: 4_096,
    maxCandidatePixels: 65_536,
  },
  mediaLimits: {
    maxManifestEntries: 8,
    maxSelectedImages: 3,
    maxSelectedBlocks: 8,
    maxBytesPerImage: 4_096,
    maxDimensionPerImage: 1456,
    maxPixelsPerImage: 65_536,
    maxSelectedBytes: 12_288,
    maxSelectedPixels: 196_608,
  },
})

describe('production request-media composition', () => {
  it('snapshots explicit reviewed limits without minting auxiliary admission', () => {
    const input = configuration()
    const runtime = composeProductionRequestMedia(input)

    expect(runtime.readArtifact).toBe(input.readArtifact)
    expect(runtime.surfaceLimits).toEqual(input.surfaceLimits)
    expect(runtime.mediaLimits).toEqual(input.mediaLimits)
    expect(Object.isFrozen(runtime)).toBe(true)
    expect(Object.isFrozen(runtime.surfaceLimits)).toBe(true)
    expect(Object.isFrozen(runtime.mediaLimits)).toBe(true)
    expect(Object.hasOwn(runtime, 'auxiliaryVision')).toBe(false)

    ;(input.surfaceLimits as { maxLedgerEvents: number }).maxLedgerEvents = 1
    expect(runtime.surfaceLimits.maxLedgerEvents).toBe(64)
  })

  it('fails closed for missing, extra, zero, accessor, and proxy configuration', () => {
    const fixed = 'production request-media configuration is invalid'
    const extra = { ...configuration(), auxiliaryVision: { productionAdmission: {} } }
    const zero = configuration()
    ;(zero.mediaLimits as { maxSelectedImages: number }).maxSelectedImages = 0
    let touched = false
    const accessor = Object.defineProperty(configuration(), 'surfaceLimits', {
      enumerable: true,
      get() {
        touched = true
        return configuration().surfaceLimits
      },
    })
    const proxy = new Proxy(configuration(), {
      get() {
        throw new Error('credential-shaped secret')
      },
    })

    for (const input of [
      undefined,
      { ...configuration(), mediaLimits: undefined },
      extra,
      zero,
      accessor,
      proxy,
    ])
      expect(() => composeProductionRequestMedia(input as never)).toThrow(fixed)
    expect(touched).toBe(false)
  })

  it('rejects a proxied authority instead of admitting an uninspectable reader', () => {
    const input = configuration()
    ;(input as { readArtifact: ProductionRequestMediaConfiguration['readArtifact'] }).readArtifact =
      new Proxy(input.readArtifact, {
        apply() {
          throw new Error('must never dispatch')
        },
      })

    expect(() => composeProductionRequestMedia(input)).toThrow(
      'production request-media configuration is invalid',
    )
  })
})

describe('production image token fallback', () => {
  type FallbackInput = Parameters<ReturnType<typeof createProductionImageInputTokenFallback>>[0]
  const image = Buffer.from('trusted screenshot bytes')
  const data = image.toString('base64')
  const sha256 = createHash('sha256').update(image).digest('hex')
  const wire = {
    kind: 'inference',
    sessionKey: 's',
    slot: 'primary',
    route: 'gw',
    model: 'vision',
    contractId: null,
    derivedHash: '0'.repeat(64),
    system: 'system',
    messages: [
      {
        role: 'tool_result',
        toolUseId: 'tool-1',
        isError: false,
        content: [
          { type: 'text', text: 'untrusted screenshot' },
          { type: 'image', data, mimeType: 'image/png' },
        ],
      },
    ],
    tools: [],
  } as const
  const media: NonNullable<FallbackInput['media']> = {
    version: 1,
    route: 'native-image',
    selectionOrder: [0],
    manifest: [
      {
        nodeSeq: 7,
        artifactUri: `artifact://${sha256}`,
        sha256,
        mime: 'image/png',
        width: 32,
        height: 24,
        selected: true,
      },
    ],
  }

  it('bounds the complete wire after matching persisted image bytes to the manifest', async () => {
    const fallback = createProductionImageInputTokenFallback()
    const result = await fallback({
      wire: wire as never,
      media,
      imageCount: 1,
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ tokens: JSON.stringify(wire).length, imageCount: 1 })
  })

  it('fails closed when persisted bytes, image count, or cancellation do not match', async () => {
    const fallback = createProductionImageInputTokenFallback()
    const signal = new AbortController()
    const mismatched = structuredClone(media)
    mismatched.manifest[0]!.sha256 = '1'.repeat(64)
    mismatched.manifest[0]!.artifactUri = `artifact://${'1'.repeat(64)}`

    await expect(
      fallback({ wire: wire as never, media: mismatched as never, imageCount: 1, signal: signal.signal }),
    ).resolves.toBeNull()
    await expect(
      fallback({ wire: wire as never, media, imageCount: 2, signal: signal.signal }),
    ).resolves.toBeNull()
    signal.abort()
    await expect(
      fallback({ wire: wire as never, media, imageCount: 1, signal: signal.signal }),
    ).resolves.toBeNull()
  })

  it('includes user-inline images without requiring a persisted media manifest', async () => {
    const fallback = createProductionImageInputTokenFallback()
    const userWire = {
      ...wire,
      messages: [{ role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] }],
    }

    await expect(
      fallback({
        wire: userWire as never,
        imageCount: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ tokens: JSON.stringify(userWire).length, imageCount: 1 })
  })
})
