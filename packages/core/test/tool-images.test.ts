import type { ToolContext, ToolResult } from '@agnes/extension-api'
import type { ModelRecord } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { expect, it } from 'vitest'
import { ToolRegistry } from '../src/registry/tools.js'
import { sha256Hex } from '../src/request/hash.js'
import { fakeProvider, textTurn, toolTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'

// 8x8 one-bit PNG, the smallest size request media accepts.
const png8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQAAAADsdIMmAAAACHRFWHRtYXJrZXIAME95DiIAAAALSURBVHicY2BABQAAEAABOb2PZQAAAABJRU5ErkJggg==',
  'base64',
)

const model = (input: ModelRecord['input']): ModelRecord => ({
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
  ...(input.includes('image') ? { inputLimits: { images: { maxPerRequest: 4 } } } : {}),
})

// 4x4, below the smallest size request media accepts.
const png4 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAEAQAAAACBiqPTAAAAC0lEQVR4nGNggAAAAAgAAbdYc5UAAAAASUVORK5CYII=',
  'base64',
)

async function readOnce(input: ModelRecord['input'], bytes: Uint8Array = png8) {
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
        seen.result = (await ctx.session.imageInput?.({ bytes, mimeType: 'image/png', name: 'a.png' })) ?? {
          content: [],
        }
        return seen.result
      },
    },
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  const provider = fakeProvider([toolTurn('read', { path: 'a.png' }), textTurn('seen')])
  provider.models = () => [model(input)]
  const artifacts = new Map<string, Uint8Array>()
  const { session } = await openSession({
    provider,
    registry,
    imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
    seams: (await import('./helpers/fake-seams.js')).fakeSeams({
      artifacts: {
        put: async (bytes, meta) => {
          const sha256 = sha256Hex(bytes)
          artifacts.set(sha256, bytes)
          return { sha256, size: bytes.length, mime: meta?.mime ?? 'image/png' }
        },
      },
    }),
    requestMedia: {
      readArtifact: async ({ sha256 }) => artifacts.get(sha256),
      surfaceLimits: {
        maxLedgerEvents: 4096,
        maxSurfaceNodes: 512,
        maxContentBlocks: 4096,
        maxManifestEntries: 32,
        maxCandidateBytes: 1024 * 1024,
        maxCandidatePixels: 8_000_000,
      },
      mediaLimits: {
        maxManifestEntries: 32,
        maxSelectedImages: 4,
        maxSelectedBlocks: 8,
        maxBytesPerImage: 1024 * 1024,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 1456 * 1456,
        maxSelectedBytes: 1024 * 1024,
        maxSelectedPixels: 8_000_000,
      },
    },
  })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'look at a.png' }], actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  return { seen, provider }
}

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
  const images = provider.requests
    .at(-1)
    ?.messages.filter((message) => message.role === 'tool_result')
    .flatMap((message) => message.content.filter((block) => block.type === 'image'))
  expect(images).toHaveLength(1)
})

it('tells a text-only model that the pixels were not inspected', async () => {
  const { seen } = await readOnce(['text'])
  expect(seen.policy).toMatchObject({ supported: false })
  expect(seen.result).toEqual({
    content: [{ type: 'text', text: expect.stringContaining('does not support image input') }],
  })
})

it('refuses bytes that do not decode as a safe image', async () => {
  const { seen } = await readOnce(['text', 'image'], Buffer.from('not an image'))
  expect(seen.result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: expect.stringContaining('could not be safely prepared') }],
  })
})

it('refuses an image below the smallest request dimension', async () => {
  const { seen } = await readOnce(['text', 'image'], png4)
  expect(seen.result).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: expect.stringContaining('dimension limits') }],
  })
})
