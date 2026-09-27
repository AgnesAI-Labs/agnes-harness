import type { ToolDef } from '@agnes/extension-api'
import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { Type } from '@sinclair/typebox'
import { describe, expect, it, vi } from 'vitest'
import type { HostToolDispatchPort } from '../src/effects/tool-dispatch.js'
import { mintAuxiliaryVisionProductionAdmission } from '../src/orchestrator/auxiliary-vision-assembly.js'
import { loadAuxiliaryVisionPreflight } from '../src/orchestrator/request-media-preflight.js'
import { REQUEST_MEDIA_ARTIFACT_RECLAIMED } from '../src/orchestrator/request-media-surface.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { headerEquals, type RequestHeaderData } from '../src/request/derive.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import { applyBeforeRequestPatches } from '../src/request/transforms.js'
import { surfaceToolCalls } from '../src/step/inference.js'
import { presetDefaults } from '../src/step/preset.js'
import { noopHooks } from '../src/step/session.js'
import {
  fakeProvider,
  type Script,
  sent,
  sentFor,
  textTurn,
  toolTurn,
  usage,
} from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, immediateTimers, openSession, readTool, shellTool } from './helpers/open-session.js'

async function primed(
  scripts: Script[],
  registry = new ToolRegistry(),
  hostToolDispatch?: HostToolDispatchPort,
) {
  const provider = fakeProvider(scripts)
  const s = await openSession({ provider, registry, ...(hostToolDispatch ? { hostToolDispatch } : {}) })
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
  await s.session.acceptInput()
  return { ...s, provider }
}
const readRegistry = () => {
  const r = new ToolRegistry()
  r.add(readTool(), { source: 'agnes/tools-core', trust: 'builtin' })
  return r
}

it('reuses context hooks within a turn and moves changed context to a tail note', async () => {
  const { session, provider } = await primed(
    [toolTurn('read', { path: 'a' }), toolTurn('read', { path: 'b' }), textTurn('done'), textTurn('next')],
    readRegistry(),
  )
  let calls = 0
  let contextText = 'first'
  session.hooks = {
    ...session.hooks,
    context: async (sections) => {
      calls++
      return { sections, additionalContext: contextText }
    },
  }
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(calls).toBe(1)
  expect(provider.requests).toHaveLength(3)
  const first = provider.requests[0]
  const second = provider.requests[1]
  if (!first || !second) throw new Error('missing request')
  expect(second.system).toBe(first.system)
  expect(first.messages.at(-1)?.content).toEqual([{ type: 'text', text: '[hook context]\nfirst' }])
  contextText = 'second'
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(calls).toBe(2)
  const next = provider.requests[3]
  if (!next) throw new Error('missing next-turn request')
  expect(next.system).toBe(first.system)
  expect(next.messages.at(-1)?.content).toEqual([{ type: 'text', text: '[hook context]\nsecond' }])
})

it('recomputes the context hook when the primary model changes mid-turn', async () => {
  const { session } = await primed([toolTurn('read', { path: 'a' }), textTurn('done')], readRegistry())
  let calls = 0
  session.hooks = {
    ...session.hooks,
    beforeStep: async ({ step }) => {
      if (step === 2) session.preset.model.id.primary = 'another-model'
      return {}
    },
    context: async (sections) => {
      calls++
      return { sections, additionalContext: 'same' }
    },
  }
  expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
    'completed',
  )
  expect(calls).toBe(2)
})

const mediaJpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff,
  0xd9,
])
const mediaDigest = sha256Hex(mediaJpeg)
const mediaRuntime = {
  readArtifact: async ({ sha256 }: { sha256: string }) => (sha256 === mediaDigest ? mediaJpeg : undefined),
  surfaceLimits: {
    maxLedgerEvents: 32,
    maxSurfaceNodes: 32,
    maxContentBlocks: 64,
    maxManifestEntries: 8,
    maxCandidateBytes: 4096,
    maxCandidatePixels: 4096,
  },
  mediaLimits: {
    maxManifestEntries: 8,
    maxSelectedImages: 3,
    maxSelectedBlocks: 8,
    maxBytesPerImage: 4096,
    maxDimensionPerImage: 1456,
    maxPixelsPerImage: 4096,
    maxSelectedBytes: 8192,
    maxSelectedPixels: 8192,
  },
}

function mediaRegistry(toolName = 'computer_use'): ToolRegistry {
  const registry = new ToolRegistry()
  registry.add(
    {
      name: toolName,
      description: 'capture',
      parameters: Type.Object({}),
      meta: {
        isReadOnly: true,
        isDestructive: false,
        isConcurrencySafe: true,
        isOpenWorld: true,
        replay: 'safe',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'never',
      },
      execute: async () => ({
        content: [
          { type: 'text', text: '1: Save button' },
          {
            type: 'image',
            ref: { sha256: mediaDigest, size: mediaJpeg.byteLength, mime: 'image/jpeg' },
            mime: 'image/jpeg',
          },
        ],
      }),
    } as never,
    toolName === 'computer_use'
      ? {
          source: 'agnes/computer-use',
          trust: 'builtin',
          packageIdentity: '@agnes/base',
          packageVersion: '1.0.0',
          executionDomain: 'host-computer-use',
        }
      : { source: 'agnes/test-media', trust: 'builtin' },
  )
  return registry
}

const auxiliaryMediaTool = 'test_image_capture'

const primaryModel = (input: ModelRecord['input']): ModelRecord => ({
  id: 'primary',
  name: 'primary',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  slot: 'primary',
})
const imageModel: ModelRecord = {
  ...primaryModel(['text', 'image']),
  id: 'vision',
  route: 'aux',
  slot: 'image',
}

describe('Inference segment', () => {
  it('captures the post-hook primary prefix for later summary requests', async () => {
    const registry = readRegistry()
    const { session } = await primed([toolTurn('read', { path: 'x' })], registry)
    session.hooks = {
      ...session.hooks,
      beforeRequest: async (out) =>
        applyBeforeRequestPatches(out, [{ ext: 'test', patch: { samplingParams: { temperature: 0.2 } } }]),
    }
    await session.runInference()
    const prefix = session.turn?.lastPrefix
    expect(prefix?.samplingParams?.temperature).toBe(0.2)
    expect(prefix?.sections[0]?.id).toBe('core:untrusted-envelope')
    expect(prefix?.tools.map((tool) => tool.name)).toContain('read')
  })

  it('preflights surface artifacts and sends native images only to an image-capable primary model', async () => {
    const provider = fakeProvider([toolTurn('computer_use', {}), textTurn('done')])
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(),
      requestMedia: mediaRuntime,
      imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(
      provider.requests[1]?.messages.some((message) => message.content.some((b) => b.type === 'image')),
    ).toBe(true)
    const headers = await log.scan({ type: 'request/header', limit: 10 })
    expect(headers.at(-1)?.data).toMatchObject({ media: { route: 'native-image' } })
  })

  it('writes no request-media-window diagnostic when only plain messages fall outside the scan', async () => {
    const provider = fakeProvider([textTurn('one'), textTurn('two'), textTurn('three'), textTurn('four')])
    const { session, log } = await openSession({
      provider,
      requestMedia: { ...mediaRuntime, surfaceLimits: { ...mediaRuntime.surfaceLimits, maxSurfaceNodes: 2 } },
    })
    const signal = new AbortController().signal
    for (const text of ['a', 'b', 'c', 'd']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    }
    expect(provider.requests).toHaveLength(4)
    expect(await log.scan({ type: 'x/core/request-media-window', limit: 10 })).toEqual([])
  })

  it('writes one request-media-window diagnostic per session and reason across turns', async () => {
    const provider = fakeProvider([
      toolTurn('read', { path: 'a' }),
      textTurn('one'),
      toolTurn('read', { path: 'b' }),
      textTurn('two'),
      toolTurn('read', { path: 'c' }),
      textTurn('three'),
    ])
    const { session, log } = await openSession({
      provider,
      registry: readRegistry(),
      requestMedia: { ...mediaRuntime, surfaceLimits: { ...mediaRuntime.surfaceLimits, maxSurfaceNodes: 2 } },
    })
    const signal = new AbortController().signal
    for (const text of ['a', 'b', 'c']) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      expect((await session.run({ until: 'turn-end', signal })).reason).toBe('completed')
    }
    expect(provider.requests).toHaveLength(6)
    const rows = await log.scan({ type: 'x/core/request-media-window', limit: 10 })
    expect(rows.map((row) => row.data)).toEqual([{ reason: 'surface-nodes', scannedNodes: 2, imageNodes: 0 }])
  })

  it('ends the turn when a retried request finds its selected screenshot reclaimed', async () => {
    const provider = fakeProvider([
      toolTurn('computer_use', {}),
      [
        sent('primary'),
        { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'retry', retryable: true },
      ],
      textTurn('done'),
    ])
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    let reads = 0
    let now = 1_757_203_200_000
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(),
      requestMedia: {
        ...mediaRuntime,
        readArtifact: async ({ sha256 }: { sha256: string }) => {
          reads += 1
          if (sha256 !== mediaDigest) return undefined
          return reads === 1 ? mediaJpeg : REQUEST_MEDIA_ARTIFACT_RECLAIMED
        },
      },
      imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
      timers: immediateTimers,
      clock: () => {
        now += 1_000
        return now
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome.reason).toBe('error')
    expect(outcome.error?.message).toContain('reclaimed')
    expect(reads).toBe(2)
    const ended = await log.scan({ type: 'turn/end', limit: 10 })
    expect(ended.at(-1)?.data).toMatchObject({ reason: 'error' })
  })

  it('keeps the request-media error when writing the truncation diagnostic fails', async () => {
    const provider = fakeProvider([
      toolTurn('computer_use', {}),
      toolTurn('computer_use', {}),
      textTurn('done'),
    ])
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    let reads = 0
    const { session } = await openSession({
      provider,
      registry: mediaRegistry(),
      requestMedia: {
        ...mediaRuntime,
        surfaceLimits: { ...mediaRuntime.surfaceLimits, maxSurfaceNodes: 2 },
        readArtifact: async ({ sha256 }: { sha256: string }) => {
          reads += 1
          return reads === 1 && sha256 === mediaDigest ? mediaJpeg : undefined
        },
      },
      imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    vi.spyOn(session, 'diag').mockRejectedValue(new Error('diagnostic write failed'))
    await expect(session.runInference()).rejects.toMatchObject({ code: 'ARTIFACT_BYTES_MISSING' })
  })

  it('adds no surface ledger scan to a step whose surface carries no images', async () => {
    const scansDuringSecondInference = async (withMedia: boolean) => {
      const provider = fakeProvider([toolTurn('read', { path: 'a' }), textTurn('done')])
      const { session } = await openSession({
        provider,
        registry: readRegistry(),
        ...(withMedia ? { requestMedia: mediaRuntime } : {}),
      })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
      await session.acceptInput()
      expect(await session.runInference()).toEqual({ phase: 'tools' })
      expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
      const scan = vi.spyOn(session.d.log, 'scan')
      expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
      return scan.mock.calls.map(([query]) => String(query?.type)).sort()
    }
    // The only extra read with a media runtime is the durable auxiliary preflight lookup, which does
    // not depend on the surface; the media path itself reads nothing when no image is present.
    expect(await scansDuringSecondInference(true)).toEqual(
      [...(await scansDuringSecondInference(false)), 'x/core/auxiliary-vision-preflight'].sort(),
    )
  })

  it('withholds Computer Use from a text-only primary model and refuses a stale call', async () => {
    const provider = fakeProvider([toolTurn('computer_use', {})])
    Object.assign(provider, { models: () => [primaryModel(['text'])] })
    let operationSnapshotContainsComputerUse: boolean | undefined
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(),
      operations: [
        {
          name: 'observe-model-tools',
          slot: 'before-inference',
          replay: 'safe',
          applicable: async () => 'applied',
          run: async () => ({}),
          contribute: (ctx) => {
            operationSnapshotContainsComputerUse = ctx.snapshot.byName.has('computer_use')
            return {}
          },
        },
      ],
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain('computer_use')
    expect(provider.requests[0]?.system).toContain('the user needs to select a model that supports images')
    expect(operationSnapshotContainsComputerUse).toBe(false)
    await expect(session.invokeTool('computer_use', {}, { depth: 1 })).rejects.toMatchObject({
      code: 'TOOL_NOT_DISCLOSED',
    })
    const result = (await log.scan({ type: 'tool/result', limit: 10 })).at(-1)
    expect(result?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
  })

  it('refuses a queued Computer Use call if the primary model becomes text-only before execution', async () => {
    let input: ModelRecord['input'] = ['text', 'image']
    const provider = fakeProvider([toolTurn('computer_use', {})])
    Object.assign(provider, { models: () => [primaryModel(input)] })
    const dispatch = vi.fn(async (request: Parameters<HostToolDispatchPort['dispatch']>[0]) => ({
      phase: 'responded' as const,
      result: await request.invoke(),
    }))
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(),
      hostToolDispatch: { dispatch },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    input = ['text']
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(dispatch).not.toHaveBeenCalled()
    const result = (await log.scan({ type: 'tool/result', limit: 10 })).at(-1)
    expect(result?.data).toMatchObject({ code: 'TOOL_NOT_DISCLOSED', isError: true })
  })

  it('discloses Computer Use to an image-capable primary model', async () => {
    const provider = fakeProvider([textTurn('done')])
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    const { session } = await openSession({ provider, registry: mediaRegistry() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain('computer_use')
  })

  it.each([
    ['a missing model record', []],
    ['an image-only model', [primaryModel(['image'])]],
    ['duplicate matching records', [primaryModel(['text', 'image']), primaryModel(['text', 'image'])]],
  ] as const)('fails closed for Computer Use with %s', async (_case, models) => {
    const provider = fakeProvider([textTurn('done')])
    Object.assign(provider, { models: () => models })
    const { session } = await openSession({ provider, registry: mediaRegistry() })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain('computer_use')
  })

  it('ends aborted without provider dispatch when cancellation races an artifact read', async () => {
    const provider = fakeProvider([toolTurn('computer_use', {})])
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    let started: (() => void) | undefined
    let release: (() => void) | undefined
    let readerSignal: AbortSignal | undefined
    const readStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const blockedRead = new Promise<void>((resolve) => {
      release = resolve
    })
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(),
      requestMedia: {
        ...mediaRuntime,
        readArtifact: async ({ signal }: { signal: AbortSignal }) => {
          readerSignal = signal
          started?.()
          await blockedRead
          throw new Error('Bearer artifact-reader-secret')
        },
      },
      imageInputTokenFallback: ({ imageCount }) => ({ tokens: 128, imageCount }),
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    const inference = session.runInference()
    await readStarted
    expect(readerSignal).toBe(session.ac.signal)
    await session.abort(actor)
    release?.()
    await expect(inference).resolves.toEqual({ phase: 'terminal', reason: 'aborted' })
    expect(provider.requests).toHaveLength(1)
    const ended = await log.scan({ type: 'turn/end', limit: 10 })
    expect(ended.at(-1)?.data).toMatchObject({ reason: 'aborted' })
    expect(JSON.stringify(ended)).not.toContain('artifact-reader-secret')
  })

  it('keeps auxiliary routing closed without the private P0 admission and sends text only', async () => {
    const provider = fakeProvider([toolTurn(auxiliaryMediaTool, {}), textTurn('done')])
    Object.assign(provider, { models: () => [primaryModel(['text'])] })
    const { session, log } = await openSession({
      provider,
      registry: mediaRegistry(auxiliaryMediaTool),
      requestMedia: {
        ...mediaRuntime,
        auxiliaryVision: {
          timeoutMs: { firstToken: 5_000, total: 30_000 },
          imageLimits: {
            maxSelectedImages: 3,
            maxBytesPerImage: 4096,
            maxDimensionPerImage: 1456,
            maxPixelsPerImage: 4096,
            maxSelectedBytes: 8192,
            maxSelectedPixels: 8192,
          },
          maxOutputTokens: 128,
        },
      },
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    await session.runInference()
    await session.runToolsPhase()
    await session.runInference()
    expect(
      provider.requests[1]?.messages.every((message) => message.content.every((b) => b.type !== 'image')),
    ).toBe(true)
    const headers = await log.scan({ type: 'request/header', limit: 10 })
    expect(headers.at(-1)?.data).toMatchObject({ media: { route: 'text-only' } })
  })

  it('settles auxiliary vision before deriving the text-only primary request', async () => {
    let now = 1_757_203_200_000
    const provider = fakeProvider([
      toolTurn(auxiliaryMediaTool, {}),
      [
        sent('vision'),
        { type: 'text_delta', delta: 'Save is visible' },
        usage(),
        { type: 'done', reason: 'stop' },
      ],
      [
        sent('primary'),
        { type: 'error', reason: 'error', code: 'TRANSPORT', message: 'retry', retryable: true },
      ],
      textTurn('done'),
    ])
    Object.assign(provider, {
      models: () => [primaryModel(['text']), imageModel],
      count: async (request: RequestBody) => ({
        tokens: 64,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const preset = presetDefaults()
    const { session, log } = await openSession({
      provider,
      preset: {
        ...preset,
        model: {
          ...preset.model,
          route: { ...preset.model.route, image: 'aux' },
          id: { ...preset.model.id, image: 'vision' },
        },
      },
      registry: mediaRegistry(auxiliaryMediaTool),
      requestMedia: {
        ...mediaRuntime,
        auxiliaryVision: {
          productionAdmission: mintAuxiliaryVisionProductionAdmission(),
          timeoutMs: { firstToken: 5_000, total: 30_000 },
          imageLimits: {
            maxSelectedImages: 3,
            maxBytesPerImage: 4096,
            maxDimensionPerImage: 1456,
            maxPixelsPerImage: 4096,
            maxSelectedBytes: 8192,
            maxSelectedPixels: 8192,
          },
          maxOutputTokens: 128,
        },
      },
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
      clock: () => now,
      timers: immediateTimers,
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'capture' }], actor })
    await session.acceptInput()
    await session.runInference()
    await session.runToolsPhase()
    expect(await session.runInference()).toEqual({ phase: 'inference' })
    now += 2_000
    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(provider.requests).toHaveLength(4)
    expect(provider.requests[1]).toMatchObject({ slot: 'image', route: 'aux', model: 'vision' })
    expect(
      provider.requests[3]?.messages.every((message) => message.content.every((b) => b.type !== 'image')),
    ).toBe(true)
    expect(JSON.stringify(provider.requests[1])).toContain('1: Save button')
    expect(JSON.stringify(provider.requests[3])).toContain('Save is visible')
    expect(JSON.stringify(provider.requests[3])).toContain('<untrusted id=')
    expect(provider.requests[3]?.derivedHash).toBe(provider.requests[2]?.derivedHash)
    const headers = await log.scan({ type: 'request/header', limit: 10 })
    expect(headers.at(-1)?.data).toMatchObject({ media: { route: 'auxiliary-vision' } })
  })

  it('restores a durable auxiliary preflight across a crash before the primary header', async () => {
    const firstProvider = fakeProvider([
      toolTurn(auxiliaryMediaTool, {}),
      [
        sent('vision'),
        { type: 'text_delta', delta: 'Save survived restart' },
        usage(),
        { type: 'done', reason: 'stop' },
      ],
    ])
    Object.assign(firstProvider, {
      models: () => [primaryModel(['text']), imageModel],
      count: async (request: RequestBody) => ({
        tokens: 64,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const preset = presetDefaults()
    const configuredPreset = {
      ...preset,
      model: {
        ...preset.model,
        route: { ...preset.model.route, image: 'aux' },
        id: { ...preset.model.id, image: 'vision' },
      },
    }
    const auxiliaryVision = {
      productionAdmission: mintAuxiliaryVisionProductionAdmission(),
      timeoutMs: { firstToken: 5_000, total: 30_000 },
      imageLimits: {
        maxSelectedImages: 3,
        maxBytesPerImage: 4096,
        maxDimensionPerImage: 1456,
        maxPixelsPerImage: 4096,
        maxSelectedBytes: 8192,
        maxSelectedPixels: 8192,
      },
      maxOutputTokens: 128,
    }
    const first = await openSession({
      provider: firstProvider,
      preset: configuredPreset,
      registry: mediaRegistry(auxiliaryMediaTool),
      requestMedia: { ...mediaRuntime, auxiliaryVision },
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await first.session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'capture' }],
      actor,
    })
    await first.session.acceptInput()
    await first.session.runInference()
    await first.session.runToolsPhase()
    first.session.hooks = {
      ...noopHooks,
      beforeRequest: async () => {
        throw new Error('crash cut before primary header')
      },
    }
    await expect(first.session.runInference()).rejects.toThrow('crash cut before primary header')
    const preflights = await first.log.scan({ type: 'x/core/auxiliary-vision-preflight', limit: 10 })
    const intents = await first.log.scan({ type: 'x/core/auxiliary-vision-intent', limit: 10 })
    expect(preflights).toHaveLength(1)
    expect(intents).toHaveLength(1)
    expect(preflights[0]?.seq).toBeLessThan(intents[0]?.seq ?? 0)
    expect(await first.log.scan({ type: 'x/core/auxiliary-vision-terminal', limit: 10 })).toHaveLength(1)
    expect(await first.log.scan({ type: 'request/header', limit: 10 })).toHaveLength(1)
    await first.log.close()

    const resumedProvider = fakeProvider([textTurn('done')])
    // Capability drift after the crash must not convert the already-preflighted auxiliary route
    // into a native-image request or mint a different media effect.
    Object.assign(resumedProvider, {
      models: () => [primaryModel(['text', 'image']), imageModel],
      count: async (request: RequestBody) => ({
        tokens: 64,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const resumed = await openSession({
      provider: resumedProvider,
      storage: first.storage,
      key: 'k',
      writerRunId: 'r2',
      preset: configuredPreset,
      registry: mediaRegistry(auxiliaryMediaTool),
      requestMedia: { ...mediaRuntime, auxiliaryVision },
      hostToolDispatch: {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    })
    await resumed.session.resume()
    expect(await resumed.session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(resumedProvider.requests).toHaveLength(1)
    expect(
      resumedProvider.requests[0]?.messages.every((message) =>
        message.content.every((block) => block.type !== 'image'),
      ),
    ).toBe(true)
    expect(JSON.stringify(resumedProvider.requests[0])).toContain('Save survived restart')
    expect(await resumed.log.scan({ type: 'x/core/auxiliary-vision-preflight', limit: 10 })).toHaveLength(1)
    expect(await resumed.log.scan({ type: 'x/core/auxiliary-vision-intent', limit: 10 })).toHaveLength(1)
    const costs = await resumed.log.scan({ type: 'cost/ledger', limit: 10 })
    expect(costs.filter((event) => (event.data as { purpose?: unknown }).purpose === 'media')).toHaveLength(1)
  })

  it('fails closed on a malformed durable auxiliary preflight', async () => {
    const { session } = await openSession({ provider: fakeProvider([]) })
    await session.append([
      session.ev(
        'x/core/auxiliary-vision-preflight',
        { version: 1, turn: 1, step: 1, triggerSeq: 1, mediaHash: '0'.repeat(64) },
        { ignorable: true },
      ),
    ])
    await expect(
      loadAuxiliaryVisionPreflight(session, {
        sessionKey: session.key,
        lane: session.lane,
        turn: 1,
        step: 1,
        attempt: 0,
        triggerSeq: 1,
      }),
    ).rejects.toThrow('malformed auxiliary media preflight')
  })

  it('a text answer lands the whole settlement in one shape and leaves the phase at may_finish', async () => {
    const { session, log } = await primed([textTurn('hello world')])
    const out = await session.runInference()
    expect(out).toEqual({ phase: 'checkpoint' })
    const types = (await log.scan({ fromSeq: 6, limit: 50 })).map((e) => e.type)
    expect(types).toEqual([
      'x/core/context-breakdown',
      'step/start',
      // Core's intent precedes the provider's receipt, and both precede the model output they
      // explain. A replaying consumer therefore never reads an effect before either cause.
      'request/header',
      'effect/intent',
      'request/sent',
      'assistant/output',
      'assistant/message',
      'cost/ledger',
      'effect/settled',
      'step/end',
    ])
    expect(session.op()).toMatchObject({ step: 1, phase: { kind: 'checkpoint', continuation: 'may_finish' } })
    expect(session.op()?.latestAssistantSeq).toBe(12)
    const msg = (await log.scan({ type: 'assistant/message', limit: 5 }))[0]
    expect(msg?.data).toMatchObject({
      content: [{ type: 'text', text: 'hello world' }],
      stopReason: 'end_turn',
    })
    // The stream's own usage row is what is billed, not the four-chars-a-token fallback.
    expect((await log.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data).toMatchObject({
      tokens: { input: 10, output: 5 },
      credits: 1,
      purpose: 'inference',
    })
    expect((await log.scan({ type: 'effect/settled', limit: 5 }))[0]?.data).toMatchObject({ outcome: 'ok' })
    expect(session.pendingEffects()).toEqual([])
  })

  it('persists a per-turn section token breakdown alongside the request header', async () => {
    const { session, log } = await primed([textTurn('hello world')])
    await session.runInference()
    const rows = await log.scan({ type: 'x/core/context-breakdown', limit: 5 })
    expect(rows).toHaveLength(1)
    const data = rows[0]?.data as {
      sections: Array<{ id: string; order: number; source: string; tokens: number }>
    }
    expect(data.sections.length).toBeGreaterThan(0)
    expect(data.sections.every((s) => s.tokens >= 0)).toBe(true)
    // The untrusted-envelope rule section is always prepended at order 0 (derive.ts) -- a stable
    // landmark to assert against without pinning every section id.
    expect(data.sections.some((s) => s.id === 'core:untrusted-envelope' && s.order === 0)).toBe(true)
  })

  it('a tool call answer mints ids, records the call and enters the tools phase with the step still open', async () => {
    const { session, log } = await primed([toolTurn('read', { path: 'a' })], readRegistry())
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    const calls = await log.scan({ type: 'tool/call', limit: 10 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.data).toMatchObject({
      name: 'read',
      args: { path: 'a' },
      ordinal: 0,
      resolvedPolicy: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        approvalScopes: [],
        policyVersion: 'static-v1',
      },
      executionDomain: 'workspace',
      definitionFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect((calls[0]?.data as { toolUseId: string } | undefined)?.toolUseId).toMatch(/^t0-/)
    expect(session.op()?.phase).toMatchObject({
      kind: 'tools',
      batch: {
        assistantSeq: calls[0]?.seq ? calls[0].seq - 1 : 0,
        calls: [{ name: 'read', status: 'planned', replay: 'safe', ordinal: 0 }],
      },
    })
    // The batch's argsSeq must point at the tool/call row itself: the tools phase reads the
    // arguments back from there.
    const phase = session.op()?.phase as unknown as { batch: { calls: Array<{ argsSeq: number }> } }
    expect(phase.batch.calls[0]?.argsSeq).toBe(calls[0]?.seq)
    // The step belongs to the tools that follow, so it is not closed here.
    expect(await log.scan({ type: 'step/end', limit: 5 })).toHaveLength(0)
  })

  it('classifies validated args once, persists the policy, and never reclassifies before execution', async () => {
    const classify = vi.fn((args: { action: 'capture' | 'click' }) => ({
      isReadOnly: args.action === 'capture',
      isDestructive: args.action === 'click',
      replay: args.action === 'capture' ? ('safe' as const) : ('never' as const),
      requiresApproval: args.action === 'capture' ? ('never' as const) : ('destructive' as const),
      approvalScopes: args.action === 'capture' ? [] : ['cua:input:background'],
    }))
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'captured' }] }))
    const def: ToolDef = {
      name: 'computer_use',
      description: 'computer use',
      parameters: Type.Object(
        { action: Type.Union([Type.Literal('capture'), Type.Literal('click')]) },
        { additionalProperties: false },
      ),
      meta: {
        isReadOnly: false,
        isDestructive: true,
        isConcurrencySafe: false,
        isOpenWorld: false,
        replay: 'never',
        costHint: undefined,
        deferLoading: undefined,
        requiresApproval: 'destructive',
      },
      policyVersion: 'computer-use-v1',
      classify: classify as NonNullable<ToolDef['classify']>,
      execute,
    }
    const registry = new ToolRegistry()
    registry.add(def, {
      source: 'agnes/computer-use',
      trust: 'builtin',
      packageIdentity: '@agnes/base',
      packageVersion: '1.0.0',
      executionDomain: 'host-computer-use',
    })
    const { session, log, provider } = await primed(
      [toolTurn('computer_use', { action: 'capture' })],
      registry,
      {
        dispatch: async (input) => ({ phase: 'responded', result: await input.invoke() }),
      },
    )
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(classify).toHaveBeenCalledTimes(1)
    const row = (await log.scan({ type: 'tool/call', limit: 1 }))[0]
    expect(row?.data).toMatchObject({
      resolvedPolicy: {
        isReadOnly: true,
        isDestructive: false,
        replay: 'safe',
        requiresApproval: 'never',
        policyVersion: 'computer-use-v1',
      },
      executionDomain: 'host-computer-use',
    })
    def.classify = () => {
      throw new Error('classifier was invoked twice')
    }
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(classify).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid arguments before invoking or persisting a classifier result', async () => {
    const classify = vi.fn(() => ({
      isReadOnly: true,
      isDestructive: false,
      replay: 'safe' as const,
      requiresApproval: 'never' as const,
      approvalScopes: [],
    }))
    const registry = new ToolRegistry()
    registry.add(
      {
        name: 'computer_use',
        description: 'computer use',
        parameters: Type.Object({ action: Type.Literal('capture') }, { additionalProperties: false }),
        meta: {
          isReadOnly: true,
          isDestructive: false,
          isConcurrencySafe: true,
          isOpenWorld: false,
          replay: 'safe',
          costHint: undefined,
          deferLoading: undefined,
          requiresApproval: undefined,
        },
        policyVersion: 'computer-use-v1',
        classify: classify as NonNullable<ToolDef['classify']>,
        execute: async () => ({ content: [] }),
      },
      {
        source: 'agnes/computer-use',
        trust: 'builtin',
        packageIdentity: '@agnes/base',
        packageVersion: '1.0.0',
      },
    )
    const { session, log, provider } = await primed([toolTurn('computer_use', { action: 'click' })], registry)
    Object.assign(provider, { models: () => [primaryModel(['text', 'image'])] })
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    expect(classify).not.toHaveBeenCalled()
    const call = (await log.scan({ type: 'tool/call', limit: 1 }))[0]
    expect(call?.data).not.toHaveProperty('resolvedPolicy')
    const result = (await log.scan({ type: 'tool/result', limit: 1 }))[0]
    expect(result?.data).toMatchObject({ code: 'TOOL_ARGS_INVALID', isError: true })
    expect(session.op()?.phase).toMatchObject({
      kind: 'tools',
      batch: { calls: [{ status: 'completed', replay: 'never' }] },
    })
  })

  it('keeps the registered definition immutable between inference and execution', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }))
    const registry = new ToolRegistry()
    registry.add(readTool(execute), { source: 'agnes/tools-core', trust: 'builtin' })
    const { session, log } = await primed([toolTurn('read', {})], registry)
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    const registered = registry.resolve('read')
    if (!registered) throw new Error('missing tool')
    expect(() => {
      registered.definitionFingerprint = 'f'.repeat(64)
    }).toThrow(TypeError)
    expect(await session.runToolsPhase()).toEqual({ phase: 'checkpoint' })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await log.scan({ type: 'x/core/tool-definition-drift', limit: 5 })).toHaveLength(0)
  })

  it('parks before hooks, approval, or execution when op.state carries a coherently rehashed policy that disagrees with the ledger', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }))
    const registry = new ToolRegistry()
    registry.add(readTool(execute), { source: 'agnes/tools-core', trust: 'builtin' })
    const { session, log } = await primed([toolTurn('read', {})], registry)
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    const op = session.op()
    if (op?.phase.kind !== 'tools') throw new Error('missing tools phase')
    const call = op.phase.batch.calls[0]
    if (!call?.resolvedPolicy) throw new Error('missing persisted policy')
    call.resolvedPolicy = { ...call.resolvedPolicy, replay: 'never' }
    call.policyHash = sha256Hex(canonicalJson(call.resolvedPolicy))
    expect(await session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    expect(execute).not.toHaveBeenCalled()
    expect(await log.scan({ type: 'tool/result', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'approval/asked', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'x/core/tool-policy-binding-refused', limit: 5 })).toHaveLength(1)
  })

  it('parks before execution when the durable tool call is not trusted model output', async () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }))
    const registry = new ToolRegistry()
    registry.add(readTool(execute), { source: 'agnes/tools-core', trust: 'builtin' })
    const { session, log } = await primed([toolTurn('read', {})], registry)
    expect(await session.runInference()).toEqual({ phase: 'tools' })
    const scan = session.d.log.scan.bind(session.d.log)
    vi.spyOn(session.d.log, 'scan').mockImplementation(async (query) =>
      (await scan(query)).map((row) =>
        row.type === 'tool/call' ? { ...row, origin: 'ext:hostile', trust: 'untrusted' as const } : row,
      ),
    )
    expect(await session.runToolsPhase()).toEqual({ phase: 'terminal', reason: 'parked' })
    expect(execute).not.toHaveBeenCalled()
    expect(await log.scan({ type: 'tool/result', limit: 5 })).toHaveLength(0)
  })

  it('sends the growing surface to the model and records one request/header per distinct request', async () => {
    const { session, log, provider } = await primed([textTurn('a'), textTurn('b')])
    await session.runInference()
    await session.runInference()
    const bodies = provider.requests as RequestBody[]
    expect(bodies.map((r) => r.messages.map((m) => m.role))).toEqual([['user'], ['user', 'assistant']])
    expect(bodies[0]?.messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hi' }] })
    expect(bodies[1]?.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'a' }],
    })
    // The wire body carries the flattened frame and the hash the header stamps.
    expect(bodies[0]?.system).toContain('Untrusted content.')
    expect(bodies[0]?.kind).toBe('inference')
    expect(bodies[0]?.sessionKey).toBe('k')
    const headers = (await log.scan({ type: 'request/header', limit: 10 })).map(
      (e) => e.data as RequestHeaderData,
    )
    expect(headers).toHaveLength(2)
    expect(bodies[0]?.derivedHash).toBe(headers[0]?.derived_hash)
    expect(headerEquals(headers[0] as RequestHeaderData, headers[1] as RequestHeaderData)).toBe(false)
    expect(headerEquals(headers[0] as RequestHeaderData, headers[0] as RequestHeaderData)).toBe(true)
    expect(
      (await log.scan({ type: 'step/start', limit: 10 })).map((e) => (e.data as { step: number }).step),
    ).toEqual([1, 2])
    expect(await log.scan({ type: 'step/end', limit: 10 })).toHaveLength(2)
  })

  it('discloses the registered tools to the model as schemas', async () => {
    const { session, provider } = await primed([textTurn('a')], readRegistry())
    await session.runInference()
    expect((provider.requests[0] as RequestBody).tools).toEqual([
      { name: 'read', description: 'read', parameters: { type: 'object', properties: {} } },
    ])
  })

  it('length-truncated output with tool calls discards the calls and feeds the model back', async () => {
    const script: Script = [
      sent(),
      { type: 'toolcall_end', call: { toolUseId: '', name: 'read', args: {}, ordinal: 0 }, via: 'native' },
      usage(),
      { type: 'done', reason: 'length' },
    ]
    const { session, log } = await primed([script], readRegistry())
    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(await log.scan({ type: 'tool/call', limit: 10 })).toHaveLength(0)
    expect(session.op()?.phase).toMatchObject({ kind: 'checkpoint', continuation: 'need_assistant' })
    const notes = (await log.scan({ type: 'user/message', limit: 10 })).filter((e) => e.origin === 'system')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.data).toMatchObject({ kind: 'runtime_context' })
    expect((await log.scan({ type: 'assistant/message', limit: 5 }))[0]?.data).toMatchObject({
      stopReason: 'max_tokens',
    })
  })

  it('a tool call decoded from text records a format deviation', async () => {
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: {}, ordinal: 0 },
        via: 'hermes_tool_call',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const { session, log } = await primed([script], readRegistry())
    await session.runInference()
    expect((await log.scan({ type: 'format/deviation', limit: 5 }))[0]?.data).toMatchObject({
      rule: 'hermes_tool_call',
      parserVersion: '1',
    })
  })

  it('a format deviation also fires the formatDeviation hook, and a failing hook does not stop the ledger row', async () => {
    const script: Script = [
      sent(),
      {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'read', args: {}, ordinal: 0 },
        via: 'hermes_tool_call',
      },
      usage(),
      { type: 'done', reason: 'toolUse' },
    ]
    const { session, log } = await primed([script], readRegistry())
    const seen: unknown[] = []
    session.hooks = {
      ...session.hooks,
      formatDeviation: async (p) => {
        seen.push(p)
        throw new Error('extension exploded')
      },
    }
    await session.runInference()
    expect(seen).toEqual([{ rule: 'hermes_tool_call', model: 'default', sampleHash: expect.any(String) }])
    // The hook threw; the ledger row it sits beside must land anyway.
    expect((await log.scan({ type: 'format/deviation', limit: 5 }))[0]?.data).toMatchObject({
      rule: 'hermes_tool_call',
      parserVersion: '1',
    })
  })

  it('an unparsed deviation feeds back rather than settling the turn', async () => {
    const script: Script = [
      sent(),
      { type: 'text_delta', delta: 'read(a)' },
      { type: 'deviation', rule: 'unparsed', sampleHash: 'c'.repeat(64) },
      usage(),
      { type: 'done', reason: 'stop' },
    ]
    const { session, log } = await primed([script], readRegistry())
    await session.runInference()
    expect(session.op()?.phase).toMatchObject({ kind: 'checkpoint', continuation: 'need_assistant' })
    const notes = (await log.scan({ type: 'user/message', limit: 10 })).filter((e) => e.origin === 'system')
    const note = notes[0]?.data as { content: Array<{ text: string }> } | undefined
    expect(note?.content[0]?.text).toContain('INVALID_TOOL_CALL_FORMAT')
  })

  it('a provider error fires the requestError hook with the real attempt count, before the retry decision', async () => {
    const scripts: Script[] = [
      [sent(), { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow', retryable: true }],
    ]
    const s = await openSession({ provider: fakeProvider(scripts) })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    const seen: unknown[] = []
    s.session.hooks = {
      ...s.session.hooks,
      requestError: async (p) => {
        seen.push(p)
      },
    }
    expect(await s.session.runInference()).toEqual({ phase: 'inference' })
    expect(seen).toEqual([{ code: 'RATE_LIMIT', message: 'slow', attempt: 0, retryable: true }])
  })

  it('retryable error waits and then succeeds; a non-retryable one drains', async () => {
    let now = 1_757_203_200_000
    const scripts: Script[] = [
      [sent(), { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow', retryable: true }],
      textTurn('ok'),
    ]
    const s = await openSession({ provider: fakeProvider(scripts), clock: () => now })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    expect(await s.session.runInference()).toEqual({ phase: 'inference' })
    expect(s.session.op()?.phase).toMatchObject({
      kind: 'inference',
      gen: { status: 'retry_wait', attempt: 1, code: 'RATE_LIMIT' },
    })
    // The interrupted attempt is still billed, and its effect is settled rather than left pending.
    expect((await s.log.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data).toMatchObject({
      interrupted: true,
    })
    expect(s.session.pendingEffects()).toEqual([])
    // Not yet due: the segment refuses to spend a second attempt before notBefore.
    expect(await s.session.runInference()).toEqual({ phase: 'inference' })
    expect(await s.log.scan({ type: 'step/start', limit: 5 })).toHaveLength(1)
    now += 5000
    expect(await s.session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(
      (await s.log.scan({ type: 'step/start', limit: 5 })).map((e) => (e.data as { step: number }).step),
    ).toEqual([1, 2])
    const fatal = await primed([
      [sent(), { type: 'error', reason: 'error', code: 'AUTH', message: 'no', retryable: false }],
    ])
    expect(await fatal.session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(fatal.session.op()?.phase).toMatchObject({
      kind: 'failure_drain',
      error: { code: 'AUTH' },
      provenance: { kind: 'inference' },
    })
  })

  it('a retryable error past maxAttempts drains instead of retrying forever', async () => {
    const err: Script = [
      sent(),
      { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow', retryable: true },
    ]
    let now = 1_757_203_200_000
    const s = await openSession({ provider: fakeProvider([err]), clock: () => now })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    await s.session.runInference()
    now += 10_000
    expect(await s.session.runInference()).toEqual({ phase: 'failure_drain' })
  })

  it('an overflow becomes a compaction only when the port asks for one', async () => {
    const over: Script = [
      sent(),
      { type: 'error', reason: 'error', code: 'OVERFLOW', message: 'too big', retryable: false },
    ]
    const drain = await primed([over])
    expect(await drain.session.runInference()).toEqual({ phase: 'failure_drain' })
    const s = await openSession({ provider: fakeProvider([over]) })
    s.session.compaction = { shouldCompact: () => false, onOverflow: () => 'compaction' }
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    expect(await s.session.runInference()).toEqual({ phase: 'compaction' })
    expect(s.session.op()?.phase).toMatchObject({
      kind: 'compaction',
      reason: 'overflow',
      resumeAfter: { kind: 'checkpoint', continuation: 'need_assistant' },
    })

    const disabled = await openSession({ provider: fakeProvider([over]) })
    disabled.session.compaction = {
      runnable: true,
      shouldCompact: () => false,
      onOverflow: () => 'compaction',
    }
    disabled.session.preset.compaction.enabled = false
    await disabled.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await disabled.session.acceptInput()
    expect(await disabled.session.runInference()).toEqual({ phase: 'failure_drain' })
  })

  it('a blocking beforeStep hook ends the turn without spending an inference', async () => {
    const { session, provider, log } = await primed([textTurn('a')])
    session.hooks = { ...session.hooks, beforeStep: async () => ({ block: true, reason: 'nope' }) }
    expect(await session.runInference()).toEqual({ phase: 'terminal', reason: 'blocked' })
    expect(provider.calls).toBe(0)
    expect((await log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({
      reason: 'blocked',
      error: { code: 'HOOK_BLOCKED', message: 'nope' },
    })
  })

  it('ledger failure marks the turn and the next inference ends the turn with error', async () => {
    const seams = fakeSeams({
      ledger: {
        record: async () => {
          throw new Error('down')
        },
        projected: async () => ({ credits: 0, creditSource: 'estimated' }),
      },
    })
    const s = await openSession({ provider: fakeProvider([textTurn('a'), textTurn('b')]), seams })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    await s.session.runInference()
    expect(await s.log.scan({ type: 'x/core/seam-failed', limit: 5 })).toHaveLength(1)
    expect(await s.session.runInference()).toEqual({ phase: 'terminal', reason: 'error' })
    expect((await s.log.scan({ type: 'turn/end', limit: 5 }))[0]?.data).toMatchObject({
      reason: 'error',
      error: { code: 'LEDGER_FAILED' },
    })
  })

  it('C-17: a rebuilt conversation puts the tool use back beside the assistant message that asked for it', async () => {
    const { session, provider } = await primed(
      [toolTurn('read', { path: 'a' }), textTurn('done')],
      readRegistry(),
    )
    await session.runInference()
    const call = session.op() as unknown as { phase: { batch: { calls: Array<{ toolUseId: string }> } } }
    const toolUseId = call.phase.batch.calls[0]?.toolUseId as string
    // Stand in for the tools phase: the result and the step's close, written the way it writes them.
    await session.append([
      {
        type: 'tool/result',
        origin: 'tool:read',
        trust: 'trusted',
        actor,
        lane: 'main',
        data: {
          toolUseId,
          content: [{ type: 'text', text: 'file body' }],
          isError: false,
          enforcement: { level: 'full', scope: [] },
          authz: { decisionId: 'n/a' },
        },
      },
      {
        type: 'step/end',
        origin: 'system',
        trust: 'trusted',
        actor,
        lane: 'main',
        data: { turn: 1, step: 1 },
      },
    ])
    await session.transition([], {
      ...(session.op() as NonNullable<ReturnType<typeof session.op>>),
      phase: { kind: 'checkpoint', continuation: 'need_assistant', triggerSeq: 4 },
    })
    await session.runInference()
    const second = provider.requests[1] as RequestBody
    const assistant = second.messages.find((m) => m.role === 'assistant')
    expect(assistant).toMatchObject({ toolCalls: [{ toolUseId, name: 'read', args: { path: 'a' } }] })
    // And the result that follows names the same call, so nothing appears out of nowhere.
    expect(second.messages.find((m) => m.role === 'tool_result')).toMatchObject({ toolUseId })
  })

  it('C-21: a turn rehydrated after a kill re-derives the same request rather than a new nonce', async () => {
    const { session, log } = await primed([textTurn('a'), textTurn('b')])
    await session.runInference()
    const before = (await log.scan({ type: 'request/header', limit: 5 }))[0]?.data as RequestHeaderData
    const nonce = session.turn?.nonce
    expect(before.envelopeNonce).toBe(nonce)
    // Simulate the kill: the ledger survives, the in-memory turn does not.
    const op = session.op() as NonNullable<ReturnType<typeof session.op>>
    const readTurn = () => session.turn
    session.turn = null
    await session.rehydrateTurn(op)
    const rebuilt = readTurn() as NonNullable<ReturnType<typeof readTurn>>
    expect(rebuilt.nonce).toBe(nonce)
    expect(rebuilt.lastHeader).toMatchObject({ derived_hash: before.derived_hash })
    expect(rebuilt.lastHeaderSeq).toBe((await log.scan({ type: 'request/header', limit: 5 }))[0]?.seq)
  })
})

describe('Inference segment (fix round 1)', () => {
  it('streams reasoning as its own preview stream, in the order the deltas arrived', async () => {
    const script: Script = [
      sent(),
      { type: 'thinking_delta', delta: 'let me think' },
      { type: 'text_delta', delta: 'the answer' },
      usage(),
      { type: 'done', reason: 'stop' },
    ]
    const { session, log } = await primed([script])
    const seen: Array<{ stream: string; delta: string }> = []
    session.onPreview((p) => seen.push({ stream: p.stream, delta: p.delta }))
    await session.runInference()
    expect(seen.map((p) => p.stream)).toEqual(['thinking', 'text'])
    expect(seen.map((p) => p.delta)).toEqual(['let me think', 'the answer'])
    // The ledger only marks that output started; the text itself is never a row.
    const outputs = (await log.scan({ type: 'assistant/output', limit: 10 })).map((e) => e.data)
    expect(outputs).toEqual([expect.objectContaining({ state: 'started', chars: { text: 0, thinking: 12 } })])
    // The message still carries both blocks, so nothing moved out of the settled row.
    const msg = (await log.scan({ type: 'assistant/message', limit: 5 }))[0]?.data as {
      content: Array<{ type: string }>
    }
    expect(msg.content.map((b) => b.type)).toEqual(['thinking', 'text'])
  })

  it('an interrupted spend is told to the ledger seam, so a failing ledger can still fail closed', async () => {
    const failing: Script[] = [
      [
        sent(),
        { type: 'text_delta', delta: 'half an ' },
        usage(),
        {
          type: 'error',
          reason: 'error',
          code: 'TRANSPORT',
          message: 'socket died',
          retryable: false,
        },
      ],
    ]
    const rows: Array<{ interrupted?: boolean }> = []
    const s = await openSession({
      provider: fakeProvider(failing),
      seams: fakeSeams({
        ledger: {
          record: async (row) => {
            rows.push(row)
            throw new Error('ledger down')
          },
        },
      }),
    })
    await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await s.session.acceptInput()
    expect(await s.session.runInference()).toEqual({ phase: 'failure_drain' })
    // The seam heard about the spend that was interrupted, and its refusal was recorded.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.interrupted).toBe(true)
    expect(s.session.turn?.ledgerFailed).toBe(true)
    expect((await s.log.scan({ type: 'x/core/seam-failed', limit: 5 }))[0]?.data).toMatchObject({
      seam: 'ledger',
      op: 'record',
    })
  })

  it('run() gets through a retry backoff instead of spinning to the bound', async () => {
    const retryable: Script = [
      sent(),
      { type: 'error', reason: 'error', code: 'RATE_LIMIT', message: 'slow down', retryable: true },
    ]
    // A clock that actually moves: the backoff is a wall-clock deadline, and a frozen clock never
    // reaches it however many times the timer fires.
    let now = 1_757_203_200_000
    const { session, log } = await openSession({
      provider: fakeProvider([retryable, textTurn('second time lucky')]),
      timers: immediateTimers,
      clock: () => (now += 400),
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    const out = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(out.reason).toBe('completed')
    // Two attempts, one turn, and no invariant row: the loop waited rather than burning its bound.
    expect(await log.scan({ type: 'step/start', limit: 10 })).toHaveLength(2)
    expect(await log.scan({ type: 'x/core/invariant', limit: 5 })).toHaveLength(0)
  })

  it('a wire tool call carries the ordinal its id was minted from, not an array index', async () => {
    const { session, provider } = await primed(
      [toolTurn('read', { path: 'a' }), toolTurn('read', { path: 'b' }), textTurn('done')],
      readRegistry(),
    )
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    // The third request shows both assistant turns, each with the call it made.
    const last = provider.requests.at(-1) as RequestBody
    const calls = last.messages
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => (m.role === 'assistant' ? (m.toolCalls ?? []) : []))
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.ordinal)).toEqual([0, 1])
    // The ordinal agrees with the one embedded in the id, which is what the pairing is read from.
    for (const c of calls) expect(c.toolUseId).toContain(`t${c.ordinal}`)
  })
})

describe('surfaceToolCalls owner attribution (C-17 producer)', () => {
  it('reads the owning assistant off the ledger, so a masked message drops its calls', async () => {
    const { session } = await primed(
      [toolTurn('read', { path: 'a' }), toolTurn('read', { path: 'b' }), textTurn('done')],
      readRegistry(),
    )
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const assistants = session.surface().filter((n) => n.kind === 'assistant')
    expect(assistants.length).toBeGreaterThanOrEqual(2)
    const middle = assistants[1]?.seq
    const all = session.surface()
    // A summary masking the middle assistant message. Its call has no landing site any more; the
    // producer must drop it rather than hand it to the survivor before it, which is the earlier
    // assistant message that asked for something else entirely.
    session.surface = () => all.filter((n) => n.seq !== middle)
    const calls = [...(await surfaceToolCalls(session))]
    expect(calls.map((c) => c.assistantSeq)).not.toContain(middle)
    expect(calls.every((c) => c.assistantSeq === assistants[0]?.seq)).toBe(true)
    expect(calls).toHaveLength(1)
    // The one that survives is the one the surviving message actually asked for.
    expect(calls[0]?.args).toEqual({ path: 'a' })
  })
})

describe('allowed-session grants (F17)', () => {
  it('an allowed-session grant outlives the turn it was given in', async () => {
    let asks = 0
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          asks++
          return 'allowed-session'
        },
        resume: async () => null,
      },
    })
    const registry = new ToolRegistry()
    registry.add(shellTool(), { source: 's', trust: 'builtin' })
    const { session } = await openSession({
      provider: fakeProvider([
        toolTurn('shell', { command: 'ls' }),
        textTurn('one'),
        toolTurn('shell', { command: 'ls' }),
        textTurn('two'),
      ]),
      registry,
      seams,
    })
    const sig = new AbortController().signal
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'a' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig })).reason).toBe('completed')
    expect(asks).toBe(1)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'b' }], actor })
    expect((await session.run({ until: 'turn-end', signal: sig })).reason).toBe('completed')
    // A second turn asking the same question again would make it an allowed-turn grant.
    expect(asks).toBe(1)
  })
})

/**
 * A model record as the sealed registry publishes it. Only `route`, `id` and `slot` are read here;
 * the rest is filled so the shape is a real record rather than a cast over three fields.
 */
const modelRecord = (route: string, id: string, slot?: NonNullable<ModelRecord['slot']>): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route,
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  ...(slot ? { slot } : {}),
})

/** `fakeProvider`, plus the registry a real provider publishes. */
const providerWithModels = (scripts: Script[], models: ModelRecord[]) => {
  const p = fakeProvider(scripts)
  return Object.assign(p, { models: () => models })
}

const routedSession = async (
  scripts: Script[],
  models: ModelRecord[],
  over: { route?: string; id?: Record<string, string> } = {},
) => {
  const provider = providerWithModels(scripts, models)
  const preset = presetDefaults()
  preset.model.route = { primary: over.route ?? 'ds' }
  if (over.id) preset.model.id = over.id
  const s = await openSession({ provider, preset })
  await s.session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
  await s.session.acceptInput()
  return { ...s, provider }
}

describe('the model id is not the route name (C-23)', () => {
  it('asks the route for the model id that route publishes, on the wire and in the header', async () => {
    const { session, log, provider } = await routedSession(
      [textTurn('ok')],
      [modelRecord('ds', 'deepseek-v3.1')],
    )
    await session.runInference()
    // The two are asserted together on purpose: equal values would let a regression that reuses the
    // route name pass, and a route name of `deepseek-v3.1` is not even expressible in a declared
    // route table (`^[a-z0-9][a-z0-9-]{0,63}$` admits no `.`).
    expect(provider.requests[0]).toMatchObject({ slot: 'primary', route: 'ds', model: 'deepseek-v3.1' })
    const header = (await log.scan({ type: 'request/header', limit: 5 }))[0]
    expect(header?.data).toMatchObject({ model: 'deepseek-v3.1' })
    // The spend is attributed to the model that was billed, not to the endpoint it went through.
    expect((await log.scan({ type: 'cost/ledger', limit: 5 }))[0]?.data).toMatchObject({
      model: 'deepseek-v3.1',
    })
  })

  it("takes the preset's pinned id over the registry, including one no route name could spell", async () => {
    const { session, provider } = await routedSession(
      [textTurn('ok')],
      [modelRecord('ds', 'deepseek-v3.1')],
      {
        id: { primary: 'anthropic/claude-3.5' },
      },
    )
    await session.runInference()
    expect(provider.requests[0]).toMatchObject({
      slot: 'primary',
      route: 'ds',
      model: 'anthropic/claude-3.5',
    })
  })

  it('prefers the record the route declares for this slot over the route’s first', async () => {
    const { session, provider } = await routedSession(
      [textTurn('ok')],
      [modelRecord('ds', 'ds-reasoner', 'verifier'), modelRecord('ds', 'ds-primary', 'primary')],
    )
    await session.runInference()
    expect(provider.requests[0]?.model).toBe('ds-primary')
  })

  it('falls back to the route name only when nothing names a model', async () => {
    const { session, provider } = await routedSession([textTurn('ok')], [])
    await session.runInference()
    expect(provider.requests[0]?.model).toBe('ds')
  })
})

describe('the request precedes what it produced (C-24)', () => {
  it('appends request/header before the first assistant/output, on a text turn and a tool turn', async () => {
    for (const script of [textTurn('hello world'), toolTurn('read', { path: 'a' })]) {
      const { session, log } = await primed([script], readRegistry())
      await session.runInference()
      const header = (await log.scan({ type: 'request/header', limit: 5 }))[0]
      const outputs = await log.scan({ type: 'assistant/output', limit: 5 })
      const message = (await log.scan({ type: 'assistant/message', limit: 5 }))[0]
      expect(header).toBeDefined()
      for (const c of outputs) expect(header?.seq).toBeLessThan(c.seq)
      expect(header?.seq).toBeLessThan(message?.seq ?? 0)
    }
  })

  it('writes the header once per turn even though two rows now try to', async () => {
    const { session, log } = await primed([textTurn('hello world')])
    await session.runInference()
    expect((await log.scan({ type: 'request/header', limit: 20 })).length).toBe(1)
  })

  it('durably appends the header before invoking a provider that throws before sending', async () => {
    let headerCommitted = false
    let headerSeenAtCall = false
    const provider: Provider = {
      models: () => [],
      infer() {
        headerSeenAtCall = headerCommitted
        throw new Error('failed before send')
      },
    }
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const { session, log } = await openSession({ provider, preset })
    const unobserve = log.observeCommitted(['request/header'], () => {
      headerCommitted = true
    })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(headerSeenAtCall).toBe(true)
    expect(await log.scan({ type: 'request/header', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(0)
    unobserve()
  })

  it('records the provider stamp separately and before the first output', async () => {
    const script = textTurn('hello')
    const reported = script[0]
    if (reported?.type !== 'sent') throw new Error('fixture must start with sent')
    const { session, log } = await primed([script])
    await session.runInference()

    const header = (await log.scan({ type: 'request/header', limit: 5 }))[0]
    const receipt = (await log.scan({ type: 'request/sent', limit: 5 }))[0]
    const output = (await log.scan({ type: 'assistant/output', limit: 5 }))[0]
    expect(receipt?.data).toMatchObject({
      ...reported.stamp,
      derived_hash: (header?.data as RequestHeaderData | undefined)?.derived_hash,
      tool_schema_hash: (header?.data as RequestHeaderData | undefined)?.tool_schema_hash,
      model: { route: 'default', id: 'default' },
    })
    expect(header?.data).not.toHaveProperty('sent_hash')
    expect(header?.data).not.toHaveProperty('transforms')
    const intent = (await log.scan({ type: 'effect/intent', limit: 5 }))[0]
    expect(receipt?.sourceEventSeqs).toEqual([header?.seq, intent?.seq])
    expect(header?.seq).toBeLessThan(intent?.seq ?? 0)
    expect(intent?.seq).toBeLessThan(receipt?.seq ?? 0)
    expect(receipt?.seq).toBeLessThan(output?.seq ?? 0)
  })

  it('fails closed when a delta arrives before sent and writes neither receipt nor output', async () => {
    const malformed: InferenceEvent[] = [
      { type: 'text_delta', delta: 'must not escape' },
      sent(),
      usage(),
      { type: 'done', reason: 'stop' },
    ]
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const { session, log } = await openSession({ provider: fakeProvider([malformed]), preset })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(await log.scan({ type: 'request/header', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(0)
  })

  it('fails closed on duplicate sent and persists at most one receipt for the dispatch', async () => {
    const malformed: InferenceEvent[] = [
      sent(),
      sent('duplicate'),
      { type: 'text_delta', delta: 'must not escape' },
      usage(),
      { type: 'done', reason: 'stop' },
    ]
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const { session, log } = await openSession({ provider: fakeProvider([malformed]), preset })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(0)
  })

  it.each([
    ['empty stream', []],
    ['terminal event without sent', [{ type: 'done', reason: 'stop' }]],
  ] satisfies Array<[string, InferenceEvent[]]>)('fails closed on %s', async (_name, script) => {
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const { session, log } = await openSession({ provider: fakeProvider([script]), preset })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(await log.scan({ type: 'request/header', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(0)
  })

  it('keeps a terminal pre-send provider error compatible without fabricating request/sent', async () => {
    const terminal: InferenceEvent = {
      type: 'error',
      reason: 'error',
      code: 'AUTH',
      message: 'credential unavailable',
      retryable: false,
    }
    const { session, log } = await primed([[terminal]])
    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(await log.scan({ type: 'request/header', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(0)
  })

  it.each([
    'derived_hash',
    'tool_schema_hash',
    'parser_version',
    'contract_id',
    'model.id',
    'model.route',
  ] as const)('fails closed before receipt/output when sent stamp %s drifts', async (field) => {
    const provider: Provider = {
      models: () => [],
      async *infer(req) {
        const bad = structuredClone(sentFor(req))
        if (field === 'model.id') bad.stamp.model.id = 'wrong-model'
        else if (field === 'model.route') bad.stamp.model.route = 'wrong-route'
        else if (field === 'contract_id') bad.stamp.contract_id = 'wrong-contract'
        else if (field === 'parser_version') bad.stamp.parser_version = 'wrong-parser'
        else bad.stamp[field] = 'c'.repeat(64)
        yield bad
        yield { type: 'text_delta', delta: 'must not escape' }
        yield usage()
        yield { type: 'done', reason: 'stop' }
      },
    }
    const preset = presetDefaults()
    preset.model.retry = { maxAttempts: 1, baseDelayMs: 1 }
    const { session, log } = await openSession({ provider, preset })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'failure_drain' })
    expect(session.op()?.phase).toMatchObject({
      kind: 'failure_drain',
      error: { code: 'CONTRACT_MISMATCH' },
    })
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(0)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(0)
  })

  it('does not compare provider contract-prefix hash with the header system-prefix hash', async () => {
    const provider: Provider = {
      models: () => [],
      async *infer(req) {
        const reported = structuredClone(sentFor(req))
        reported.stamp.prompt_prefix_hash = 'd'.repeat(64)
        yield reported
        yield { type: 'text_delta', delta: 'ok' }
        yield usage()
        yield { type: 'done', reason: 'stop' }
      },
    }
    const { session, log } = await openSession({ provider })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'hi' }], actor })
    await session.acceptInput()

    expect(await session.runInference()).toEqual({ phase: 'checkpoint' })
    expect(await log.scan({ type: 'request/sent', limit: 5 })).toHaveLength(1)
    expect(await log.scan({ type: 'assistant/output', limit: 5 })).toHaveLength(1)
  })
})

describe('no empty text block leaves the harness (C-25)', () => {
  it('omits the text block when the model streamed no prose before its tool call', async () => {
    const { session, log } = await primed([toolTurn('read', { path: 'a' })], readRegistry())
    await session.runInference()
    const msg = (await log.scan({ type: 'assistant/message', limit: 5 }))[0]
    expect(msg?.data).toMatchObject({ content: [], stopReason: 'tool_use' })
    // Stated as the property rather than as the shape: any block with empty text is the defect,
    // whatever else the content grows to carry.
    const content = (msg?.data as { content?: Array<{ type: string; text: string }> })?.content ?? []
    expect(content.filter((b) => b.text === '')).toEqual([])
  })

  it('still carries the text the model did produce', async () => {
    const { session, log } = await primed([textTurn('hello world')])
    await session.runInference()
    expect((await log.scan({ type: 'assistant/message', limit: 5 }))[0]?.data).toMatchObject({
      content: [{ type: 'text', text: 'hello world' }],
    })
  })
})

it('persists reported request timing and restores the same usage details in UI projection', async () => {
  const { session, log } = await primed([
    [
      sent(),
      { type: 'text_delta', delta: 'ok' },
      {
        type: 'usage',
        tokens: { input: 10, output: 5, cacheRead: 20, cacheWrite: 0, reasoning: 2 },
        credits: 1,
        creditSource: 'estimated',
        timing: { ttftMs: 120, durationMs: 450 },
        billing: { usdMicros: 250, source: 'estimated', subscription: false },
      },
      { type: 'done', reason: 'stop' },
    ],
  ])
  await session.runInference()
  const costs = await log.scan({ type: 'cost/ledger', limit: 10 })
  expect(costs[0]?.data).toMatchObject({ timing: { ttftMs: 120, durationMs: 450 } })
  const timeline = await session.projectUI()
  expect(timeline.nodes.find((node) => node.kind === 'cost')).toMatchObject({
    tokens: { input: 10, output: 5, cacheRead: 20, reasoning: 2 },
    timing: { ttftMs: 120, durationMs: 450 },
    billing: { usdMicros: 250 },
  })
  expect(timeline.usage).toMatchObject({
    reasoningComplete: true,
    billingComplete: true,
    totals: { input: 10, output: 5, reasoning: 2 },
    context: { source: 'estimated' },
  })
})
