import { deflateSync } from 'node:zlib'
import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it } from 'vitest'
import type { RequestMediaLimits } from '../src/orchestrator/request-media.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { sha256Hex } from '../src/request/hash.js'
import { imageInput, imageInputPolicy } from '../src/request/tool-images.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

// 8x8 one-bit PNG, the smallest size request media accepts.
const png8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)

const u32 = (value: number) => [value >>> 24, value >>> 16, value >>> 8, value].map((byte) => byte & 0xff)
const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff]
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function chunk(type: string, data: readonly number[]): number[] {
  const typed = [...Buffer.from(type, 'ascii'), ...data]
  let crc = 0xffffffff
  for (const byte of typed) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return [...u32(data.length), ...typed, ...u32((crc ^ 0xffffffff) >>> 0)]
}
/** A blank one-bit PNG of the given size. */
function png(width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (Math.ceil(width / 8) + 1))
  return Uint8Array.from([
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk('IHDR', [...u32(width), ...u32(height), 1, 0, 0, 0, 0]),
    ...chunk('IDAT', [...deflateSync(raw)]),
    ...chunk('IEND', []),
  ])
}
/** A header-only baseline JPEG: frame, empty scan, EOI. Enough for the safe-image parser. */
function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    ...[0xff, 0xd8, 0xff, 0xc0, 0, 11, 8],
    ...u16(height),
    ...u16(width),
    ...[1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9],
  ])
}

type ImageLimits = NonNullable<NonNullable<ModelRecord['inputLimits']>['images']>

const model = (input: ModelRecord['input'], images: ImageLimits = { maxPerRequest: 4 }): ModelRecord => ({
  id: 'default',
  route: 'default',
  name: 'Model',
  api: 'openai-completions',
  baseUrl: 'https://test.invalid',
  input,
  reasoning: false,
  contextWindow: 128000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...(input.includes('image') ? { inputLimits: { images } } : {}),
})

const mediaLimits: RequestMediaLimits = {
  maxManifestEntries: 32,
  maxSelectedImages: 4,
  maxSelectedBlocks: 8,
  maxBytesPerImage: 1024 * 1024,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 1456 * 1456,
  maxSelectedBytes: 1024 * 1024,
  maxSelectedPixels: 8_000_000,
}

type Setup = {
  input?: ModelRecord['input']
  images?: ImageLimits
  limits?: Partial<RequestMediaLimits> | 'none'
  put?: () => void
  scripts?: Parameters<typeof fakeProvider>[0]
  registry?: ToolRegistry
}

async function open(setup: Setup = {}) {
  const provider = fakeProvider(setup.scripts ?? [])
  const record = model(setup.input ?? ['text', 'image'], setup.images)
  provider.models = () => [record]
  const artifacts = new Map<string, Uint8Array>()
  const names: string[] = []
  const { session } = await openSession({
    provider,
    ...(setup.registry ? { registry: setup.registry } : {}),
    imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
    seams: fakeSeams({
      artifacts: {
        put: async (bytes, meta) => {
          setup.put?.()
          const sha256 = sha256Hex(bytes)
          artifacts.set(sha256, bytes)
          names.push(meta?.name ?? '')
          return { sha256, size: bytes.length, mime: meta?.mime ?? 'image/png' }
        },
      },
    }),
    ...(setup.limits === 'none'
      ? {}
      : {
          requestMedia: {
            readArtifact: async ({ sha256 }: { sha256: string }) => artifacts.get(sha256),
            surfaceLimits: {
              maxLedgerEvents: 4096,
              maxSurfaceNodes: 512,
              maxContentBlocks: 4096,
              maxManifestEntries: 32,
              maxCandidateBytes: 1024 * 1024,
              maxCandidatePixels: 8_000_000,
            },
            mediaLimits: { ...mediaLimits, ...setup.limits },
          },
        }),
  })
  return { session, provider, names }
}

async function readOnce(
  input: ModelRecord['input'],
  bytes: Uint8Array = png8,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png',
) {
  const seen: { policy?: unknown; result?: ToolResult } = {}
  const registry = new ToolRegistry()
  registry.add(
    {
      name: 'read',
      description: 'read',
      parameters: Type.Object({ path: Type.String() }),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: false,
        replay: 'safe',
        costHint: {},
        deferLoading: false,
        requiresApproval: 'never',
      },
      execute: async (_args: unknown, ctx: ToolContext) => {
        seen.policy = await ctx.session.imageInputPolicy?.()
        seen.result = (await ctx.session.imageInput?.({ bytes, mimeType, name: 'a.png' })) ?? {
          content: [],
        }
        return seen.result
      },
    },
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const { session, provider } = await open({
    input,
    registry,
    scripts: [toolTurn('read', { path: 'a.png' }), textTurn('seen')],
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'look at a.png' }], actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  return { seen, provider }
}

const sentImages = (provider: Awaited<ReturnType<typeof readOnce>>['provider']) =>
  provider.requests
    .at(-1)
    ?.messages.filter((message) => message.role === 'tool_result')
    .flatMap((message) => message.content.filter((block) => block.type === 'image'))

it('turns prepared tool pixels into an artifact-backed image that the next request sends', async () => {
  const { seen, provider } = await readOnce(['text', 'image'])
  expect(seen.policy).toEqual({
    supported: true,
    maxWidth: 1456,
    maxHeight: 1456,
    maxBytes: 1024 * 1024,
    maxPixels: 1456 * 1456,
  })
  expect(seen.result?.content.map((block) => block.type)).toEqual(['text', 'image'])
  expect(sentImages(provider)).toHaveLength(1)
  expect(JSON.stringify(provider.requests.at(-1))).toContain('[untrusted tool image; source_tool=read;')
})

it('carries a prepared JPEG the same way', async () => {
  const { seen, provider } = await readOnce(['text', 'image'], jpeg(16, 8), 'image/jpeg')
  expect(seen.result?.content.at(-1)).toMatchObject({ type: 'image', mime: 'image/jpeg' })
  expect(sentImages(provider)).toHaveLength(1)
})

it('tells a text-only model that the pixels were not inspected', async () => {
  const { seen } = await readOnce(['text'])
  expect(seen.policy).toMatchObject({ supported: false })
  expect(seen.result).toEqual({
    content: [{ type: 'text', text: expect.stringContaining('does not support image input') }],
  })
})

it('says the runtime, not the model, is missing when request media is absent', async () => {
  const { session } = await open({ limits: 'none' })
  expect(imageInputPolicy(session)).toMatchObject({ supported: false })
  const result = await imageInput(
    session,
    { bytes: png8, mimeType: 'image/png', name: 'a.png' },
    new AbortController().signal,
  )
  expect(result).toEqual({
    content: [{ type: 'text', text: expect.stringContaining('This runtime cannot send tool images') }],
  })
})

describe('policy is the tightest of model and runtime limits', () => {
  const base = {
    supported: true,
    maxWidth: 1456,
    maxHeight: 1456,
    maxBytes: 1024 * 1024,
    maxPixels: 1456 ** 2,
  }
  it.each<[string, Setup, Partial<typeof base>]>([
    [
      'model resize bounds narrow the dimensions',
      { images: { resize: { maxWidth: 64, maxHeight: 32 } } },
      {
        maxWidth: 64,
        maxHeight: 32,
      },
    ],
    [
      'runtime dimension cap narrows a wider model',
      { images: { resize: { maxWidth: 1000 } }, limits: { maxDimensionPerImage: 48 } },
      {
        maxWidth: 48,
        maxHeight: 48,
      },
    ],
    ['per-image byte cap', { limits: { maxBytesPerImage: 2000 } }, { maxBytes: 2000 }],
    ['selected byte cap below the per-image cap', { limits: { maxSelectedBytes: 1000 } }, { maxBytes: 1000 }],
    [
      'model Base64 cap converts to raw bytes, rounded down',
      { images: { resize: { maxBytes: 103 } } },
      {
        maxBytes: 75,
      },
    ],
    ['per-image pixel cap', { limits: { maxPixelsPerImage: 6000 } }, { maxPixels: 6000 }],
    [
      'selected pixel cap below the per-image cap',
      { limits: { maxSelectedPixels: 5000 } },
      { maxPixels: 5000 },
    ],
  ])('%s', async (_name, setup, expected) => {
    const { session } = await open(setup)
    expect(imageInputPolicy(session)).toEqual({ ...base, ...expected })
  })
})

describe('guards refuse with an error result and store nothing', () => {
  // Base64 cap whose raw equivalent is just below png8's size, while the cap itself is above it.
  const base64Cap = 4 * Math.floor((png8.length - 1) / 3) + 3
  it.each<[string, Setup, Uint8Array, 'image/png' | 'image/jpeg', string]>([
    [
      'one byte over the per-image byte cap',
      { limits: { maxBytesPerImage: png8.length - 1 } },
      png8,
      'image/png',
      'exceeds byte limit',
    ],
    [
      'one byte over the selected byte cap',
      { limits: { maxSelectedBytes: png8.length - 1 } },
      png8,
      'image/png',
      'exceeds byte limit',
    ],
    [
      'the model Base64 cap after conversion',
      { images: { resize: { maxBytes: base64Cap } } },
      png8,
      'image/png',
      'exceeds byte limit',
    ],
    [
      'one row over the per-image pixel cap',
      { limits: { maxPixelsPerImage: 64 * 64 } },
      png(64, 65),
      'image/png',
      'exceed pixel limit',
    ],
    [
      'one row over the selected pixel cap',
      { limits: { maxSelectedPixels: 64 * 64 } },
      png(64, 65),
      'image/png',
      'exceed pixel limit',
    ],
    ['wider than the product dimension bound', {}, png(2000, 8), 'image/png', 'dimension limits'],
    ['taller than the product dimension bound', {}, png(8, 2000), 'image/png', 'dimension limits'],
    [
      'wider than the model resize bound',
      { images: { resize: { maxWidth: 64 } } },
      png(65, 8),
      'image/png',
      'dimension limits',
    ],
    [
      'taller than the model resize bound',
      { images: { resize: { maxHeight: 64 } } },
      png(8, 65),
      'image/png',
      'dimension limits',
    ],
    [
      'wider than the runtime dimension cap',
      { limits: { maxDimensionPerImage: 48 } },
      png(49, 8),
      'image/png',
      'dimension limits',
    ],
    ['narrower than the smallest request dimension', {}, png(7, 8), 'image/png', 'dimension limits'],
    ['shorter than the smallest request dimension', {}, png(8, 7), 'image/png', 'dimension limits'],
    ['declared JPEG with PNG bytes', {}, png8, 'image/jpeg', 'does not match image magic'],
    ['declared PNG with JPEG bytes', {}, jpeg(16, 8), 'image/png', 'does not match image magic'],
    [
      'bytes that are not an image',
      {},
      Buffer.from('not an image'),
      'image/png',
      'could not be safely prepared',
    ],
  ])('%s', async (_name, setup, bytes, mimeType, message) => {
    const { session, names } = await open(setup)
    const result = await imageInput(session, { bytes, mimeType, name: 'a.png' }, new AbortController().signal)
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: expect.stringContaining(message) }],
    })
    expect(names).toEqual([])
  })

  it.each<[string, Setup, Uint8Array]>([
    ['exactly the byte cap', { limits: { maxBytesPerImage: png8.length } }, png8],
    ['exactly the pixel cap', { limits: { maxPixelsPerImage: 64 * 64 } }, png(64, 64)],
    ['exactly the model resize bound', { images: { resize: { maxWidth: 64 } } }, png(64, 8)],
    ['exactly the product dimension bound', {}, png(1456, 8)],
  ])('accepts %s', async (_name, setup, bytes) => {
    const { session, names } = await open(setup)
    const result = await imageInput(
      session,
      { bytes, mimeType: 'image/png', name: 'a.png' },
      new AbortController().signal,
    )
    expect(result.isError).toBeUndefined()
    expect(result.content.map((block) => block.type)).toEqual(['text', 'image'])
    expect(names).toHaveLength(1)
  })
})

it('bounds the artifact name and strips control characters from it', async () => {
  const { session, names } = await open()
  const signal = new AbortController().signal
  await imageInput(
    session,
    { bytes: png8, mimeType: 'image/png', name: `a\u0000b\nc\u009b${'x'.repeat(300)}` },
    signal,
  )
  await imageInput(session, { bytes: png8, mimeType: 'image/png', name: '\u0007\r' }, signal)
  expect(names).toEqual([`abc${'x'.repeat(125)}`, 'tool-image'])
})

describe('cancellation propagates instead of becoming an error result', () => {
  it('refuses before storing anything when already aborted', async () => {
    const { session, names } = await open()
    const ac = new AbortController()
    ac.abort(new Error('cancelled'))
    await expect(
      imageInput(session, { bytes: png8, mimeType: 'image/png', name: 'a.png' }, ac.signal),
    ).rejects.toThrow('cancelled')
    expect(names).toEqual([])
  })

  it('rejects when cancelled while the artifact is stored', async () => {
    const ac = new AbortController()
    const { session, names } = await open({ put: () => ac.abort(new Error('cancelled')) })
    await expect(
      imageInput(session, { bytes: png8, mimeType: 'image/png', name: 'a.png' }, ac.signal),
    ).rejects.toThrow('cancelled')
    expect(names).toHaveLength(1)
  })
})
