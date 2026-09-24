import { deflateSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  AUXILIARY_VISION_MAX_EDGE,
  AuxiliaryVisionPlanError,
  auxiliaryVisionOutcome,
  prepareAuxiliaryVisionPlan,
} from '../src/orchestrator/auxiliary-vision.js'
import { prepareRequestMediaFromSurface } from '../src/orchestrator/request-media-surface.js'
import type { SurfaceNode } from '../src/project/surface.js'
import { sha256Hex } from '../src/request/hash.js'
import type { Event } from '../src/types.js'
import { toolCallLookup } from './helpers/request-media-lookup.js'

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
function png(width: number, height: number): Uint8Array {
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
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}

async function media(bytes = png(16, 16), sessionKey = 'session-a', sourceTool = 'computer_use') {
  const digest = sha256Hex(bytes)
  const call = {
    seq: 1,
    ts: '2026-09-17T00:00:00.000Z',
    id: '00000000000000000000000001',
    type: 'tool/call',
    data: { toolUseId: 'tool-1', name: sourceTool, args: {}, ordinal: 0 },
    actor: { id: 'a', org: '', role: 'user', deptPath: [], attrs: {} },
    origin: 'model',
    trust: 'untrusted',
    v: 1,
  } as Event
  const result = {
    ...call,
    seq: 2,
    id: '00000000000000000000000002',
    type: 'tool/result',
    origin: `tool:${sourceTool}`,
    sourceEventSeqs: [1],
    data: {
      toolUseId: 'tool-1',
      content: [{ type: 'resource_link', uri: `artifact://${digest}`, name: 'image', mimeType: 'image/png' }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
  } as Event
  const surface = [{ seq: 2, kind: 'tool_result', event: result, pinned: false }] as SurfaceNode[]
  return prepareRequestMediaFromSurface({
    sessionKey,
    lane: 'main',
    signal: new AbortController().signal,
    surface,
    lookupToolCalls: toolCallLookup([call, result]),
    readArtifact: () => bytes,
    mainModelInput: ['text'],
    auxiliaryVisionAvailable: true,
    surfaceLimits: {
      maxLedgerEvents: 8,
      maxSurfaceNodes: 4,
      maxContentBlocks: 4,
      maxManifestEntries: 4,
      maxCandidateBytes: 1024 * 1024,
      maxCandidatePixels: 4_000_000,
    },
    mediaLimits: {
      maxManifestEntries: 4,
      maxSelectedImages: 3,
      maxSelectedBlocks: 6,
      maxBytesPerImage: 1024 * 1024,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 4_000_000,
      maxSelectedBytes: 1024 * 1024,
      maxSelectedPixels: 4_000_000,
    },
  })
}

const target = {
  id: 'vision-model',
  route: 'vision-route',
  slot: 'image' as const,
  input: ['text', 'image'] as const,
  contract_id: null,
}

async function plan(overrides: Record<string, unknown> = {}) {
  return prepareAuxiliaryVisionPlan({
    sessionKey: 'session-a',
    lane: 'main',
    media: await media(),
    target,
    axSomText: '1: Save button',
    timeoutMs: { firstToken: 5000, total: 30_000 },
    imageLimits: {
      maxSelectedImages: 3,
      maxBytesPerImage: 1024 * 1024,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 4_000_000,
      maxSelectedBytes: 3 * 1024 * 1024,
      maxSelectedPixels: 8_000_000,
    },
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  })
}

describe('auxiliary vision request planning', () => {
  it('binds one image-slot request to session, manifest, budget and audit identities', async () => {
    const first = await plan()
    const second = await plan()
    expect(first).toEqual(second)
    expect(first).toMatchObject({ purpose: 'media', sessionKey: 'session-a', lane: 'main' })
    expect(first.request).toMatchObject({
      slot: 'image',
      route: 'vision-route',
      model: 'vision-model',
      tools: [],
      timeoutMs: { firstToken: 5000, total: 30_000 },
    })
    expect(first.request.messages[0]?.content.map((block) => block.type)).toEqual(['text', 'text', 'image'])
    expect(first.request.system).toContain('untrusted data')
    expect(first.mediaManifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.budgetBindingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.auditBindingHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(first.request.messages[0]?.content[2])).toBe(true)
  })

  it('fails closed for forged authority, cross-session media, wrong route and a text-only target', async () => {
    const authorized = await media()
    const cases = [
      () => plan({ media: { ...authorized } }),
      () => plan({ media: authorized, sessionKey: 'session-b' }),
      () =>
        plan({
          media: Object.freeze({ ...authorized, header: { ...authorized.header, route: 'native-image' } }),
        }),
      () => plan({ media: authorized, target: { ...target, input: ['text'] } }),
    ]
    for (const attempt of cases) await expect(attempt()).rejects.toBeInstanceOf(AuxiliaryVisionPlanError)
  })

  it('requires an explicit transform above 1456px and validates the transformed image', async () => {
    const oversized = await media(png(AUXILIARY_VISION_MAX_EDGE + 1, 8), 'session-a', 'browser_capture')
    await expect(plan({ media: oversized })).rejects.toMatchObject({ code: 'IMAGE_RESIZE_REQUIRED' })

    const transformImage = vi.fn(() => png(AUXILIARY_VISION_MAX_EDGE, 8))
    const prepared = await plan({ media: oversized, transformImage })
    expect(transformImage).toHaveBeenCalledOnce()
    expect(prepared.request.messages[0]?.content.at(-1)).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    })

    await expect(
      plan({ media: oversized, transformImage: () => new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({
      code: 'IMAGE_TRANSFORM_INVALID',
    })

    const abort = new AbortController()
    await expect(
      plan({
        media: oversized,
        signal: abort.signal,
        transformImage: () => {
          abort.abort()
          return png(AUXILIARY_VISION_MAX_EDGE, 8)
        },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
  })

  it('freezes exact wire blocks and binds ledger provenance and labels into every identity', async () => {
    const first = await plan({ media: await media(png(16, 16), 'session-a', 'computer_use') })
    const second = await plan({ media: await media(png(16, 16), 'session-a', 'other_tool') })
    expect(first.request.derivedHash).not.toBe(second.request.derivedHash)
    expect(first.auditBindingHash).not.toBe(second.auditBindingHash)
    const block = first.request.messages[0]?.content.at(-1) as { data: string }
    expect(Object.isFrozen(block)).toBe(true)
    expect(() => {
      block.data = 'Zm9yZ2Vk'
    }).toThrow()
  })

  it('returns only untrusted derived text and degrades to AX with vision_unavailable', () => {
    const success = auxiliaryVisionOutcome({ axSomText: '1: OK', visionText: 'Dialog is open' })
    expect(success).toMatchObject({ ok: true })
    expect(success.untrustedDerivedText).toContain('[untrusted auxiliary vision analysis]')
    const failure = auxiliaryVisionOutcome({ axSomText: '1: OK' })
    expect(failure).toMatchObject({
      ok: false,
      code: 'vision_unavailable',
      message: 'auxiliary vision unavailable',
    })
    expect(failure.untrustedDerivedText).toContain('1: OK')
    expect(failure.untrustedDerivedText).toContain('vision_unavailable')
  })
})
