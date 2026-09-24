import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { prepareRequestMedia } from '../src/orchestrator/request-media.js'
import {
  prepareRequestMediaFromSurface,
  REQUEST_MEDIA_ARTIFACT_RECLAIMED,
  type RequestMediaScanTruncation,
  type RequestMediaToolCallLookup,
  requestMediaCandidatesFromSurface,
  restoreRequestMediaFromLedger,
} from '../src/orchestrator/request-media-surface.js'
import type { SurfaceNode } from '../src/project/surface.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { toolCallLookup } from './helpers/request-media-lookup.js'
import { legacyPrepareRequestMediaFromSurface } from './helpers/request-media-surface-legacy.js'

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
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
function png(width = 8, height = 8, marker = 0): Uint8Array {
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

const mediaLimits = {
  maxManifestEntries: 8,
  maxSelectedImages: 8,
  maxSelectedBlocks: 16,
  maxBytesPerImage: 4096,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 4096,
  maxSelectedBytes: 8192,
  maxSelectedPixels: 8192,
}
const surfaceLimits = {
  maxLedgerEvents: 32,
  maxSurfaceNodes: 8,
  maxContentBlocks: 16,
  maxManifestEntries: 8,
  maxCandidateBytes: 8192,
  maxCandidatePixels: 8192,
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string }

function node(seq: number, blocks: readonly Block[], origin = 'tool:computer_use'): SurfaceNode {
  const resultSeq = 1000 + seq
  return {
    seq: resultSeq,
    kind: 'tool_result',
    pinned: false,
    event: {
      seq: resultSeq,
      ts: '2026-09-17T00:00:00.000Z',
      id: `${String(resultSeq).padStart(26, '0')}`,
      type: 'tool/result',
      data: {
        toolUseId: `tool-${seq}`,
        content: blocks,
        structured: { width: 999, height: 999, mime: 'image/gif' },
        isError: false,
        enforcement: { level: 'full', scope: [] },
        authz: { decisionId: 'n/a' },
      },
      actor: { id: 'a', org: '', role: 'user', deptPath: [], attrs: {} },
      origin,
      trust: 'untrusted',
      sourceEventSeqs: [seq],
    },
  } as unknown as SurfaceNode
}

function ledgerEvents(surface: readonly SurfaceNode[], callName = 'computer_use'): Event[] {
  const calls = new Map<number, Event>()
  for (const item of surface) {
    const callSeq = item.event.sourceEventSeqs?.[0]
    const data = item.event.data as Record<string, unknown>
    if (callSeq === undefined) continue
    calls.set(callSeq, {
      seq: callSeq,
      ts: item.event.ts,
      id: `${String(callSeq).padStart(26, '0')}`,
      type: 'tool/call',
      data: { toolUseId: data.toolUseId, name: callName, args: {}, ordinal: 0 },
      actor: item.event.actor,
      origin: 'model',
      trust: 'untrusted',
      lane: item.event.lane,
      v: 1,
    } as Event)
  }
  return [...calls.values(), ...surface.map((item) => item.event)]
}

function ref(bytes: Uint8Array, extra: Partial<Block> = {}): Block {
  const sha256 = sha256Hex(bytes)
  return {
    type: 'resource_link',
    uri: `artifact://${sha256}`,
    name: 'image',
    mimeType: 'image/jpeg',
    ...extra,
  } as Block
}

const collect = (
  surface: readonly SurfaceNode[],
  readArtifact: (sha256: string) => Uint8Array | undefined | Promise<Uint8Array | undefined>,
  overrides: Partial<typeof surfaceLimits> = {},
  options: {
    lookupToolCalls?: RequestMediaToolCallLookup
    onScanTruncated?: (info: RequestMediaScanTruncation) => void
  } = {},
) =>
  requestMediaCandidatesFromSurface({
    sessionKey: 'session-a',
    lane: 'main',
    signal: new AbortController().signal,
    surface,
    lookupToolCalls: options.lookupToolCalls ?? toolCallLookup(ledgerEvents(surface)),
    ...(options.onScanTruncated ? { onScanTruncated: options.onScanTruncated } : {}),
    readArtifact: ({ sha256 }) => readArtifact(sha256),
    surfaceLimits: { ...surfaceLimits, ...overrides },
    mediaLimits,
  })

describe('request media surface adapter', () => {
  it('accepts 100, 101 and 150 historical screenshots and lists only the node window', async () => {
    const bytes = png()
    const surface = Array.from({ length: 150 }, (_, index) => node(index + 1, [ref(bytes)]))
    const prepare = (count: number) =>
      prepareRequestMediaFromSurface({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        surface: surface.slice(0, count),
        lookupToolCalls: toolCallLookup(ledgerEvents(surface.slice(0, count))),
        readArtifact: async () => bytes,
        surfaceLimits: {
          ...surfaceLimits,
          maxLedgerEvents: 300,
          maxSurfaceNodes: 160,
          maxContentBlocks: 160,
          maxManifestEntries: 100,
          maxCandidateBytes: 100 * 4096,
          maxCandidatePixels: 100 * 4096,
        },
        mediaLimits: { ...mediaLimits, maxManifestEntries: 100, maxSelectedImages: 4 },
        mainModelInput: ['text', 'image'],
        auxiliaryVisionAvailable: false,
      })
    for (const count of [100, 101, 150]) {
      const prepared = await prepare(count)
      expect(prepared.header.manifest.map((entry) => entry.nodeSeq)).toEqual([
        1000 + count - 2,
        1000 + count - 1,
        1000 + count,
      ])
      expect(prepared.header.manifest.every((entry) => entry.reason !== 'latest-three')).toBe(true)
      expect(prepared.selected).toHaveLength(3)
    }
  })
  it('orders by node/block and derives provenance and image metadata from trusted inputs', async () => {
    const first = png(9, 10, 1)
    const second = png(11, 12, 2)
    const artifacts = new Map([
      [sha256Hex(first), first],
      [sha256Hex(second), second],
    ])
    const candidates = await collect(
      [node(9, [{ type: 'text', text: 'x' }, ref(second)]), node(3, [ref(first)])],
      (sha256) => artifacts.get(sha256),
    )
    expect(candidates.map((candidate) => [candidate.nodeSeq, candidate.blockIndex])).toEqual([
      [1003, 0],
      [1009, 1],
    ])
    expect(
      candidates.map(({ mime, width, height, sourceTool }) => ({ mime, width, height, sourceTool })),
    ).toEqual([
      { mime: 'image/png', width: 9, height: 10, sourceTool: 'computer_use' },
      { mime: 'image/png', width: 11, height: 12, sourceTool: 'computer_use' },
    ])
  })

  it('fails window and single-node ceilings before reading and degrades a node overflow to text-only', async () => {
    const one = png(8, 8, 1)
    const two = png(8, 8, 2)
    let reads = 0
    const reader = () => {
      reads += 1
      return one
    }
    await expect(
      collect([node(1, [ref(one), ref(two)])], reader, { maxManifestEntries: 1 }),
    ).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
    const truncations: RequestMediaScanTruncation[] = []
    await expect(
      collect(
        [node(1, []), node(2, [])],
        reader,
        { maxSurfaceNodes: 1 },
        {
          onScanTruncated: (info) => truncations.push(info),
        },
      ),
    ).resolves.toEqual([])
    expect(truncations).toEqual([{ reason: 'surface-nodes', scannedNodes: 1, imageNodes: 0 }])
    await expect(
      collect([node(1, [{ type: 'text', text: 'a' }, ref(one)])], reader, { maxContentBlocks: 1 }),
    ).rejects.toMatchObject({ code: 'SURFACE_LIMIT' })
    expect(reads).toBe(0)
  })
  it('rejects bad positions, URIs, origins and inline images before artifact reads', async () => {
    const bytes = png()
    let reads = 0
    const reader = () => {
      reads += 1
      return bytes
    }
    await expect(collect([node(1, [ref(bytes), ref(bytes)])], reader)).rejects.toMatchObject({
      code: 'DUPLICATE_POSITION',
    })
    await expect(
      collect(
        [node(1, [{ type: 'resource_link', uri: `artifact://${'A'.repeat(64)}`, name: 'image' }])],
        reader,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_URI' })
    await expect(collect([node(1, [ref(bytes)], 'model')], reader)).rejects.toMatchObject({
      code: 'SURFACE_INVALID',
    })
    await expect(
      collect([node(1, [{ type: 'image', data: 'x', mimeType: 'image/png' }])], reader),
    ).rejects.toMatchObject({ code: 'INLINE_IMAGE_UNSUPPORTED' })
    expect(reads).toBe(0)
  })

  it('ignores system-origin text results and derives system-origin image provenance from tool/call', async () => {
    const bytes = png()
    await expect(
      collect([node(1, [{ type: 'text', text: 'no image' }], 'system')], () => bytes),
    ).resolves.toEqual([])
    const surface = [node(2, [ref(bytes, { name: 'artifact' })], 'system')]
    const candidates = await requestMediaCandidatesFromSurface({
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      surface,
      lookupToolCalls: toolCallLookup(ledgerEvents(surface, 'deferred_capture')),
      readArtifact: () => bytes,
      surfaceLimits,
      mediaLimits,
    })
    expect(candidates[0]?.sourceTool).toBe('deferred_capture')
  })

  it('rejects a tool origin that disagrees with the immutable source tool/call', async () => {
    const bytes = png()
    const surface = [node(1, [ref(bytes)], 'tool:forged')]
    await expect(
      requestMediaCandidatesFromSurface({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        surface,
        lookupToolCalls: toolCallLookup(ledgerEvents(surface, 'computer_use')),
        readArtifact: () => bytes,
        surfaceLimits,
        mediaLimits,
      }),
    ).rejects.toMatchObject({ code: 'SURFACE_INVALID' })
  })

  it('rejects missing, invalid and digest-drifted artifact bytes', async () => {
    const bytes = png()
    await expect(collect([node(1, [ref(bytes)])], () => undefined)).rejects.toMatchObject({
      code: 'ARTIFACT_BYTES_MISSING',
    })
    await expect(collect([node(1, [ref(bytes)])], () => new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'IMAGE_INVALID',
    })
    await expect(collect([node(1, [ref(bytes)])], () => png(8, 8, 99))).rejects.toMatchObject({
      code: 'ARTIFACT_DIGEST_MISMATCH',
    })
  })

  it('binds every first-send and restore read to one frozen session lane and signal', async () => {
    const bytes = png(8, 8, 44)
    const surface = [node(1, [ref(bytes)])]
    const signal = new AbortController().signal
    const reads: Array<{
      sessionKey: string
      lane: string
      nodeSeq: number
      sha256: string
      signal: AbortSignal
    }> = []
    const readArtifact = (input: {
      sessionKey: string
      lane: string
      nodeSeq: number
      sha256: string
      signal: AbortSignal
    }) => {
      expect(Object.isFrozen(input)).toBe(true)
      reads.push(input)
      return bytes
    }
    const prepared = await prepareRequestMediaFromSurface({
      sessionKey: 'session-a',
      lane: 'vision',
      signal,
      surface,
      lookupToolCalls: toolCallLookup(ledgerEvents(surface)),
      readArtifact,
      surfaceLimits,
      mediaLimits,
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
    })
    await restoreRequestMediaFromLedger({
      sessionKey: 'session-a',
      lane: 'vision',
      signal,
      header: prepared.header,
      ledgerEvents: ledgerEvents(surface),
      readArtifact,
      surfaceLimits,
      mediaLimits,
    })
    expect(reads).toHaveLength(2)
    expect(reads).toEqual(
      reads.map(() => ({
        sessionKey: 'session-a',
        lane: 'vision',
        nodeSeq: 1001,
        sha256: sha256Hex(bytes),
        signal,
      })),
    )
  })

  it('fails closed on cross-session readers, cancellation and hostile reader results', async () => {
    const bytes = png(8, 8, 45)
    const surface = [node(1, [ref(bytes)])]
    const input = {
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      surface,
      lookupToolCalls: toolCallLookup(ledgerEvents(surface)),
      surfaceLimits,
      mediaLimits,
      mainModelInput: ['text', 'image'] as const,
      auxiliaryVisionAvailable: false,
    }
    await expect(
      prepareRequestMediaFromSurface({
        ...input,
        readArtifact: ({ sessionKey }) => (sessionKey === 'session-b' ? bytes : undefined),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })

    const cancelled = new AbortController()
    cancelled.abort()
    let called = false
    await expect(
      prepareRequestMediaFromSurface({
        ...input,
        signal: cancelled.signal,
        readArtifact: () => {
          called = true
          return bytes
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })
    expect(called).toBe(false)

    const cancelledDuringRead = new AbortController()
    await expect(
      prepareRequestMediaFromSurface({
        ...input,
        signal: cancelledDuringRead.signal,
        readArtifact: async () => {
          cancelledDuringRead.abort()
          await Promise.resolve()
          return bytes
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })

    for (const readArtifact of [
      () => {
        throw new Error('Bearer reader-secret')
      },
      () => new Proxy(bytes, {}),
      () => new (class extends Uint8Array {})(bytes),
    ]) {
      let error: unknown
      try {
        await prepareRequestMediaFromSurface({ ...input, readArtifact })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })
      expect(String(error)).not.toContain('reader-secret')
    }
  })

  it('enforces aggregate candidate byte and pixel budgets across images', async () => {
    const first = png(8, 8, 1)
    const second = png(8, 8, 2)
    const artifacts = new Map([
      [sha256Hex(first), first],
      [sha256Hex(second), second],
    ])
    await expect(
      collect([node(1, [ref(first), ref(second)])], (sha) => artifacts.get(sha), {
        maxCandidateBytes: first.length + second.length - 1,
      }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_BUDGET' })
    await expect(
      collect([node(1, [ref(first), ref(second)])], (sha) => artifacts.get(sha), {
        maxCandidatePixels: 127,
      }),
    ).rejects.toMatchObject({ code: 'CANDIDATE_BUDGET' })
  })

  it('restores from exact immutable ledger nodes, not caller-attested provenance', async () => {
    const bytes = png(8, 8, 5)
    const [candidate] = await collect([node(1, [ref(bytes)])], () => bytes)
    if (!candidate) throw new Error('expected candidate')
    const prepared = prepareRequestMedia({
      candidates: [candidate],
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    })
    const restored = await restoreRequestMediaFromLedger({
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      header: prepared.header,
      ledgerEvents: ledgerEvents([node(1, [ref(bytes)])]),
      readArtifact: () => bytes,
      surfaceLimits,
      mediaLimits,
    })
    expect(restored.header).toEqual(prepared.header)
    expect(restored.selected[0]).toMatchObject({ nodeSeq: 1001, width: 8, height: 8 })
  })

  it('snapshots prepare route, budgets, reader and session before artifact awaits', async () => {
    const first = png(8, 8, 21)
    const second = png(8, 8, 22)
    const surface = [node(1, [ref(first), ref(second)])]
    const artifacts = new Map([
      [sha256Hex(first), first],
      [sha256Hex(second), second],
    ])
    const mutableInput = {
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      surface,
      lookupToolCalls: toolCallLookup(ledgerEvents(surface)),
      readArtifact: undefined as unknown as (input: { sha256: string }) => Promise<Uint8Array | undefined>,
      surfaceLimits: { ...surfaceLimits },
      mediaLimits: { ...mediaLimits },
      mainModelInput: ['text'] as Array<'text' | 'image'>,
      auxiliaryVisionAvailable: false,
    }
    let reads = 0
    const originalReader = async ({ sha256 }: { sha256: string }) => {
      reads += 1
      if (reads === 1) {
        mutableInput.sessionKey = 'session-b'
        mutableInput.mainModelInput.push('image')
        mutableInput.auxiliaryVisionAvailable = true
        mutableInput.mediaLimits.maxSelectedImages = 0
        mutableInput.readArtifact = async () => undefined
        await Promise.resolve()
      }
      return artifacts.get(sha256)
    }
    mutableInput.readArtifact = originalReader

    const prepared = await prepareRequestMediaFromSurface(mutableInput)
    expect(reads).toBe(2)
    expect(prepared.sessionKey).toBe('session-a')
    expect(prepared.header.route).toBe('text-only')
    expect(prepared.selected).toEqual([])
  })

  it('restores only selected ledger rows without rescanning unrelated tool-result history', async () => {
    const bytes = png(8, 8, 5)
    const selectedSurface = [node(1, [ref(bytes)])]
    const [candidate] = await collect(selectedSurface, () => bytes)
    if (!candidate) throw new Error('expected candidate')
    const prepared = prepareRequestMedia({
      candidates: [candidate],
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    })
    const unrelated = Array.from({ length: surfaceLimits.maxSurfaceNodes + 1 }, (_, index) =>
      node(index + 20, [{ type: 'text', text: `old-${index}` }], 'system'),
    )
    const restored = await restoreRequestMediaFromLedger({
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      header: prepared.header,
      ledgerEvents: ledgerEvents([...selectedSurface, ...unrelated]),
      readArtifact: () => bytes,
      surfaceLimits,
      mediaLimits,
    })
    expect(restored.selected).toHaveLength(1)
  })

  it('fails restore on missing/duplicate ledger rows and metadata drift', async () => {
    const bytes = png(8, 8, 6)
    const [candidate] = await collect([node(1, [ref(bytes)])], () => bytes)
    if (!candidate) throw new Error('expected candidate')
    const prepared = prepareRequestMedia({
      candidates: [candidate],
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    })
    const manifestEntry = prepared.header.manifest[0]
    if (!manifestEntry) throw new Error('expected manifest entry')
    const restore = (
      ledgerNodes: readonly SurfaceNode[],
      header = prepared.header,
      readArtifact = () => bytes,
    ) =>
      restoreRequestMediaFromLedger({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        header,
        ledgerEvents: ledgerEvents(ledgerNodes),
        readArtifact,
        surfaceLimits,
        mediaLimits,
      })
    await expect(restore([])).rejects.toMatchObject({ code: 'RESTORE_SOURCE_DRIFT' })
    await expect(restore([node(1, [ref(bytes)]), node(1, [ref(bytes)])])).rejects.toMatchObject({
      code: 'SURFACE_INVALID',
    })
    await expect(restore([node(1, [ref(bytes)])], prepared.header, () => png(8, 8, 7))).rejects.toMatchObject(
      { code: 'ARTIFACT_DIGEST_MISMATCH' },
    )
    await expect(
      restore([node(1, [ref(bytes)])], {
        ...prepared.header,
        manifest: [{ ...manifestEntry, width: 9 }],
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_SOURCE_DRIFT' })
  })

  it('snapshots headers and limits before asynchronous artifact reads', async () => {
    const first = png(8, 8, 8)
    const second = png(8, 8, 9)
    const candidates = await collect([node(1, [ref(first), ref(second)])], (sha) =>
      sha === sha256Hex(first) ? first : second,
    )
    const prepared = prepareRequestMedia({
      candidates,
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    })
    const mutableHeader = structuredClone(prepared.header)
    const mutableSurfaceLimits = { ...surfaceLimits }
    let reads = 0
    const mutableInput = {
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      header: mutableHeader,
      ledgerEvents: ledgerEvents([node(1, [ref(first), ref(second)])]),
      readArtifact: undefined as unknown as (input: { sha256: string }) => Promise<Uint8Array | undefined>,
      surfaceLimits: mutableSurfaceLimits,
      mediaLimits,
    }
    const originalReader = async ({ sha256: sha }: { sha256: string }) => {
      reads += 1
      if (reads === 1) {
        const mutableEntry = mutableHeader.manifest[0]
        if (!mutableEntry) throw new Error('expected mutable manifest entry')
        mutableEntry.width = 99
        mutableSurfaceLimits.maxCandidatePixels = 1
        mutableInput.sessionKey = 'session-b'
        mutableInput.readArtifact = async () => undefined
        await Promise.resolve()
      }
      return sha === sha256Hex(first) ? first : second
    }
    mutableInput.readArtifact = originalReader
    const restored = await restoreRequestMediaFromLedger(mutableInput)
    expect(reads).toBe(2)
    expect(restored.sessionKey).toBe('session-a')
    expect(restored.header.manifest[0]?.width).toBe(8)
    expect(restored.selected).toHaveLength(2)
  })

  it('checks persisted manifest length and unsupported element maps before reads', async () => {
    const bytes = png()
    const [candidate] = await collect([node(1, [ref(bytes)])], () => bytes)
    if (!candidate) throw new Error('expected candidate')
    const prepared = prepareRequestMedia({
      candidates: [candidate],
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
      limits: mediaLimits,
    })
    const manifestEntry = prepared.header.manifest[0]
    if (!manifestEntry) throw new Error('expected manifest entry')
    let reads = 0
    const reader = () => {
      reads += 1
      return bytes
    }
    await expect(
      restoreRequestMediaFromLedger({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        header: { ...prepared.header, manifest: [...prepared.header.manifest, ...prepared.header.manifest] },
        ledgerEvents: ledgerEvents([node(1, [ref(bytes)])]),
        readArtifact: reader,
        surfaceLimits: { ...surfaceLimits, maxManifestEntries: 1 },
        mediaLimits,
      }),
    ).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
    await expect(
      restoreRequestMediaFromLedger({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        header: {
          ...prepared.header,
          manifest: [{ ...manifestEntry, elementMapDigest: 'a'.repeat(64) }],
        },
        ledgerEvents: ledgerEvents([node(1, [ref(bytes)])]),
        readArtifact: reader,
        surfaceLimits,
        mediaLimits,
      }),
    ).rejects.toMatchObject({ code: 'RESTORE_SOURCE_DRIFT' })
    expect(reads).toBe(0)
  })
})

const wideSurfaceLimits = {
  maxLedgerEvents: 400,
  maxSurfaceNodes: 400,
  maxContentBlocks: 800,
  maxManifestEntries: 100,
  maxCandidateBytes: 400 * 4096,
  maxCandidatePixels: 400 * 4096,
}
const wideMediaLimits = { ...mediaLimits, maxManifestEntries: 100, maxSelectedImages: 4 }

type Route = 'native-image' | 'text-only' | 'auxiliary-vision'
const routeInput = (route: Route) =>
  route === 'native-image'
    ? { mainModelInput: ['text', 'image'] as Array<'text' | 'image'>, auxiliaryVisionAvailable: false }
    : {
        mainModelInput: ['text'] as Array<'text' | 'image'>,
        auxiliaryVisionAvailable: route === 'auxiliary-vision',
      }

function artifactStore(images: readonly Uint8Array[]) {
  return new Map(images.map((bytes) => [sha256Hex(bytes), bytes]))
}

async function windowed(
  surface: readonly SurfaceNode[],
  artifacts: ReadonlyMap<string, Uint8Array>,
  route: Route = 'native-image',
  overrides: { read?: (sha256: string) => Uint8Array | undefined; lookup?: RequestMediaToolCallLookup } = {},
) {
  return prepareRequestMediaFromSurface({
    sessionKey: 'session-a',
    lane: 'main',
    signal: new AbortController().signal,
    surface,
    lookupToolCalls: overrides.lookup ?? toolCallLookup(ledgerEvents(surface)),
    readArtifact: ({ sha256 }) => (overrides.read ? overrides.read(sha256) : artifacts.get(sha256)),
    surfaceLimits: wideSurfaceLimits,
    mediaLimits: wideMediaLimits,
    ...routeInput(route),
  })
}

async function legacy(
  surface: readonly SurfaceNode[],
  artifacts: ReadonlyMap<string, Uint8Array>,
  route: Route,
) {
  return legacyPrepareRequestMediaFromSurface({
    sessionKey: 'session-a',
    lane: 'main',
    signal: new AbortController().signal,
    surface,
    ledgerEvents: ledgerEvents(surface),
    readArtifact: ({ sha256 }) => artifacts.get(sha256),
    surfaceLimits: wideSurfaceLimits,
    mediaLimits: wideMediaLimits,
    ...routeInput(route),
  })
}

describe('request media node window', () => {
  it.each([20, 50, 100, 150])(
    'reads and looks up only the window over ten sliding steps with %i image nodes',
    async (count) => {
      const images = Array.from({ length: count + 10 }, (_, index) => png(8, 8, 1000 + index))
      const artifacts = artifactStore(images)
      const nodes = images.map((bytes, index) =>
        node(index + 1, [{ type: 'text', text: `step ${index}` }, ref(bytes)]),
      )
      for (let step = 0; step < 10; step += 1) {
        const surface = nodes.slice(0, count + step)
        const window = new Set(images.slice(count + step - 3, count + step).map((bytes) => sha256Hex(bytes)))
        const reads: string[] = []
        const lookup = toolCallLookup(ledgerEvents(surface))
        const prepared = await windowed(surface, artifacts, 'native-image', {
          lookup,
          read: (sha256) => {
            reads.push(sha256)
            if (!window.has(sha256)) throw new Error('outside the window')
            return artifacts.get(sha256)
          },
        })
        expect(reads).toHaveLength(3)
        expect(new Set(reads)).toEqual(window)
        expect(lookup.calls).toEqual([[count + step - 2, count + step - 1, count + step]])
        expect(prepared.header.manifest).toHaveLength(3)
        expect(prepared.selected).toHaveLength(3)
      }
    },
  )

  it('matches the pre-window output byte for byte when every image node is in the window', async () => {
    const small = png(4, 4, 1)
    const first = png(8, 8, 2)
    const second = png(9, 8, 3)
    const third = png(8, 9, 4)
    const artifacts = artifactStore([small, first, second, third])
    const surface = [
      node(1, [{ type: 'text', text: 'no image' }], 'system'),
      node(2, [ref(small), { type: 'text', text: 'Save' }, ref(first)]),
      node(3, [{ type: 'text', text: 'only text' }]),
      node(4, [ref(second)]),
      node(5, [ref(third)]),
    ]
    for (const route of ['native-image', 'text-only', 'auxiliary-vision'] as const) {
      const next = await windowed(surface, artifacts, route)
      const before = await legacy(surface, artifacts, route)
      expect(next.header.route).toBe(route)
      expect(canonicalJson(next.header)).toBe(canonicalJson(before.header))
      expect(canonicalJson(next.hashMaterial)).toBe(canonicalJson(before.hashMaterial))
    }
  })

  it('drops exactly the latest-three manifest entries and keeps selection when nodes exceed the window', async () => {
    const images = Array.from({ length: 7 }, (_, index) => png(8, 8, 50 + index))
    const artifacts = artifactStore(images)
    const surface = images.map((bytes, index) =>
      node(index + 1, index === 5 ? [ref(bytes), ref(images[0] as Uint8Array)] : [ref(bytes)]),
    )
    for (const route of ['native-image', 'text-only', 'auxiliary-vision'] as const) {
      const next = await windowed(surface, artifacts, route)
      const before = await legacy(surface, artifacts, route)
      expect(next.header.route).toBe(before.header.route)
      expect(next.header.manifest).toEqual(
        before.header.manifest.filter((entry) => entry.reason !== 'latest-three'),
      )
      const sent = (media: typeof next) => media.selected.map(({ manifestIndex: _index, ...image }) => image)
      expect(sent(next)).toEqual(sent(before))
    }
  })

  it('picks the window by node sequence, not by surface position', async () => {
    const images = [png(8, 8, 61), png(8, 8, 62), png(8, 8, 63), png(8, 8, 64)]
    const artifacts = artifactStore(images)
    const surface = [
      node(9, [ref(images[0] as Uint8Array)]),
      node(3, [ref(images[1] as Uint8Array)]),
      node(5, [ref(images[2] as Uint8Array)]),
      node(7, [ref(images[3] as Uint8Array)]),
    ]
    const next = await windowed(surface, artifacts)
    expect(next.header.manifest.map((entry) => entry.nodeSeq)).toEqual([1005, 1007, 1009])
  })

  it('scans only the newest segment when block ceilings are exceeded and reports the truncation', async () => {
    const images = Array.from({ length: 6 }, (_, index) => png(8, 8, 70 + index))
    const artifacts = artifactStore(images)
    const surface = images.map((bytes, index) => node(index + 1, [{ type: 'text', text: 'x' }, ref(bytes)]))
    const truncations: RequestMediaScanTruncation[] = []
    const candidates = await collect(
      surface,
      (sha) => artifacts.get(sha),
      { maxContentBlocks: 7, maxSurfaceNodes: 32 },
      {
        onScanTruncated: (info) => truncations.push(info),
      },
    )
    expect(candidates.map((candidate) => candidate.nodeSeq)).toEqual([1004, 1005, 1006])
    expect(truncations).toEqual([{ reason: 'content-blocks', scannedNodes: 3, imageNodes: 3 }])
    truncations.length = 0
    const narrow = await collect(
      surface,
      (sha) => artifacts.get(sha),
      { maxSurfaceNodes: 2 },
      {
        onScanTruncated: (info) => truncations.push(info),
      },
    )
    expect(narrow.map((candidate) => candidate.nodeSeq)).toEqual([1005, 1006])
    expect(truncations).toEqual([{ reason: 'surface-nodes', scannedNodes: 2, imageNodes: 2 }])
  })

  it('still checks every node in the scanned segment and ignores malformed nodes beyond it', async () => {
    const images = Array.from({ length: 4 }, (_, index) => png(8, 8, 80 + index))
    const artifacts = artifactStore(images)
    const newest = images.map((bytes, index) => node(index + 10, [ref(bytes)]))
    const read = (sha: string) => artifacts.get(sha)
    await expect(
      collect([node(1, [{ type: 'image', data: 'x', mimeType: 'image/png' }]), ...newest], read),
    ).rejects.toMatchObject({ code: 'INLINE_IMAGE_UNSUPPORTED' })
    await expect(
      collect([node(1, [{ type: 'resource_link', uri: 'artifact://bad', name: 'image' }]), ...newest], read),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_URI' })
    await expect(
      collect([node(1, [ref(images[0] as Uint8Array), ref(images[0] as Uint8Array)]), ...newest], read),
    ).rejects.toMatchObject({ code: 'DUPLICATE_POSITION' })
    await expect(
      collect(
        [node(1, [{ type: 'text', text: 'a' }]), node(1, [{ type: 'text', text: 'b' }]), ...newest],
        read,
      ),
    ).rejects.toMatchObject({ code: 'SURFACE_INVALID' })
    const beyond = await collect(
      [node(1, [{ type: 'image', data: 'x', mimeType: 'image/png' }]), ...newest],
      read,
      {
        maxSurfaceNodes: 4,
      },
    )
    expect(beyond.map((candidate) => candidate.nodeSeq)).toEqual([1011, 1012, 1013])
  })

  it('checks provenance only for window nodes, after every structural check of the segment', async () => {
    const images = Array.from({ length: 4 }, (_, index) => png(8, 8, 90 + index))
    const artifacts = artifactStore(images)
    const read = (sha: string) => artifacts.get(sha)
    const newest = images.slice(1).map((bytes, index) => node(index + 10, [ref(bytes)]))
    const forgedOutsideWindow = [node(1, [ref(images[0] as Uint8Array)], 'tool:forged'), ...newest]
    await expect(collect(forgedOutsideWindow, read)).resolves.toHaveLength(3)
    await expect(legacy(forgedOutsideWindow, artifacts, 'native-image')).rejects.toMatchObject({
      code: 'SURFACE_INVALID',
    })
    // Two defects in one node: the structural one now wins over the provenance one.
    const twoDefects = [
      node(
        1,
        [ref(images[0] as Uint8Array), { type: 'resource_link', uri: 'artifact://bad', name: 'image' }],
        'model',
      ),
    ]
    await expect(collect(twoDefects, read)).rejects.toMatchObject({ code: 'INVALID_ARTIFACT_URI' })
    await expect(legacy(twoDefects, artifacts, 'native-image')).rejects.toMatchObject({
      code: 'SURFACE_INVALID',
    })
  })

  it('fails closed when a window source tool/call cannot be found and ignores unrequested lookup rows', async () => {
    const bytes = png(8, 8, 95)
    const surface = [node(1, [ref(bytes)])]
    await expect(
      collect(surface, () => bytes, {}, { lookupToolCalls: async () => [] }),
    ).rejects.toMatchObject({
      code: 'SURFACE_INVALID',
    })
    const rows = ledgerEvents(surface)
    const noisy: RequestMediaToolCallLookup = async () => [
      ...rows,
      ...rows.map((row) => ({ ...row, seq: row.seq + 500 })),
    ]
    await expect(collect(surface, () => bytes, {}, { lookupToolCalls: noisy })).resolves.toHaveLength(1)
  })

  it('reads window bytes on every step: a window image deleted between steps fails the next step', async () => {
    const images = Array.from({ length: 5 }, (_, index) => png(8, 8, 110 + index))
    const artifacts = new Map(artifactStore(images))
    const surface = images.map((bytes, index) => node(index + 1, [ref(bytes)]))
    await expect(windowed(surface, artifacts)).resolves.toBeDefined()
    artifacts.delete(sha256Hex(images[3] as Uint8Array))
    await expect(windowed(surface, artifacts)).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })
    artifacts.set(sha256Hex(images[3] as Uint8Array), png(8, 8, 999))
    await expect(windowed(surface, artifacts)).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' })
  })

  it('neither looks up nor reads anything for a surface without images', async () => {
    const surface = [node(1, [{ type: 'text', text: 'a' }]), node(2, [{ type: 'text', text: 'b' }], 'system')]
    const lookup = toolCallLookup(ledgerEvents(surface))
    let reads = 0
    const next = await windowed(surface, new Map(), 'native-image', {
      lookup,
      read: () => {
        reads += 1
        return undefined
      },
    })
    expect(lookup.calls).toEqual([])
    expect(reads).toBe(0)
    expect(canonicalJson(next.header)).toBe(
      canonicalJson((await legacy(surface, new Map(), 'native-image')).header),
    )
  })

  it('refuses a window whose ledger rows exceed maxLedgerEvents before looking any of them up', async () => {
    const bytes = png(8, 8, 120)
    const surface = [node(1, [ref(bytes)])]
    const lookup = toolCallLookup(ledgerEvents(surface))
    let reads = 0
    await expect(
      collect(
        surface,
        () => {
          reads += 1
          return bytes
        },
        { maxLedgerEvents: 1 },
        { lookupToolCalls: lookup },
      ),
    ).rejects.toMatchObject({ code: 'SURFACE_LIMIT' })
    expect(lookup.calls).toEqual([])
    expect(reads).toBe(0)
  })

  it('reports a node-count truncation only when a dropped node is a tool result', async () => {
    const bytes = png(8, 8, 121)
    const artifacts = artifactStore([bytes])
    const text = (seq: number): SurfaceNode =>
      ({
        seq,
        kind: 'user',
        pinned: false,
        event: { ...node(seq, []).event, seq, type: 'user/message', data: { content: [] } },
      }) as unknown as SurfaceNode
    const truncations: RequestMediaScanTruncation[] = []
    const onScanTruncated = (info: RequestMediaScanTruncation) => truncations.push(info)
    const onlyText = await collect(
      [text(1), text(2), node(3, [ref(bytes)])],
      (sha) => artifacts.get(sha),
      { maxSurfaceNodes: 1 },
      { onScanTruncated },
    )
    expect(onlyText.map((candidate) => candidate.nodeSeq)).toEqual([1003])
    expect(truncations).toEqual([])
    await collect(
      [node(1, []), text(2), node(3, [ref(bytes)])],
      (sha) => artifacts.get(sha),
      { maxSurfaceNodes: 2 },
      { onScanTruncated },
    )
    expect(truncations).toEqual([{ reason: 'surface-nodes', scannedNodes: 2, imageNodes: 1 }])
  })
})

describe('reclaimed window images', () => {
  type Read = (sha256: string) => Uint8Array | typeof REQUEST_MEDIA_ARTIFACT_RECLAIMED | undefined
  const reclaimedFixture = (count: number, reclaimed: (index: number) => boolean) => {
    const images = Array.from({ length: count }, (_, index) => png(8, 8, 300 + index))
    const artifacts = artifactStore(images)
    const surface = images.map((bytes, index) => node(index + 1, [ref(bytes)]))
    const reads: number[] = []
    const read: Read = (sha256) => {
      const index = images.findIndex((bytes) => sha256Hex(bytes) === sha256)
      reads.push(index + 1)
      return reclaimed(index + 1) ? REQUEST_MEDIA_ARTIFACT_RECLAIMED : artifacts.get(sha256)
    }
    return { images, surface, reads, read }
  }
  const prepare = (
    surface: readonly SurfaceNode[],
    read: Read,
    lookup: RequestMediaToolCallLookup = toolCallLookup(ledgerEvents(surface)),
    limits: Partial<typeof wideSurfaceLimits> = {},
  ) =>
    prepareRequestMediaFromSurface({
      sessionKey: 'session-a',
      lane: 'main',
      signal: new AbortController().signal,
      surface,
      lookupToolCalls: lookup,
      readArtifact: ({ sha256 }) => read(sha256),
      surfaceLimits: { ...wideSurfaceLimits, ...limits },
      mediaLimits: { ...wideMediaLimits, maxManifestEntries: limits.maxManifestEntries ?? 100 },
      mainModelInput: ['text', 'image'],
      auxiliaryVisionAvailable: false,
    })

  it('omits a reclaimed image and extends the window to the next older image node', async () => {
    const fixture = reclaimedFixture(5, (index) => index === 5)
    const lookup = toolCallLookup(ledgerEvents(fixture.surface))
    const prepared = await prepare(fixture.surface, fixture.read, lookup)
    expect(prepared.header.manifest.map((entry) => entry.nodeSeq)).toEqual([1002, 1003, 1004])
    expect(prepared.selected).toHaveLength(3)
    expect(fixture.reads).toEqual([3, 4, 5, 2])
    expect(lookup.calls).toEqual([[3, 4, 5], [2]])
  })

  it('counts only surviving and newly added images against K, before reading the added node', async () => {
    const images = Array.from({ length: 6 }, (_, index) => png(8, 8, 320 + index))
    const artifacts = artifactStore(images)
    const surface = [
      node(1, [ref(images[0] as Uint8Array), ref(images[1] as Uint8Array)]),
      node(2, [ref(images[2] as Uint8Array)]),
      node(3, [ref(images[3] as Uint8Array)]),
      node(4, [ref(images[4] as Uint8Array)]),
    ]
    const reclaimedSha = sha256Hex(images[4] as Uint8Array)
    const reads: string[] = []
    const read: Read = (sha256) => {
      reads.push(sha256)
      return sha256 === reclaimedSha ? REQUEST_MEDIA_ARTIFACT_RECLAIMED : artifacts.get(sha256)
    }
    // Three images fit: the two survivors plus a one-image replacement would, a two-image one does
    // not, so the window stops extending instead of failing the request.
    const limited = await prepare(surface, read, undefined, { maxManifestEntries: 3 })
    expect(limited.header.manifest.map((entry) => entry.nodeSeq)).toEqual([1002, 1003])
    expect(reads).toHaveLength(3)
    const prepared = await prepare(surface, read, undefined, { maxManifestEntries: 4 })
    expect(prepared.header.manifest.map((entry) => entry.nodeSeq)).toEqual([1001, 1001, 1002, 1003])
  })

  it('keeps the newest window nodes that fit a manifest limit smaller than the window', async () => {
    for (const [limit, expected] of [
      [1, [1005]],
      [2, [1004, 1005]],
    ] as const) {
      const fixture = reclaimedFixture(5, () => false)
      const prepared = await prepare(fixture.surface, fixture.read, undefined, { maxManifestEntries: limit })
      expect(prepared.header.manifest.map((entry) => entry.nodeSeq)).toEqual(expected)
      expect(fixture.reads).toHaveLength(limit)
    }
  })

  it('still refuses a newest node that alone holds more images than the manifest limit', async () => {
    const images = [png(8, 8, 340), png(8, 8, 341)]
    const artifacts = artifactStore(images)
    const surface = [
      node(
        1,
        images.map((bytes) => ref(bytes)),
      ),
    ]
    await expect(
      prepare(surface, (sha256) => artifacts.get(sha256), undefined, { maxManifestEntries: 1 }),
    ).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it('stops extending after a bounded number of nodes when the whole history was reclaimed', async () => {
    const fixture = reclaimedFixture(20, () => true)
    const prepared = await prepare(fixture.surface, fixture.read)
    expect(prepared.header.manifest).toEqual([])
    expect(prepared.header.route).toBe('text-only')
    expect(fixture.reads).toEqual([18, 19, 20, 15, 16, 17, 12, 13, 14])
  })

  it('treats the sentinel as an omission and undefined as a missing artifact', async () => {
    const bytes = png(8, 8, 340)
    const surface = [node(1, [ref(bytes)])]
    await expect(collect(surface, () => REQUEST_MEDIA_ARTIFACT_RECLAIMED as never)).resolves.toEqual([])
    await expect(collect(surface, () => undefined)).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })
  })

  it('ends a restore whose persisted selection was reclaimed with ARTIFACT_RECLAIMED', async () => {
    const bytes = png(8, 8, 341)
    const surface = [node(1, [ref(bytes)])]
    const prepared = await prepare(surface, () => bytes)
    await expect(
      restoreRequestMediaFromLedger({
        sessionKey: 'session-a',
        lane: 'main',
        signal: new AbortController().signal,
        header: prepared.header,
        ledgerEvents: ledgerEvents(surface),
        readArtifact: () => REQUEST_MEDIA_ARTIFACT_RECLAIMED,
        surfaceLimits: wideSurfaceLimits,
        mediaLimits: wideMediaLimits,
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_RECLAIMED' })
  })
})
