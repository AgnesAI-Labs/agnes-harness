import { describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { createAuxiliaryVisionEffectPort } from '../src/orchestrator/auxiliary-vision-effect-port.js'
import type {
  AuxiliaryVisionEffectBinding,
  AuxiliaryVisionEffectTerminal,
} from '../src/orchestrator/auxiliary-vision-executor.js'
import { presetDefaults } from '../src/step/preset.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const hash = (digit: string) => digit.repeat(64)
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

async function setup(key: string) {
  const storage = new MemoryStorage()
  const kernel = Kernel.create({
    storage,
    seams: fakeSeams(),
    provider: fakeProvider([]),
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: noTimers,
    clock: () => 1_757_203_200_000,
  })
  const session = await kernel.session(key, sessionOpts)
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'inspect image' }] })
  expect(await session.acceptInput()).toBe(true)
  return { kernel, session }
}

function binding(sessionKey: string, overrides: Partial<AuxiliaryVisionEffectBinding> = {}) {
  return {
    effectId: 'aux:effect',
    sessionKey,
    lane: 'main',
    auditBindingHash: hash('a'),
    budgetBindingHash: hash('b'),
    mediaManifestHash: hash('c'),
    requestDerivedHash: hash('d'),
    model: 'vision-model',
    ...overrides,
  } satisfies AuxiliaryVisionEffectBinding
}

const knownTerminal: AuxiliaryVisionEffectTerminal = {
  kind: 'known_spend',
  outcome: 'ok',
  purpose: 'media',
  model: 'vision-model',
  interrupted: false,
  tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 },
  credits: 0.25,
  creditSource: 'gateway',
  visionText: 'Save is visible',
}

describe('auxiliary vision durable effect port', () => {
  it('admits once, atomically records known usage, and recovers the same frozen receipt', async () => {
    const { kernel, session } = await setup('aux-port-known')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = binding(session.key)
    const [first, second] = await Promise.all([port.begin(identity), port.begin(identity)])
    expect([first.status, second.status].sort()).toEqual(['admitted', 'in_progress'])

    const finished = await port.finish(identity, knownTerminal)
    expect(finished).toMatchObject({
      status: 'finished',
      terminal: { kind: 'known_spend', credits: 0.25, creditSource: 'gateway' },
      receipt: {
        auditBindingHash: identity.auditBindingHash,
        budgetBindingHash: identity.budgetBindingHash,
        requestDerivedHash: identity.requestDerivedHash,
      },
    })
    expect(Object.isFrozen(finished)).toBe(true)
    expect(Object.isFrozen(finished.terminal)).toBe(true)
    expect(Object.isFrozen(finished.terminal.kind === 'known_spend' && finished.terminal.tokens)).toBe(true)
    await expect(port.begin(identity)).resolves.toEqual(finished)
    await expect(port.finish(identity, knownTerminal)).resolves.toEqual(finished)

    const rows = await session.scan({ toSeq: session.lastSeq, lane: 'main' })
    expect(rows.filter((row) => row.type === 'effect/intent')).toHaveLength(1)
    expect(rows.find((row) => row.type === 'effect/intent')?.data).toMatchObject({
      effectId: identity.effectId,
      kind: 'media',
      replay: 'never',
    })
    expect(rows.filter((row) => row.type === 'effect/settled')).toHaveLength(1)
    expect(rows.find((row) => row.type === 'effect/settled')?.data).toMatchObject({
      effectId: identity.effectId,
      outcome: 'ok',
    })
    const intentSeq = rows.find((row) => row.type === 'effect/intent')?.seq
    const intentMetadataSeq = rows.find((row) => row.type === 'x/core/auxiliary-vision-intent')?.seq
    const settledSeq = rows.find((row) => row.type === 'effect/settled')?.seq
    const terminalMetadataSeq = rows.find((row) => row.type === 'x/core/auxiliary-vision-terminal')?.seq
    expect(intentMetadataSeq).toBe((intentSeq ?? 0) + 1)
    expect(terminalMetadataSeq).toBe((settledSeq ?? 0) + 1)
    expect(rows.filter((row) => row.type === 'cost/ledger')).toHaveLength(1)
    expect(rows.find((row) => row.type === 'cost/ledger')?.seq).toBe((terminalMetadataSeq ?? 0) + 1)
    expect(finished.receipt.costOriginSeq).toBe(rows.find((row) => row.type === 'cost/ledger')?.seq)
    await kernel.close()
  })

  it('persists unknown spend without a cost row and never re-admits it', async () => {
    const { kernel, session } = await setup('aux-port-unknown')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity)
    const terminal: AuxiliaryVisionEffectTerminal = {
      kind: 'unknown_spend',
      outcome: 'unknown',
      purpose: 'media',
      model: identity.model,
      interrupted: true,
      creditSource: 'unknown',
      reason: 'driver_outcome_unknown',
    }
    const finished = await port.finish(identity, terminal)
    expect(finished.receipt).not.toHaveProperty('costOriginSeq')
    await expect(port.begin(identity)).resolves.toEqual(finished)
    const rows = await session.scan({ toSeq: session.lastSeq, lane: 'main' })
    expect(rows.filter((row) => row.type === 'cost/ledger')).toHaveLength(0)
    expect(rows.filter((row) => row.type === 'effect/settled')).toHaveLength(1)
    expect(rows.find((row) => row.type === 'effect/settled')?.data).toMatchObject({
      effectId: identity.effectId,
      outcome: 'unknown',
    })
    await kernel.close()
  })

  it('reconciles a generic resume unknown settlement without redispatch authority', async () => {
    const { kernel, session } = await setup('aux-port-resumed-unknown')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity)
    await session.append([session.ev('effect/settled', { effectId: identity.effectId, outcome: 'unknown' })])

    const recovered = await port.begin(identity)
    expect(recovered).toMatchObject({
      status: 'finished',
      terminal: {
        kind: 'unknown_spend',
        outcome: 'unknown',
        purpose: 'media',
        creditSource: 'unknown',
      },
    })
    expect(await session.scan({ type: 'effect/intent', toSeq: session.lastSeq })).toHaveLength(1)
    expect(await session.scan({ type: 'cost/ledger', toSeq: session.lastSeq })).toHaveLength(0)
    await kernel.close()
  })

  it('fails closed on media identity drift and hostile terminal data', async () => {
    const { kernel, session } = await setup('aux-port-invalid')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity)
    await expect(port.begin(binding(session.key, { mediaManifestHash: hash('e') }))).rejects.toMatchObject({
      code: 'SETTLEMENT_INVALID',
    })

    const getter = vi.fn(() => 'Save is visible')
    const hostile = { ...knownTerminal } as Record<string, unknown>
    Object.defineProperty(hostile, 'visionText', { enumerable: true, get: getter })
    await expect(port.finish(identity, hostile as AuxiliaryVisionEffectTerminal)).rejects.toMatchObject({
      code: 'SETTLEMENT_INVALID',
    })
    expect(getter).not.toHaveBeenCalled()
    expect(
      await session.scan({ type: 'x/core/auxiliary-vision-terminal', toSeq: session.lastSeq }),
    ).toHaveLength(0)

    await expect(
      port.finish(identity, {
        ...knownTerminal,
        tokens: { input: undefined, output: undefined, cacheRead: undefined, cacheWrite: undefined },
      } as unknown as AuxiliaryVisionEffectTerminal),
    ).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    await kernel.close()
  })

  it('rejects authority from a different session before writing lifecycle state', async () => {
    const { kernel, session } = await setup('aux-port-session-a')
    const other = await kernel.session('aux-port-session-b', sessionOpts)
    const port = createAuxiliaryVisionEffectPort(other)

    await expect(port.begin(binding(session.key))).rejects.toMatchObject({
      code: 'SETTLEMENT_INVALID',
    })
    expect(await other.scan({ type: 'effect/intent', toSeq: other.lastSeq })).toHaveLength(0)
    await kernel.close()
  })

  it('rejects durable rows that do not carry Core system authority', async () => {
    const { kernel, session } = await setup('aux-port-authority')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity)
    const [intent] = await session.scan({
      type: 'effect/intent',
      toSeq: session.lastSeq,
    })
    if (!intent) throw new Error('missing intent fixture')
    await session.append([
      {
        type: intent.type,
        data: intent.data,
        actor: intent.actor,
        origin: 'external:fixture',
        trust: 'untrusted',
        ...(intent.lane === undefined ? {} : { lane: intent.lane }),
        ignorable: true,
      },
    ])
    await expect(port.begin(identity)).rejects.toMatchObject({ code: 'SETTLEMENT_INVALID' })
    await kernel.close()
  })
})
