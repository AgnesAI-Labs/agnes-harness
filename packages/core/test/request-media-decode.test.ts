import { deflateSync } from 'node:zlib'
import { decodeSafeImageBytes } from '@agnes/protocol-validation'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  prepareRequestMedia,
  type RequestMediaCandidate,
  type RequestMediaLimits,
  recordVerifiedRequestMediaImage,
  restoreRequestMedia,
} from '../src/orchestrator/request-media.js'
import {
  prepareRequestMediaFromSurface,
  requestMediaCandidatesFromSurface,
  restoreRequestMediaFromLedger,
} from '../src/orchestrator/request-media-surface.js'
import type { SurfaceNode } from '../src/project/surface.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { toolCallLookup } from './helpers/request-media-lookup.js'

const decodes = vi.hoisted(() => ({ count: 0 }))
vi.mock('@agnes/protocol-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agnes/protocol-validation')>()
  return {
    ...actual,
    decodeSafeImageBytes: (...args: Parameters<typeof actual.decodeSafeImageBytes>) => {
      decodes.count += 1
      return actual.decodeSafeImageBytes(...args)
    },
  }
})
beforeEach(() => {
  decodes.count = 0
})

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...Buffer.from(type, 'ascii'), ...data]
  let crc = 0xffffffff
  for (const byte of typed) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return [...u32(data.length), ...typed, ...u32((crc ^ 0xffffffff) >>> 0)]
}
function png(width: number, height: number, marker: number): Uint8Array {
  const raw = new Uint8Array(height * (Math.ceil(width / 8) + 1))
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    ...chunk('tEXt', [...Buffer.from(`marker\0${marker}`, 'ascii')]),
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}
function jpeg(width: number, height: number, marker: number): Uint8Array {
  const comment = [...Buffer.from(`m${marker}`, 'ascii')]
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xfe,
    ...u16(comment.length + 2),
    ...comment,
    0xff,
    0xc0,
    0,
    11,
    8,
    ...u16(height),
    ...u16(width),
    1,
    1,
    0x11,
    0,
    0xff,
    0xda,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    0xff,
    0xd9,
  ])
}

/** Deterministic PRNG (mulberry32) so every property run is reproducible from its seed. */
function prng(seed: number) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  return { next, int, chance: (p: number) => next() < p }
}

/** What a Core reader holds after a verified read: the decoder's own copy plus its metadata. */
function verifiedRead(bytes: Uint8Array) {
  const image = decodeSafeImageBytes(
    { bytes, mimeType: bytes[0] === 0xff ? 'image/jpeg' : 'image/png' },
    {
      maxBytesPerImage: 1 << 20,
      maxPixelsPerImage: 1 << 24,
      maxAggregateBytes: 1 << 20,
      maxAggregatePixels: 1 << 24,
    },
  )
  recordVerifiedRequestMediaImage(image, sha256Hex(bytes))
  return image
}

function outcome(run: () => unknown): string {
  try {
    const value = run() as { hashMaterial: unknown }
    return `ok:${canonicalJson(value.hashMaterial)}`
  } catch (error) {
    return `${(error as Error).name}:${(error as { code?: string }).code}`
  }
}

type Trial = Readonly<{
  images: readonly Uint8Array[]
  candidates: (bytesFor: (index: number) => Uint8Array) => RequestMediaCandidate[]
  limits: RequestMediaLimits
}>

function trial(random: ReturnType<typeof prng>): Trial {
  const count = random.int(1, 3)
  const shapes = Array.from({ length: count }, (_, index) => {
    const kind = random.chance(0.5) ? 'png' : 'jpeg'
    const width = kind === 'png' ? random.int(1, 40) : random.int(1, 2000)
    const height = kind === 'png' ? random.int(1, 40) : random.int(1, 2000)
    const bytes =
      kind === 'png' ? png(width, height, random.int(0, 1e9)) : jpeg(width, height, random.int(0, 1e9))
    return { kind, width, height, bytes, index }
  })
  const images = shapes.map((shape) => shape.bytes)
  const claims = shapes.map((shape) => {
    const mime: RequestMediaCandidate['mime'] = shape.kind === 'png' ? 'image/png' : 'image/jpeg'
    const other: RequestMediaCandidate['mime'] = mime === 'image/png' ? 'image/jpeg' : 'image/png'
    const sha256 = random.chance(0.1)
      ? sha256Hex(images[(shape.index + 1) % images.length] as Uint8Array)
      : sha256Hex(shape.bytes)
    return {
      mime: random.chance(0.1) ? other : mime,
      width: random.chance(0.1) ? shape.width + 1 : shape.width,
      height: random.chance(0.1) ? shape.height + 1 : shape.height,
      sha256,
      sourceTool: random.chance(0.7) ? 'computer_use' : 'capture_tool',
    }
  })
  const maxLength = Math.max(...images.map((bytes) => bytes.length))
  const maxPixels = Math.max(...shapes.map((shape) => shape.width * shape.height))
  const totalLength = images.reduce((sum, bytes) => sum + bytes.length, 0)
  const totalPixels = shapes.reduce((sum, shape) => sum + shape.width * shape.height, 0)
  const maxEdge = Math.max(...shapes.flatMap((shape) => [shape.width, shape.height]))
  const around = (value: number) => Math.max(1, random.int(Math.floor(value * 0.6), Math.ceil(value * 1.6)))
  return {
    images,
    limits: {
      maxManifestEntries: 8,
      maxSelectedImages: 4,
      maxSelectedBlocks: 8,
      maxBytesPerImage: around(maxLength),
      maxDimensionPerImage: around(maxEdge),
      maxPixelsPerImage: around(maxPixels),
      maxSelectedBytes: around(totalLength),
      maxSelectedPixels: around(totalPixels),
    },
    candidates: (bytesFor) =>
      claims.map((claim, index) => ({
        nodeSeq: index + 1,
        blockIndex: 0,
        artifactUri: `artifact://${claim.sha256}` as const,
        sha256: claim.sha256,
        mime: claim.mime,
        width: claim.width,
        height: claim.height,
        bytes: bytesFor(index),
        sourceTool: claim.sourceTool,
      })),
  }
}

describe('single decode per selected image', () => {
  it('matches a full second decode on acceptance, output and error code (first-send)', () => {
    const random = prng(0x5eed_0001)
    const seen = new Set<string>()
    for (let run = 0; run < 400; run += 1) {
      const { images, candidates, limits } = trial(random)
      const input = { mainModelInput: ['text', 'image'] as const, auxiliaryVisionAvailable: false, limits }
      const verified = images.map((bytes) => verifiedRead(bytes).bytes)
      const reused = outcome(() =>
        prepareRequestMedia({ ...input, candidates: candidates((index) => verified[index] as Uint8Array) }),
      )
      const decoded = outcome(() =>
        prepareRequestMedia({
          ...input,
          candidates: candidates((index) => Uint8Array.from(images[index] ?? [])),
        }),
      )
      expect(reused, `seed run ${run}`).toBe(decoded)
      seen.add(reused.startsWith('ok:') ? 'ok' : reused)
    }
    // The generator must actually reach every arithmetic and fallback branch it is meant to cover.
    for (const code of [
      'ok',
      'RequestMediaPreflightError:BYTE_LIMIT',
      'RequestMediaPreflightError:PIXEL_LIMIT',
      'RequestMediaPreflightError:DIMENSION_LIMIT',
      'RequestMediaPreflightError:DIGEST_MISMATCH',
      'RequestMediaPreflightError:METADATA_MISMATCH',
      'RequestMediaPreflightError:IMAGE_INVALID',
    ])
      expect(seen).toContain(code)
  })

  it('matches a full second decode on acceptance, output and error code (restore)', () => {
    const random = prng(0x5eed_0002)
    const seen = new Set<string>()
    let restored = 0
    for (let run = 0; run < 400; run += 1) {
      const { images, candidates, limits } = trial(random)
      const generous = {
        ...limits,
        maxBytesPerImage: 1 << 20,
        maxDimensionPerImage: 1 << 16,
        maxPixelsPerImage: 1 << 24,
        maxSelectedBytes: 1 << 20,
        maxSelectedPixels: 1 << 24,
      }
      let header: ReturnType<typeof prepareRequestMedia>['header']
      try {
        header = prepareRequestMedia({
          candidates: candidates((index) => Uint8Array.from(images[index] ?? [])),
          mainModelInput: ['text', 'image'],
          auxiliaryVisionAvailable: false,
          limits: generous,
        }).header
      } catch {
        continue
      }
      const claimed = candidates(() => new Uint8Array())
      const sources = (bytesFor: (index: number) => Uint8Array) =>
        header.selectionOrder.map((manifestIndex) => {
          const entry = header.manifest[manifestIndex]
          const index = claimed.findIndex((candidate) => candidate.nodeSeq === entry?.nodeSeq)
          return {
            manifestIndex,
            blockIndex: 0,
            bytes: bytesFor(index),
            sourceTool: claimed[index]?.sourceTool ?? 'capture_tool',
          }
        })
      const verified = images.map((bytes) => verifiedRead(bytes).bytes)
      const reused = outcome(() =>
        restoreRequestMedia({ header, sources: sources((index) => verified[index] as Uint8Array), limits }),
      )
      const decoded = outcome(() =>
        restoreRequestMedia({
          header,
          sources: sources((index) => Uint8Array.from(images[index] ?? [])),
          limits,
        }),
      )
      expect(reused, `seed run ${run}`).toBe(decoded)
      restored += 1
      seen.add(reused.startsWith('ok:') ? 'ok' : reused)
    }
    expect(restored).toBeGreaterThan(100)
    for (const code of [
      'ok',
      'RequestMediaPreflightError:BYTE_LIMIT',
      'RequestMediaPreflightError:PIXEL_LIMIT',
      'RequestMediaPreflightError:DIMENSION_LIMIT',
    ])
      expect(seen).toContain(code)
  })

  it('reuses a recorded decode only once', () => {
    const bytes = verifiedRead(png(8, 8, 1)).bytes
    const sha256 = sha256Hex(bytes)
    const input = {
      candidates: [
        {
          nodeSeq: 1,
          blockIndex: 0,
          artifactUri: `artifact://${sha256}` as const,
          sha256,
          mime: 'image/png' as const,
          width: 8,
          height: 8,
          bytes,
          sourceTool: 'computer_use',
        },
      ],
      mainModelInput: ['text', 'image'] as const,
      auxiliaryVisionAvailable: false,
      limits: {
        maxManifestEntries: 8,
        maxSelectedImages: 4,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 4096,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 4096,
        maxSelectedBytes: 8192,
        maxSelectedPixels: 8192,
      },
    }
    decodes.count = 0
    const first = prepareRequestMedia(input)
    expect(decodes.count).toBe(0)
    const second = prepareRequestMedia(input)
    expect(decodes.count).toBe(1)
    expect(canonicalJson(second.hashMaterial)).toBe(canonicalJson(first.hashMaterial))
  })
})

function node(seq: number, bytes: Uint8Array): SurfaceNode {
  const event = {
    seq: 1000 + seq,
    ts: '2026-09-17T00:00:00.000Z',
    id: String(1000 + seq).padStart(26, '0'),
    type: 'tool/result',
    data: {
      toolUseId: `tool-${seq}`,
      content: [
        {
          type: 'resource_link',
          uri: `artifact://${sha256Hex(bytes)}`,
          name: 'image',
          mimeType: 'image/png',
        },
      ],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
    actor: { id: 'a', org: '', role: 'user', deptPath: [], attrs: {} },
    origin: 'tool:computer_use',
    trust: 'untrusted',
    sourceEventSeqs: [seq],
  } as unknown as Event
  return { seq: event.seq, kind: 'tool_result', pinned: false, event }
}
function ledger(surface: readonly SurfaceNode[]): Event[] {
  return [
    ...surface.map(
      (item) =>
        ({
          ...item.event,
          seq: item.event.sourceEventSeqs?.[0],
          type: 'tool/call',
          origin: 'model',
          sourceEventSeqs: undefined,
          data: {
            toolUseId: (item.event.data as { toolUseId: string }).toolUseId,
            name: 'computer_use',
            args: {},
          },
        }) as unknown as Event,
    ),
    ...surface.map((item) => item.event),
  ]
}
const surfaceLimits = {
  maxLedgerEvents: 64,
  maxSurfaceNodes: 64,
  maxContentBlocks: 64,
  maxManifestEntries: 16,
  maxCandidateBytes: 1 << 20,
  maxCandidatePixels: 1 << 20,
}
const mediaLimits = {
  maxManifestEntries: 16,
  maxSelectedImages: 4,
  maxSelectedBlocks: 8,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 4096,
  maxSelectedBytes: 16384,
  maxSelectedPixels: 16384,
}

describe('decode count on the request-media paths', () => {
  const images = Array.from({ length: 6 }, (_, index) => png(8, 8, 500 + index))
  const artifacts = new Map(images.map((bytes) => [sha256Hex(bytes), bytes]))
  const surface = images.map((bytes, index) => node(index + 1, bytes))
  const common = {
    sessionKey: 'session-a',
    lane: 'main',
    signal: new AbortController().signal,
    readArtifact: ({ sha256 }: { sha256: string }) => artifacts.get(sha256),
    surfaceLimits,
    mediaLimits,
  }

  it('decodes each window image once per first-send step and once per restore', async () => {
    const prepared = await prepareRequestMediaFromSurface({
      ...common,
      surface,
      lookupToolCalls: toolCallLookup(ledger(surface)),
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
    })
    expect(prepared.selected).toHaveLength(3)
    expect(decodes.count).toBe(3)
    decodes.count = 0
    const restored = await restoreRequestMediaFromLedger({
      ...common,
      header: prepared.header,
      ledgerEvents: ledger(surface),
    })
    expect(canonicalJson(restored.hashMaterial)).toBe(canonicalJson(prepared.hashMaterial))
    expect(decodes.count).toBe(3)
  })

  it('never reuses a decode for candidates handed out of Core, so in-place mutation is caught', async () => {
    const candidates = await requestMediaCandidatesFromSurface({
      ...common,
      surface,
      lookupToolCalls: toolCallLookup(ledger(surface)),
    })
    expect(decodes.count).toBe(3)
    decodes.count = 0
    const input = {
      mainModelInput: ['text', 'image'] as const,
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    }
    prepareRequestMedia({ ...input, candidates })
    expect(decodes.count).toBe(3)
    const tampered = candidates[0]?.bytes as Uint8Array
    const flipped = tampered.length - 20
    tampered[flipped] = (tampered[flipped] as number) ^ 1
    expect(() => prepareRequestMedia({ ...input, candidates })).toThrow(
      expect.objectContaining({ code: expect.stringMatching(/IMAGE_INVALID|DIGEST_MISMATCH/) }),
    )
  })
})
