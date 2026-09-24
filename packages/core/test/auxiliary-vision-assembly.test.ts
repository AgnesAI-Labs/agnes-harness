import type { InferenceEvent, ModelRecord, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import {
  type AuxiliaryVisionAssemblyInput,
  type AuxiliaryVisionProductionAdmission,
  auxiliaryVisionAvailableForSession,
  mintAuxiliaryVisionProductionAdmission,
  runAuxiliaryVisionAssembly,
} from '../src/orchestrator/auxiliary-vision-assembly.js'
import { prepareRequestMediaFromSurface } from '../src/orchestrator/request-media-surface.js'
import { sha256Hex } from '../src/request/hash.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Event } from '../src/types.js'
import { fakeProvider, sent, sentFor, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'
import { toolCallLookup } from './helpers/request-media-lookup.js'

const jpeg = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 8, 0, 8, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff,
  0xd9,
])
const oversizedJpeg = Uint8Array.from(jpeg)
oversizedJpeg[7] = 0
oversizedJpeg[8] = 1
oversizedJpeg[9] = 0x05
oversizedJpeg[10] = 0xb1
const model = (id = 'vision'): ModelRecord => ({
  id,
  name: id,
  api: 'openai-completions',
  route: 'aux',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
  slot: 'image',
})

const mediaLimits = {
  maxManifestEntries: 4,
  maxSelectedImages: 2,
  maxSelectedBlocks: 4,
  maxBytesPerImage: 1024,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 1024,
  maxSelectedBytes: 2048,
  maxSelectedPixels: 2048,
}
const surfaceLimits = {
  maxLedgerEvents: 8,
  maxSurfaceNodes: 8,
  maxContentBlocks: 8,
  maxManifestEntries: 4,
  maxCandidateBytes: 2048,
  maxCandidatePixels: 2048,
}
const imageLimits = {
  maxSelectedImages: 2,
  maxBytesPerImage: 1024,
  maxDimensionPerImage: 1456,
  maxPixelsPerImage: 1024,
  maxSelectedBytes: 2048,
  maxSelectedPixels: 2048,
}
const productionAdmission = mintAuxiliaryVisionProductionAdmission()

async function media(
  sessionKey: string,
  imageBytes: Uint8Array = jpeg,
  limits: typeof mediaLimits = mediaLimits,
) {
  const digest = sha256Hex(imageBytes)
  const call = {
    seq: 1,
    ts: '2026-09-17T00:00:00.000Z',
    id: '00000000000000000000000001',
    type: 'tool/call',
    data: { toolUseId: 'call-1', name: 'computer_use', args: {}, ordinal: 0 },
    actor,
    origin: 'model',
    trust: 'trusted',
    lane: 'main',
    v: 1,
  } as Event
  const result = {
    seq: 2,
    ts: call.ts,
    id: '00000000000000000000000002',
    type: 'tool/result',
    data: {
      toolUseId: 'call-1',
      content: [
        { type: 'text', text: '1: Save button' },
        { type: 'resource_link', uri: `artifact://${digest}`, name: 'image', mimeType: 'image/jpeg' },
      ],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
    actor,
    origin: 'tool:computer_use',
    trust: 'untrusted',
    lane: 'main',
    v: 1,
    sourceEventSeqs: [1],
  } as Event
  return prepareRequestMediaFromSurface({
    sessionKey,
    lane: 'main',
    signal: new AbortController().signal,
    surface: [{ seq: 2, kind: 'tool_result', event: result, pinned: false }],
    lookupToolCalls: toolCallLookup([call, result]),
    readArtifact: () => imageBytes,
    surfaceLimits,
    mediaLimits: limits,
    mainModelInput: ['text'],
    auxiliaryVisionAvailable: true,
  })
}

function setup(
  provider: Provider,
  key: string,
  treeBudgetCredits: number | null = 10,
  contractForModel?: () => { contract_id: string | null; parser_version: string },
) {
  const storage = new MemoryStorage()
  const preset = presetDefaults()
  const kernel = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    ...(contractForModel ? { contractForModel } : {}),
    preset: {
      ...preset,
      treeBudgetCredits,
      model: {
        ...preset.model,
        route: { ...preset.model.route, image: 'aux' },
        id: { ...preset.model.id, image: 'vision' },
      },
    },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  return {
    kernel,
    storage,
    session: kernel.session(key, { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }),
  }
}

async function run(
  session: Awaited<ReturnType<Kernel['session']>>,
  effectId: string,
  signal: AbortSignal = session.ac.signal,
  timeoutMs = { firstToken: 5_000, total: 30_000 },
  admission: AuxiliaryVisionProductionAdmission | null = productionAdmission,
  overrides: Readonly<{
    imageBytes?: Uint8Array
    mediaLimits?: typeof mediaLimits
    imageLimits?: typeof imageLimits
    transformImage?: NonNullable<AuxiliaryVisionAssemblyInput['transformImage']>
  }> = {},
) {
  if (!session.turn) {
    await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'inspect image' }] })
    if (!(await session.acceptInput())) throw new Error('failed to open test turn')
  }
  return runAuxiliaryVisionAssembly({
    session,
    media: await media(session.key, overrides.imageBytes, overrides.mediaLimits),
    ...(admission === null ? {} : { productionAdmission: admission }),
    effectId,
    axSomText: '1: Save button',
    timeoutMs,
    imageLimits: overrides.imageLimits ?? imageLimits,
    maxOutputTokens: 128,
    signal,
    ...(overrides.transformImage ? { transformImage: overrides.transformImage } : {}),
  })
}

function delayedProvider(
  script: readonly Readonly<{ afterMs: number; event: InferenceEvent }>[],
  onReturn: () => void,
): Provider & { calls: number } {
  const provider: Provider & { calls: number } = {
    calls: 0,
    models: () => [model()],
    count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
    infer(request: RequestBody): AsyncIterable<InferenceEvent> {
      provider.calls++
      const hostileSyncReturn = {
        [Symbol.asyncIterator]() {
          let index = 0
          return {
            next(): Promise<IteratorResult<InferenceEvent>> {
              const item = script[index++]
              if (!item) return new Promise(() => undefined)
              return new Promise((resolve) => {
                setTimeout(() => {
                  resolve({
                    done: false,
                    value: item.event.type === 'sent' ? sentFor(request, item.event) : item.event,
                  })
                }, item.afterMs)
              })
            },
            return(): IteratorResult<InferenceEvent> {
              onReturn()
              return { done: true, value: undefined }
            },
          }
        },
      }
      return hostileSyncReturn as unknown as AsyncIterable<InferenceEvent>
    },
  }
  return provider
}

describe('auxiliary vision production assembly', () => {
  it('uses the catalogue image slot, persists replay-never media cost, and never redispatches', async () => {
    const provider = fakeProvider([
      [
        sent('vision'),
        { type: 'text_delta', delta: 'Save is visible' },
        usage(),
        { type: 'done', reason: 'stop' },
      ],
    ])
    Object.assign(provider, {
      models: () => [model()],
      count: async (request: { derivedHash: string }) => ({
        tokens: 32,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const { kernel, session: pending } = setup(provider, 'assembly-success')
    const session = await pending
    const first = await run(session, 'aux:turn-1')
    expect(first).toMatchObject({ ok: true, text: 'Save is visible' })
    expect(first.untrustedDerivedText).toContain('[untrusted auxiliary vision analysis]')
    expect(first.untrustedDerivedText).not.toContain(jpeg.toString())
    expect(provider.calls).toBe(1)
    expect(provider.requests[0]).toMatchObject({ slot: 'image', route: 'aux', model: 'vision', tools: [] })
    expect(provider.requests[0]?.messages[0]?.content.map((block) => block.type)).toEqual([
      'text',
      'text',
      'image',
    ])

    const rows = await session.scan({ toSeq: session.lastSeq, lane: session.lane })
    expect(rows.find((row) => row.type === 'effect/intent')?.data).toMatchObject({
      effectId: 'aux:turn-1',
      kind: 'media',
      replay: 'never',
    })
    expect(rows.find((row) => row.type === 'cost/ledger')?.data).toMatchObject({
      purpose: 'media',
      model: 'vision',
      credits: 1,
    })
    await expect(run(session, 'aux:turn-1')).resolves.toMatchObject({
      ok: true,
      text: 'Save is visible',
    })
    expect(provider.calls).toBe(1)
    await kernel.close()
  })

  it('settles a thrown credential-bearing provider failure as unknown without leaking it', async () => {
    let calls = 0
    const provider: Provider = {
      models: () => [model()],
      count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
      infer(): AsyncIterable<InferenceEvent> {
        calls++
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                throw new Error('Authorization: Bearer sk-secret-value')
              },
            }
          },
        }
      },
    }
    const { kernel, session: pending } = setup(provider, 'assembly-unknown')
    const session = await pending
    await expect(run(session, 'aux:unknown')).resolves.toMatchObject({
      ok: false,
      code: 'vision_unavailable',
    })
    const rows = await session.scan({ toSeq: session.lastSeq, lane: session.lane })
    expect(JSON.stringify(rows)).not.toContain('sk-secret-value')
    expect(rows.find((row) => row.type === 'effect/settled')?.data).toMatchObject({
      effectId: 'aux:unknown',
      outcome: 'unknown',
    })
    expect(rows.some((row) => row.type === 'cost/ledger')).toBe(false)
    await expect(run(session, 'aux:unknown')).resolves.toMatchObject({ ok: false })
    expect(calls).toBe(1)
    await kernel.close()
  })

  it('releases a provider-declared pre-send failure and writes no media cost', async () => {
    const provider = fakeProvider([
      [
        {
          type: 'error',
          reason: 'error',
          code: 'AUTH',
          message: 'provider unavailable',
          retryable: false,
        },
      ],
    ])
    Object.assign(provider, {
      models: () => [model()],
      count: async (request: { derivedHash: string }) => ({
        tokens: 32,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const { kernel, storage, session: pending } = setup(provider, 'assembly-not-sent')
    const release = vi.spyOn(storage, 'releaseReservation')
    const session = await pending
    await expect(run(session, 'aux:not-sent')).resolves.toMatchObject({ ok: false })
    expect(release).toHaveBeenCalledOnce()
    const rows = await session.scan({ toSeq: session.lastSeq, lane: session.lane })
    expect(rows.some((row) => row.type === 'cost/ledger')).toBe(false)
    expect(rows.find((row) => row.type === 'x/core/auxiliary-vision-terminal')?.data).toMatchObject({
      terminal: { kind: 'no_spend', reason: 'driver_not_sent' },
    })
    await kernel.close()
  })

  it('does not dispatch without a reliable image count or with a foreign cancellation scope', async () => {
    const provider = fakeProvider([])
    Object.assign(provider, { models: () => [model()] })
    const { kernel, session: pending } = setup(provider, 'assembly-count')
    const session = await pending
    await expect(run(session, 'aux:no-count')).resolves.toMatchObject({ ok: false })
    expect(provider.calls).toBe(0)
    const rows = await session.scan({ toSeq: session.lastSeq, lane: session.lane })
    expect(rows.some((row) => row.type === 'effect/intent')).toBe(false)
    await expect(run(session, 'aux:foreign', new AbortController().signal)).rejects.toThrow(
      'owning session cancellation signal',
    )
    const proxyTrap = vi.fn(() => {
      throw new Error('Bearer sk-signal-proxy-secret')
    })
    const hostileSignal = new Proxy(Object.create(null), { getPrototypeOf: proxyTrap })
    await expect(run(session, 'aux:foreign-proxy', hostileSignal as never)).rejects.toThrow(
      'owning session cancellation signal',
    )
    expect(proxyTrap).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    await kernel.close()
  })

  it('keeps the P0 production admission gate closed unless explicitly admitted', async () => {
    const provider = fakeProvider([])
    Object.assign(provider, {
      models: () => [model()],
      count: async (request: { derivedHash: string }) => ({
        tokens: 32,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const { kernel, session: pending } = setup(provider, 'assembly-p0')
    const session = await pending
    await expect(
      run(session, 'aux:p0', session.ac.signal, { firstToken: 5_000, total: 30_000 }, null),
    ).resolves.toMatchObject({ ok: false, code: 'vision_unavailable' })
    expect(auxiliaryVisionAvailableForSession(session)).toBe(false)
    expect(auxiliaryVisionAvailableForSession(session, {} as never)).toBe(false)
    expect(auxiliaryVisionAvailableForSession(session, productionAdmission)).toBe(true)
    expect(provider.calls).toBe(0)
    expect(await session.scan({ toSeq: session.lastSeq, lane: session.lane })).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'effect/intent' })]),
    )
    await kernel.close()
  })

  it('does not evaluate provider count or contract accessors and rejects proxied contract facts', async () => {
    const countGetter = vi.fn(() => {
      throw new Error('Bearer sk-count-getter-secret')
    })
    const provider = fakeProvider([]) as Provider
    Object.assign(provider, { models: () => [model()] })
    Object.defineProperty(provider, 'count', { enumerable: true, get: countGetter })
    const first = setup(provider, 'assembly-count-accessor')
    const firstSession = await first.session
    await expect(run(firstSession, 'aux:count-accessor')).resolves.toMatchObject({ ok: false })
    expect(countGetter).not.toHaveBeenCalled()
    expect(
      JSON.stringify(await firstSession.scan({ toSeq: firstSession.lastSeq, lane: firstSession.lane })),
    ).not.toContain('sk-count-getter-secret')
    await first.kernel.close()

    const parserGetter = vi.fn(() => '1')
    const rawContract = Object.defineProperty(Object.create(null), 'contract_id', {
      enumerable: true,
      value: null,
    })
    Object.defineProperty(rawContract, 'parser_version', { enumerable: true, get: parserGetter })
    const secondProvider = fakeProvider([])
    Object.assign(secondProvider, { models: () => [model()] })
    const second = setup(
      secondProvider,
      'assembly-contract-accessor',
      10,
      () => new Proxy(rawContract, {}) as never,
    )
    const secondSession = await second.session
    await expect(run(secondSession, 'aux:contract-accessor')).resolves.toMatchObject({ ok: false })
    expect(parserGetter).not.toHaveBeenCalled()
    expect(secondProvider.calls).toBe(0)
    await second.kernel.close()
  })

  it('rejects accessor-backed count results without evaluating them', async () => {
    const tokensGetter = vi.fn(() => 32)
    const provider = fakeProvider([])
    Object.assign(provider, {
      models: () => [model()],
      count: async () => {
        const value = { source: 'provider', boundHash: 'a'.repeat(64) }
        return Object.defineProperty(value, 'tokens', { enumerable: true, get: tokensGetter })
      },
    })
    const { kernel, session: pending } = setup(provider, 'assembly-count-result-accessor')
    const session = await pending
    await expect(run(session, 'aux:count-result-accessor')).resolves.toMatchObject({ ok: false })
    expect(tokensGetter).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    await kernel.close()
  })

  it('turns credential and hostile Proxy image-transform failures into a fixed fallback', async () => {
    const provider = fakeProvider([])
    const count = vi.fn(async (request: RequestBody) => ({
      tokens: 32,
      source: 'provider' as const,
      boundHash: request.derivedHash,
    }))
    Object.assign(provider, { models: () => [model()], count })
    const { kernel, session: pending } = setup(provider, 'assembly-transform-failure')
    const session = await pending
    const largerMediaLimits = {
      ...mediaLimits,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 2_000,
      maxSelectedPixels: 2_000,
    }
    const largerImageLimits = {
      ...imageLimits,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 2_000,
      maxSelectedPixels: 2_000,
    }
    const proxyTrap = vi.fn(() => {
      throw new Error('Bearer sk-proxy-trap-secret')
    })
    const failures: unknown[] = [
      new Error('Authorization: Bearer sk-transform-secret'),
      new Proxy(Object.create(null), { getPrototypeOf: proxyTrap }),
    ]
    for (const [index, thrown] of failures.entries()) {
      const outcome = await run(
        session,
        `aux:transform-${index}`,
        session.ac.signal,
        { firstToken: 5_000, total: 30_000 },
        productionAdmission,
        {
          imageBytes: oversizedJpeg,
          mediaLimits: largerMediaLimits,
          imageLimits: largerImageLimits,
          transformImage: async () => {
            throw thrown
          },
        },
      )
      expect(outcome).toMatchObject({ ok: false, code: 'vision_unavailable' })
    }
    expect(proxyTrap).not.toHaveBeenCalled()
    expect(count).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    const rows = JSON.stringify(await session.scan({ toSeq: session.lastSeq, lane: session.lane }))
    expect(rows).not.toContain('sk-transform-secret')
    expect(rows).not.toContain('sk-proxy-trap-secret')
    await kernel.close()
  })

  it('rejects a 33-character parser version before count or inference dispatch', async () => {
    const provider = fakeProvider([])
    const count = vi.fn(async (request: RequestBody) => ({
      tokens: 32,
      source: 'provider' as const,
      boundHash: request.derivedHash,
    }))
    Object.assign(provider, { models: () => [model()], count })
    const { kernel, session: pending } = setup(provider, 'assembly-parser-limit', 10, () => ({
      contract_id: null,
      parser_version: 'x'.repeat(33),
    }))
    const session = await pending
    await expect(run(session, 'aux:parser-limit')).resolves.toMatchObject({
      ok: false,
      code: 'vision_unavailable',
    })
    expect(count).not.toHaveBeenCalled()
    expect(provider.calls).toBe(0)
    await kernel.close()
  })

  it('fails closed on an ambiguous catalogue instead of accepting caller-selected capability', async () => {
    const provider = fakeProvider([])
    Object.assign(provider, {
      models: () => [model(), model()],
      count: async (request: { derivedHash: string }) => ({
        tokens: 32,
        source: 'provider' as const,
        boundHash: request.derivedHash,
      }),
    })
    const { kernel, session: pending } = setup(provider, 'assembly-model')
    const session = await pending
    await expect(run(session, 'aux:ambiguous')).resolves.toMatchObject({ ok: false })
    expect(provider.calls).toBe(0)
    await kernel.close()
  })

  it('enforces the absolute first-token deadline and cleans up a synchronous iterator return', async () => {
    vi.useFakeTimers()
    const returned = vi.fn()
    const provider = delayedProvider([{ afterMs: 100, event: sent('vision') }], returned)
    const { kernel, session: pending } = setup(provider, 'assembly-first-token')
    try {
      const session = await pending
      const outcome = run(session, 'aux:first', session.ac.signal, {
        firstToken: 1_000,
        total: 5_000,
      })
      const checked = expect(outcome).resolves.toMatchObject({
        ok: false,
        code: 'vision_unavailable',
      })
      await vi.advanceTimersByTimeAsync(1_001)
      await checked
      expect(returned).toHaveBeenCalledOnce()
      const rows = await session.scan({ toSeq: session.lastSeq, lane: session.lane })
      expect(rows.find((row) => row.type === 'effect/settled')?.data).toMatchObject({
        outcome: 'unknown',
      })
    } finally {
      vi.useRealTimers()
      await kernel.close()
    }
  })

  it('uses one wall-clock total deadline rather than resetting it for every stream event', async () => {
    vi.useFakeTimers()
    const returned = vi.fn()
    const provider = delayedProvider(
      [
        { afterMs: 400, event: sent('vision') },
        { afterMs: 400, event: { type: 'text_delta', delta: 'partial' } },
        { afterMs: 400, event: usage() },
      ],
      returned,
    )
    const { kernel, session: pending } = setup(provider, 'assembly-total')
    try {
      const session = await pending
      const outcome = run(session, 'aux:total', session.ac.signal, {
        firstToken: 1_000,
        total: 1_000,
      })
      const checked = expect(outcome).resolves.toMatchObject({
        ok: false,
        code: 'vision_unavailable',
      })
      await vi.advanceTimersByTimeAsync(1_001)
      await checked
      expect(returned).toHaveBeenCalledOnce()
      expect(provider.calls).toBe(1)
    } finally {
      vi.useRealTimers()
      await kernel.close()
    }
  })

  it('starts the total deadline before synchronous provider stream setup', async () => {
    vi.useFakeTimers()
    const next = vi.fn(async () => ({ done: false as const, value: sent('vision') }))
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const provider: Provider = {
      models: () => [model()],
      count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
      infer(): AsyncIterable<InferenceEvent> {
        vi.advanceTimersByTime(1_001)
        return {
          [Symbol.asyncIterator]() {
            return { next, return: returned }
          },
        }
      },
    }
    const { kernel, session: pending } = setup(provider, 'assembly-sync-setup-deadline')
    try {
      const session = await pending
      await expect(
        run(session, 'aux:sync-setup', session.ac.signal, { firstToken: 1_000, total: 1_000 }),
      ).resolves.toMatchObject({ ok: false, code: 'vision_unavailable' })
      expect(next).not.toHaveBeenCalled()
      expect(returned).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await kernel.close()
    }
  })

  it('rechecks the first-output deadline after a synchronous iterator.next call', async () => {
    vi.useFakeTimers()
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    let calls = 0
    const provider: Provider = {
      models: () => [model()],
      count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
      infer(request): AsyncIterable<InferenceEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                calls++
                if (calls === 1)
                  return Promise.resolve({ done: false as const, value: sentFor(request, sent('vision')) })
                vi.advanceTimersByTime(1_001)
                return Promise.resolve({
                  done: false as const,
                  value: { type: 'text_delta' as const, delta: 'too late' },
                })
              },
              return: returned,
            }
          },
        }
      },
    }
    const { kernel, session: pending } = setup(provider, 'assembly-sync-first-next')
    try {
      const session = await pending
      await expect(
        run(session, 'aux:sync-first-next', session.ac.signal, { firstToken: 1_000, total: 5_000 }),
      ).resolves.toMatchObject({ ok: false, code: 'vision_unavailable' })
      expect(calls).toBe(2)
      expect(returned).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await kernel.close()
    }
  })

  it('rechecks the total deadline before accepting a synchronous done event', async () => {
    vi.useFakeTimers()
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    let calls = 0
    const provider: Provider = {
      models: () => [model()],
      count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
      infer(request): AsyncIterable<InferenceEvent> {
        const beforeTerminal: InferenceEvent[] = [
          sentFor(request, sent('vision')),
          { type: 'text_delta', delta: 'on time' },
          usage(),
        ]
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                calls++
                const value = beforeTerminal.shift()
                if (value) return Promise.resolve({ done: false as const, value })
                vi.advanceTimersByTime(1_001)
                return Promise.resolve({
                  done: false as const,
                  value: { type: 'done' as const, reason: 'stop' as const },
                })
              },
              return: returned,
            }
          },
        }
      },
    }
    const { kernel, session: pending } = setup(provider, 'assembly-sync-done-next')
    try {
      const session = await pending
      await expect(
        run(session, 'aux:sync-done-next', session.ac.signal, { firstToken: 1_000, total: 1_000 }),
      ).resolves.toMatchObject({ ok: false, code: 'vision_unavailable' })
      expect(calls).toBe(4)
      expect(returned).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
      await kernel.close()
    }
  })

  it('finishes on a valid done event without waiting for stream EOF', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }))
    const provider: Provider = {
      models: () => [model()],
      count: async (request) => ({ tokens: 32, source: 'provider', boundHash: request.derivedHash }),
      infer(request): AsyncIterable<InferenceEvent> {
        const events: InferenceEvent[] = [
          sentFor(request, sent('vision')),
          { type: 'text_delta', delta: 'terminal answer' },
          usage(),
          { type: 'done', reason: 'stop' },
        ]
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                const value = events.shift()
                return value
                  ? Promise.resolve({ done: false as const, value })
                  : new Promise<IteratorResult<InferenceEvent>>(() => undefined)
              },
              return: returned,
            }
          },
        }
      },
    }
    const { kernel, session: pending } = setup(provider, 'assembly-done-terminal')
    const session = await pending
    try {
      const outcome = await Promise.race([
        run(session, 'aux:done-terminal'),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 250)),
      ])
      expect(outcome).not.toBe('hung')
      expect(outcome).toMatchObject({ ok: true, text: 'terminal answer' })
      expect(returned).toHaveBeenCalledOnce()
    } finally {
      await kernel.close()
    }
  })
})
