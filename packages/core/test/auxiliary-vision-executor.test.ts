import { deflateSync } from 'node:zlib'
import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { prepareAuxiliaryVisionPlan } from '../src/orchestrator/auxiliary-vision.js'
import {
  type AuxiliaryVisionEffectPort,
  type AuxiliaryVisionEffectTerminal,
  AuxiliaryVisionExecutionError,
  authorizeAuxiliaryVisionExecution,
  consumeAuxiliaryVisionExecutorFallbackAuthority,
  executeAuxiliaryVision,
} from '../src/orchestrator/auxiliary-vision-executor.js'
import { prepareRequestMediaFromSurface } from '../src/orchestrator/request-media-surface.js'
import type { SurfaceNode } from '../src/project/surface.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Event, Seq } from '../src/types.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'
import { toolCallLookup } from './helpers/request-media-lookup.js'

const tokens = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 }
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
const model = (): ModelRecord => ({
  id: 'vision',
  name: 'vision',
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
})

function setup(treeBudgetCredits: number | null = 10) {
  const storage = new MemoryStorage()
  const provider = fakeProvider([])
  Object.assign(provider, { models: () => [model()] })
  const kernel = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  return { kernel, storage }
}

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
function png(): Uint8Array {
  return Uint8Array.from([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...chunk('IHDR', [...u32(16), ...u32(16), 1, 0, 0, 0, 0]),
    ...chunk('IDAT', [...deflateSync(new Uint8Array(48))]),
    ...chunk('IEND', []),
  ])
}

async function plan(sessionKey: string) {
  const bytes = png()
  const digest = sha256Hex(bytes)
  const call = {
    seq: 1,
    ts: '2026-09-17T00:00:00.000Z',
    id: '00000000000000000000000001',
    type: 'tool/call',
    data: { toolUseId: 't', name: 'computer_use', args: {}, ordinal: 0 },
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
    origin: 'tool:computer_use',
    sourceEventSeqs: [1],
    data: {
      toolUseId: 't',
      content: [{ type: 'resource_link', uri: `artifact://${digest}`, name: 'image', mimeType: 'image/png' }],
      isError: false,
      enforcement: { level: 'full', scope: [] },
      authz: { decisionId: 'n/a' },
    },
  } as Event
  const media = await prepareRequestMediaFromSurface({
    sessionKey,
    lane: 'main',
    signal: new AbortController().signal,
    surface: [{ seq: 2, kind: 'tool_result', event: result, pinned: false }] as SurfaceNode[],
    lookupToolCalls: toolCallLookup([call, result]),
    readArtifact: () => bytes,
    mainModelInput: ['text'],
    auxiliaryVisionAvailable: true,
    surfaceLimits: {
      maxLedgerEvents: 8,
      maxSurfaceNodes: 4,
      maxContentBlocks: 4,
      maxManifestEntries: 4,
      maxCandidateBytes: 1_048_576,
      maxCandidatePixels: 4_000_000,
    },
    mediaLimits: {
      maxManifestEntries: 4,
      maxSelectedImages: 3,
      maxSelectedBlocks: 6,
      maxBytesPerImage: 1_048_576,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 4_000_000,
      maxSelectedBytes: 1_048_576,
      maxSelectedPixels: 4_000_000,
    },
  })
  return prepareAuxiliaryVisionPlan({
    sessionKey,
    lane: 'main',
    media,
    target: { id: 'vision', route: 'aux', slot: 'image', input: ['text', 'image'], contract_id: null },
    axSomText: '1: Save',
    timeoutMs: { firstToken: 5_000, total: 30_000 },
    imageLimits: {
      maxSelectedImages: 3,
      maxBytesPerImage: 1_048_576,
      maxDimensionPerImage: 1456,
      maxPixelsPerImage: 4_000_000,
      maxSelectedBytes: 1_048_576,
      maxSelectedPixels: 4_000_000,
    },
    maxOutputTokens: 128,
    signal: new AbortController().signal,
  })
}

function finished(
  terminal: AuxiliaryVisionEffectTerminal,
  binding: { auditBindingHash: string; budgetBindingHash: string; requestDerivedHash: string },
) {
  return {
    status: 'finished',
    terminal,
    receipt: {
      terminalSeq: 5 as Seq,
      auditBindingHash: binding.auditBindingHash,
      budgetBindingHash: binding.budgetBindingHash,
      requestDerivedHash: binding.requestDerivedHash,
      terminalHash: sha256Hex(canonicalJson(terminal)),
      ...(terminal.kind === 'known_spend' ? { costOriginSeq: 6 as Seq } : {}),
    },
  } as const
}
function effects(
  order: string[],
  phase: 'admitted' | 'in_progress' | AuxiliaryVisionEffectTerminal = 'admitted',
): AuxiliaryVisionEffectPort {
  return {
    begin: vi.fn(async (binding) => {
      order.push('intent')
      if (phase === 'admitted') return { status: 'admitted', intentSeq: 4 as Seq } as const
      if (phase === 'in_progress') return { status: 'in_progress' } as const
      return finished(phase, binding)
    }),
    finish: vi.fn(async (_binding, terminal) => {
      order.push(`finish:${terminal.kind}`)
      return finished(terminal, _binding)
    }),
  }
}
async function authority(sessionKey: string, effectId: string, projectedCredits = 1, inputTokens = 1) {
  return authorizeAuxiliaryVisionExecution({
    plan: await plan(sessionKey),
    effectId,
    projectedCredits,
    inputTokens,
  })
}

describe('auxiliary vision executor', () => {
  it('orders intent, one dispatch, durable media cost and gateway tree settlement', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('success', sessionOpts)
    const settle = vi.spyOn(storage, 'settleOrigin')
    const order: string[] = []
    const effectPort = effects(order)
    const driver = {
      dispatch: vi.fn(async () => {
        order.push('dispatch')
        return {
          status: 'completed',
          text: 'Save is visible',
          usage: { tokens, credits: 0.25, creditSource: 'gateway' },
        } as const
      }),
    }
    const auth = await authority(session.key, 'aux:success', 1, 11)
    const result = await executeAuxiliaryVision({
      session,
      authority: auth,
      signal: new AbortController().signal,
      effects: effectPort,
      driver,
    })
    expect(order).toEqual(['intent', 'dispatch', 'finish:known_spend'])
    expect(result).toMatchObject({ ok: true, text: 'Save is visible' })
    expect(result.untrustedDerivedText).toContain('1: Save')
    expect(settle.mock.calls[0]?.[0]).toMatchObject({
      actualMicro: 250_000n,
      complete: true,
      creditSource: 'gateway',
    })
    const terminal = vi.mocked(effectPort.finish).mock.calls[0]?.[1]
    if (!terminal) throw new Error('missing terminal')
    expect(Object.isFrozen(terminal)).toBe(true)
    if (terminal.kind !== 'known_spend') throw new Error('expected known terminal')
    expect(Object.isFrozen(terminal.tokens)).toBe(true)
    expect(terminal.tokens).not.toBe(tokens)
    await expect(
      executeAuxiliaryVision({
        session,
        authority: auth,
        signal: new AbortController().signal,
        effects: effects([], terminal),
        driver,
      }),
    ).resolves.toMatchObject({ ok: true, text: 'Save is visible' })
    expect(driver.dispatch).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledOnce()
    const contradictory: AuxiliaryVisionEffectTerminal = {
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model: 'vision',
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_outcome_unknown',
    }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: auth,
        signal: new AbortController().signal,
        effects: effects([], contradictory),
        driver,
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    expect(driver.dispatch).toHaveBeenCalledOnce()
    await kernel.close()
  })

  it('releases proven not-sent without a cost row', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('not-sent', sessionOpts)
    const release = vi.spyOn(storage, 'releaseReservation')
    const effectPort = effects([])
    const auth = await authority(session.key, 'aux:not-sent')
    const driver = { dispatch: vi.fn(async () => ({ status: 'failed', dispatch: 'not_sent' }) as const) }
    await executeAuxiliaryVision({
      session,
      authority: auth,
      signal: new AbortController().signal,
      effects: effectPort,
      driver,
    })
    expect(release).toHaveBeenCalledOnce()
    expect(effectPort.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'no_spend' }),
    )
    const terminal = vi.mocked(effectPort.finish).mock.calls[0]?.[1]
    if (!terminal) throw new Error('missing terminal')
    await executeAuxiliaryVision({
      session,
      authority: auth,
      signal: new AbortController().signal,
      effects: effects([], terminal),
      driver,
    })
    expect(driver.dispatch).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    await kernel.close()
  })

  it('treats contradictory not-sent usage as unknown and never releases the hold', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('not-sent-usage', sessionOpts)
    const release = vi.spyOn(storage, 'releaseReservation')
    const settle = vi.spyOn(storage, 'settleOrigin')
    const effectPort = effects([])
    await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:not-sent-usage'),
      signal: new AbortController().signal,
      effects: effectPort,
      driver: {
        dispatch: async () => ({
          status: 'failed',
          dispatch: 'not_sent',
          usage: { tokens, credits: 0.1, creditSource: 'gateway' },
        }),
      },
    })
    expect(release).not.toHaveBeenCalled()
    expect(effectPort.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'unknown_spend', reason: 'driver_contract_invalid' }),
    )
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ actualMicro: null, complete: false })
    await kernel.close()
  })

  it('does not redispatch in-progress work and redacts a raw thrown secret as unknown', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('unknown', sessionOpts)
    const driver = { dispatch: vi.fn() }
    const inProgress = await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:progress'),
      signal: new AbortController().signal,
      effects: effects([], 'in_progress'),
      driver,
    })
    expect(driver.dispatch).not.toHaveBeenCalled()
    expect(consumeAuxiliaryVisionExecutorFallbackAuthority(inProgress)).toMatchObject({
      state: 'durable_in_progress',
      reason: 'effect_in_progress',
      effectId: 'aux:progress',
    })

    const effectPort = effects([])
    const settle = vi.spyOn(storage, 'settleOrigin')
    const auth = await authority(session.key, 'aux:unknown')
    const unknownDriver = {
      dispatch: vi.fn(async () => {
        throw new Error('Bearer sk-secret-value')
      }),
    }
    await executeAuxiliaryVision({
      session,
      authority: auth,
      signal: new AbortController().signal,
      effects: effectPort,
      driver: unknownDriver,
    })
    const terminal = vi.mocked(effectPort.finish).mock.calls[0]?.[1]
    expect(terminal).toMatchObject({ kind: 'unknown_spend', creditSource: 'unknown' })
    expect(JSON.stringify(terminal)).not.toContain('secret-value')
    expect(settle.mock.calls.at(-1)?.[0]).toMatchObject({
      actualMicro: null,
      complete: false,
      creditSource: 'unknown',
    })
    if (!terminal) throw new Error('missing terminal')
    await executeAuxiliaryVision({
      session,
      authority: auth,
      signal: new AbortController().signal,
      effects: effects([], terminal),
      driver: unknownDriver,
    })
    expect(unknownDriver.dispatch).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledOnce()
    await kernel.close()
  })

  it('recovers finished-but-unsettled work using its receipt without dispatch', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('recover', sessionOpts)
    const terminal: AuxiliaryVisionEffectTerminal = {
      kind: 'known_spend',
      outcome: 'ok',
      purpose: 'media',
      model: 'vision',
      interrupted: false,
      tokens,
      credits: 0.2,
      creditSource: 'estimated',
      visionText: 'Recovered view',
    }
    const driver = { dispatch: vi.fn() }
    const settle = vi.spyOn(storage, 'settleOrigin')
    const result = await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:recover'),
      signal: new AbortController().signal,
      effects: effects([], terminal),
      driver,
    })
    expect(driver.dispatch).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, text: 'Recovered view' })
    expect(settle.mock.calls[0]?.[0]).toMatchObject({ creditSource: 'estimated', complete: true })
    await kernel.close()
  })

  it('rejects a recovered terminal carrying another budget binding', async () => {
    const { kernel } = setup()
    const session = await kernel.session('wrong-receipt', sessionOpts)
    const terminal: AuxiliaryVisionEffectTerminal = {
      kind: 'known_spend',
      outcome: 'ok',
      purpose: 'media',
      model: 'vision',
      interrupted: false,
      tokens,
      credits: 0.2,
      creditSource: 'gateway',
      visionText: 'wrong binding',
    }
    const effectPort = effects([], terminal)
    vi.mocked(effectPort.begin).mockImplementation(async (binding) => ({
      ...finished(terminal, binding),
      receipt: { ...finished(terminal, binding).receipt, budgetBindingHash: '0'.repeat(64) },
    }))
    const driver = { dispatch: vi.fn() }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: await authority(session.key, 'aux:wrong-receipt'),
        signal: new AbortController().signal,
        effects: effectPort,
        driver,
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    expect(driver.dispatch).not.toHaveBeenCalled()
    await kernel.close()
  })

  it('rejects recovered terminals and receipts with extra or accessor properties', async () => {
    const { kernel } = setup()
    const session = await kernel.session('strict-recovery', sessionOpts)
    const auth = await authority(session.key, 'aux:strict-recovery')
    const terminal: AuxiliaryVisionEffectTerminal = {
      kind: 'known_spend',
      outcome: 'ok',
      purpose: 'media',
      model: 'vision',
      interrupted: false,
      tokens,
      credits: 0.1,
      creditSource: 'gateway',
      visionText: 'valid',
    }
    const extraTerminal = { ...terminal, extra: true }
    const effectPort: AuxiliaryVisionEffectPort = {
      begin: async (binding) => {
        const valid = finished(terminal, binding)
        return {
          ...valid,
          terminal: extraTerminal,
          receipt: { ...valid.receipt, terminalHash: sha256Hex(canonicalJson(extraTerminal)) },
        } as never
      },
      finish: async () => {
        throw new Error('unreachable')
      },
    }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: auth,
        signal: new AbortController().signal,
        effects: effectPort,
        driver: { dispatch: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })

    const accessorPort: AuxiliaryVisionEffectPort = {
      begin: async (binding) => {
        const valid = finished(terminal, binding)
        const receipt = { ...valid.receipt }
        Object.defineProperty(receipt, 'terminalHash', {
          enumerable: true,
          get: () => valid.receipt.terminalHash,
        })
        return { ...valid, receipt }
      },
      finish: async () => {
        throw new Error('unreachable')
      },
    }
    const secondAuth = await authority(session.key, 'aux:strict-accessor')
    await expect(
      executeAuxiliaryVision({
        session,
        authority: secondAuth,
        signal: new AbortController().signal,
        effects: accessorPort,
        driver: { dispatch: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    const phaseGet = vi.fn((target: ReturnType<typeof finished>['receipt'], key: PropertyKey) =>
      Reflect.get(target, key),
    )
    const proxyPort: AuxiliaryVisionEffectPort = {
      begin: async (binding) => {
        const valid = finished(terminal, binding)
        return { ...valid, receipt: new Proxy(valid.receipt, { get: phaseGet }) }
      },
      finish: async () => {
        throw new Error('unreachable')
      },
    }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: await authority(session.key, 'aux:strict-proxy'),
        signal: new AbortController().signal,
        effects: proxyPort,
        driver: { dispatch: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    expect(phaseGet).not.toHaveBeenCalled()
    await kernel.close()
  })

  it('reconciles a lost settlement acknowledgement without redispatch', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('settle-ack', sessionOpts)
    const original = storage.settleOrigin.bind(storage)
    storage.settleOrigin = vi.fn(async (request) => {
      await original(request)
      throw new Error('ack lost')
    })
    const driver = {
      dispatch: vi.fn(
        async () =>
          ({
            status: 'completed',
            text: 'settled',
            usage: { tokens, credits: 0.1, creditSource: 'gateway' },
          }) as const,
      ),
    }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: await authority(session.key, 'aux:settle-ack'),
        signal: new AbortController().signal,
        effects: effects([]),
        driver,
      }),
    ).resolves.toMatchObject({ ok: true, text: 'settled' })
    expect(driver.dispatch).toHaveBeenCalledOnce()
    expect(storage.settleOrigin).toHaveBeenCalledOnce()
    await kernel.close()
  })

  it('binds one plan to one immutable effect/quote and rejects forged authority', async () => {
    const { kernel } = setup()
    const session = await kernel.session('authority', sessionOpts)
    const other = await kernel.session('authority-other', sessionOpts)
    const prepared = await plan(session.key)
    const bound = authorizeAuxiliaryVisionExecution({
      plan: prepared,
      effectId: 'aux:bound',
      projectedCredits: 1,
      inputTokens: 1,
    })
    expect(() =>
      authorizeAuxiliaryVisionExecution({
        plan: prepared,
        effectId: 'aux:changed',
        projectedCredits: 1,
        inputTokens: 1,
      }),
    ).toThrow('already bound')
    await expect(
      executeAuxiliaryVision({
        session,
        authority: { ...bound },
        signal: new AbortController().signal,
        effects: effects([]),
        driver: { dispatch: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(AuxiliaryVisionExecutionError)
    await expect(
      executeAuxiliaryVision({
        session: other,
        authority: bound,
        signal: new AbortController().signal,
        effects: effects([]),
        driver: { dispatch: vi.fn() },
      }),
    ).rejects.toMatchObject({ code: 'INPUT_INVALID' })
    await kernel.close()
  })

  it('rechecks cancellation after reservation and after durable intent', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('cancel', sessionOpts)
    const afterReserve = new AbortController()
    const originalReserve = storage.reserve.bind(storage)
    storage.reserve = vi.fn(async (request) => {
      const value = await originalReserve(request)
      afterReserve.abort()
      return value
    })
    const firstEffects = effects([])
    const driver = { dispatch: vi.fn() }
    const cancelledBeforeIntent = await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:cancel-reserve'),
      signal: afterReserve.signal,
      effects: firstEffects,
      driver,
    })
    expect(firstEffects.begin).not.toHaveBeenCalled()
    expect(consumeAuxiliaryVisionExecutorFallbackAuthority(cancelledBeforeIntent)).toMatchObject({
      state: 'not_dispatched',
      reason: 'cancelled_before_intent',
    })

    storage.reserve = originalReserve
    const afterIntent = new AbortController()
    const secondEffects = effects([])
    vi.mocked(secondEffects.begin).mockImplementation(async () => {
      afterIntent.abort()
      return { status: 'admitted', intentSeq: 7 as Seq }
    })
    await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:cancel-intent'),
      signal: afterIntent.signal,
      effects: secondEffects,
      driver,
    })
    expect(driver.dispatch).not.toHaveBeenCalled()
    expect(secondEffects.finish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'cancelled_before_dispatch' }),
    )
    await kernel.close()
  })

  it('runs the durable effect when optional tree budgeting is unconfigured', async () => {
    const { kernel, storage } = setup(null)
    const session = await kernel.session('unreserved', sessionOpts)
    const settle = vi.spyOn(storage, 'settleOrigin')
    const driver = {
      dispatch: vi.fn(
        async () =>
          ({
            status: 'completed',
            text: 'visible',
            usage: { tokens, credits: 0.1, creditSource: 'gateway' },
          }) as const,
      ),
    }
    await expect(
      executeAuxiliaryVision({
        session,
        authority: await authority(session.key, 'aux:unreserved'),
        signal: new AbortController().signal,
        effects: effects([]),
        driver,
      }),
    ).resolves.toMatchObject({ ok: true })
    expect(driver).toBeDefined()
    expect(driver.dispatch).toHaveBeenCalledOnce()
    expect(settle).not.toHaveBeenCalled()
    await kernel.close()
  })

  it('converts malformed post-dispatch usage to unknown without an estimated cost row', async () => {
    const { kernel } = setup()
    const session = await kernel.session('malformed', sessionOpts)
    const effectPort = effects([])
    await executeAuxiliaryVision({
      session,
      authority: await authority(session.key, 'aux:malformed'),
      signal: new AbortController().signal,
      effects: effectPort,
      driver: {
        dispatch: async () => ({
          status: 'completed',
          text: 'x',
          usage: { tokens, credits: Number.NaN, creditSource: 'estimated' },
        }),
      },
    })
    const terminal = vi.mocked(effectPort.finish).mock.calls[0]?.[1]
    expect(terminal).toEqual(expect.objectContaining({ kind: 'unknown_spend', creditSource: 'unknown' }))
    expect(terminal).not.toHaveProperty('tokens')
    await kernel.close()
  })

  it('rejects extra, accessor and Proxy driver usage without retaining or invoking it', async () => {
    const { kernel } = setup()
    const getter = vi.fn(() => 11)
    const accessorTokens = { output: 7, cacheRead: 0, cacheWrite: 0 }
    Object.defineProperty(accessorTokens, 'input', { enumerable: true, get: getter })
    const proxyGet = vi.fn((target: typeof tokens, key: keyof typeof tokens) => target[key])
    const proxyTokens = new Proxy(tokens, { get: proxyGet })
    const usages = [
      { tokens, credits: 0.1, creditSource: 'gateway', secret: 'sk-do-not-persist' },
      { tokens: accessorTokens, credits: 0.1, creditSource: 'gateway' },
      { tokens: proxyTokens, credits: 0.1, creditSource: 'gateway' },
    ]
    for (const [index, usage] of usages.entries()) {
      const session = await kernel.session(`hostile-usage-${index}`, sessionOpts)
      const effectPort = effects([])
      await executeAuxiliaryVision({
        session,
        authority: await authority(session.key, `aux:hostile-${index}`),
        signal: new AbortController().signal,
        effects: effectPort,
        driver: { dispatch: async () => ({ status: 'completed', text: 'x', usage }) as never },
      })
      const terminal = vi.mocked(effectPort.finish).mock.calls[0]?.[1]
      expect(terminal).toEqual(expect.objectContaining({ kind: 'unknown_spend' }))
      expect(JSON.stringify(terminal)).not.toContain('do-not-persist')
    }
    expect(getter).not.toHaveBeenCalled()
    expect(proxyGet).not.toHaveBeenCalled()
    await kernel.close()
  })
})
