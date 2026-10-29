import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Event, EventInput } from '@agnes/core-common/types'
import type { EffectHandle, EffectOutcome } from '@agnes/core-effects/effects/effect'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { ModelExecution } from '../src/execution/model-execution.js'
import { Kernel } from '../src/kernel.js'
import { sessionForLoop } from '../src/loop/scope.js'
import { createAuxiliaryVisionEffectPort } from '../src/orchestrator/auxiliary-vision-effect-port.js'
import {
  createSideCallEffectPort,
  readSideCallBinding,
  type SideCallEffectAudit,
  type SideCallEffectBinding,
} from '../src/orchestrator/side-call-effect-port.js'
import {
  checkSettlementOrder,
  type SideCallEffectTerminal,
  sideCallResult,
} from '../src/orchestrator/side-call-terminal.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const hash = (digit: string) => digit.repeat(64)
const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
const SENTINEL = 'SENTINEL-the-prompt-must-never-be-stored'

async function setup(key: string) {
  const kernel = Kernel.create({
    loops: defaultLoops(),
    storage: new MemoryStorage(),
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
  await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'decide' }] })
  expect(await session.acceptInput()).toBe(true)
  return { kernel, session }
}

const subject = { system: SENTINEL, messages: [], payload: { board: SENTINEL }, sampling: null }

function binding(sessionKey: string, overrides: Partial<SideCallEffectBinding> = {}): SideCallEffectBinding {
  return {
    effectId: 'side:call-1',
    sessionKey,
    lane: 'main',
    auditBindingHash: hash('a'),
    budgetBindingHash: hash('b'),
    subjectHash: sha256Hex(canonicalJson(subject)),
    requestDerivedHash: hash('d'),
    route: 'side-route',
    model: 'side-model',
    ...overrides,
  }
}

const audit: SideCallEffectAudit = {
  label: 'sample.decide',
  adapter: { id: 'sample-adapter', version: '1.0.0' },
  api: 'sample-adapter',
  endpointHost: 'models.example.com',
  deadlineMs: 10_000,
  output: 'json',
  inputTokens: 120,
  estimateSource: 'estimate',
  projectedCredits: 0.5,
  payloadBytes: 2048,
}

const head = { purpose: 'side-call', model: 'side-model' } as const
const okTerminal: SideCallEffectTerminal = {
  kind: 'known_spend',
  outcome: 'ok',
  ...head,
  interrupted: false,
  tokens: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
  credits: 0.42,
  creditSource: 'gateway',
  billing: { usdMicros: 420, source: 'gateway', subscription: false },
  text: '{"move":"e4"}',
  response: { id: 'r-1', model: 'side-model' },
  latencyMs: 700,
}
const noSpendTerminal: SideCallEffectTerminal = {
  kind: 'no_spend',
  outcome: 'error',
  ...head,
  interrupted: true,
  reason: 'driver_not_sent',
  code: 'CONTRACT_MISMATCH',
  retryable: false,
  latencyMs: 3,
}
const unknownTerminal: SideCallEffectTerminal = {
  kind: 'unknown_spend',
  outcome: 'error',
  ...head,
  interrupted: true,
  tokens: { input: 120, output: 0, cacheRead: 0, cacheWrite: 0 },
  credits: 0.5,
  creditSource: 'estimated',
  reason: 'deadline_exceeded',
  code: 'TIMEOUT',
  latencyMs: 10_000,
}

/** The cost and settlement rows a model execution writes for this terminal, in its own key order. */
function settlementRows(session: SessionImpl, effectId: string, terminal: SideCallEffectTerminal) {
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const spend =
    terminal.kind === 'no_spend'
      ? { tokens: zero, credits: 0, creditSource: 'estimated' }
      : {
          tokens: terminal.tokens,
          ...(terminal.credits === undefined ? {} : { credits: terminal.credits }),
          creditSource: terminal.creditSource,
          ...(terminal.kind === 'known_spend' && terminal.billing ? { billing: terminal.billing } : {}),
        }
  const cost = session.ev('cost/ledger', {
    purpose: 'side-call',
    effectId,
    model: 'side-model',
    ...spend,
    ...(terminal.interrupted ? { interrupted: true } : {}),
    route: 'side-route',
    adapter: { id: 'sample-adapter', version: '1.0.0' },
    endpointHost: 'models.example.com',
  })
  const code = 'code' in terminal && terminal.code !== undefined ? { code: terminal.code } : {}
  const settled = session.ev('effect/settled', {
    effectId,
    outcome: terminal.outcome,
    ...code,
    durationMs: terminal.latencyMs,
  })
  return { cost, settled }
}

/** A terminal row built by hand, so a shape the port itself refuses can still reach `write`. */
const forgedTerminal = (session: SessionImpl, identity: SideCallEffectBinding, terminal: unknown) =>
  session.ev(
    'x/core/side-call-terminal',
    {
      version: 1,
      effectId: identity.effectId,
      bindingHash: sha256Hex(canonicalJson(identity)),
      terminal,
      terminalHash: sha256Hex(canonicalJson(terminal)),
    },
    { ignorable: true },
  )
const external = (row: EventInput) =>
  ({ ...row, origin: 'external:fixture', trust: 'untrusted' }) as EventInput

function commitRows(
  session: SessionImpl,
  port: ReturnType<typeof createSideCallEffectPort>,
  identity: SideCallEffectBinding,
  terminal: SideCallEffectTerminal,
): EventInput[] {
  const { cost, settled } = settlementRows(session, identity.effectId, terminal)
  return [cost, settled, port.terminalRow(identity, terminal)]
}

const effectRows = (rows: readonly Event[], effectId: string) =>
  rows.filter((row) => JSON.stringify(row.data).includes(effectId))

describe('side-call ledger rows', () => {
  it('appends the intent and its binding row in one append, with exactly the binding and audit keys', async () => {
    const { kernel, session } = await setup('side-intent')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    const batches: Event[][] = []
    const stop = session.onAppended((events) => batches.push(events))
    const transition = vi.spyOn(session, 'transition')

    const intentSeq = await port.begin(identity, audit)
    stop()
    expect(transition).not.toHaveBeenCalled()
    expect(batches).toHaveLength(1)
    const [intent, bound] = batches[0] as Event[]
    expect(batches[0]?.map((row) => row.type)).toEqual(['effect/intent', 'x/core/side-call-intent'])
    expect(intent?.seq).toBe(intentSeq)
    expect(bound?.seq).toBe(intentSeq + 1)
    expect(intent?.data).toEqual({ effectId: 'side:call-1', kind: 'side-call', replay: 'never' })
    expect(bound).toMatchObject({ origin: 'system', trust: 'trusted', ignorable: true })
    const data = bound?.data as Record<string, Record<string, unknown>>
    expect(Object.keys(data)).toEqual(['version', 'binding', 'bindingHash', 'audit'])
    expect(data.version).toBe(1)
    expect(Object.keys(data.binding ?? {})).toEqual([
      'effectId',
      'sessionKey',
      'lane',
      'auditBindingHash',
      'budgetBindingHash',
      'subjectHash',
      'requestDerivedHash',
      'route',
      'model',
    ])
    expect(data.bindingHash).toBe(sha256Hex(canonicalJson(identity)))
    expect(data.audit).toEqual(audit)
    expect(Object.keys(data.audit ?? {})).toEqual([
      'label',
      'adapter',
      'api',
      'endpointHost',
      'deadlineMs',
      'output',
      'inputTokens',
      'estimateSource',
      'projectedCredits',
      'payloadBytes',
    ])

    const before = session.lastSeq
    await expect(port.begin(identity, audit)).rejects.toMatchObject({ code: 'E_RELATION' })
    const { subjectHash: _subject, ...withoutSubject } = identity
    const refused: Array<[unknown, unknown]> = [
      [{ ...identity, effectId: 'side:call-2', system: SENTINEL }, audit],
      [{ ...withoutSubject, effectId: 'side:call-3', mediaManifestHash: hash('c') }, audit],
      [{ ...identity, effectId: 'aux:call-4' }, audit],
      [{ ...identity, effectId: 'side:call-5', lane: 'other' }, audit],
      [{ ...identity, effectId: 'side:call-6', route: '' }, audit],
      [binding(session.key, { effectId: 'side:call-7' }), { ...audit, messages: [SENTINEL] }],
      [binding(session.key, { effectId: 'side:call-8' }), { ...audit, deadlineMs: 99 }],
      [binding(session.key, { effectId: 'side:call-9' }), { ...audit, label: 'Not A Label' }],
      [binding(session.key, { effectId: 'side:call-10' }), { ...audit, endpointHost: 'user@host/path' }],
    ]
    for (const [value, auditValue] of refused)
      await expect(port.begin(value as never, auditValue as never)).rejects.toThrow()
    expect(session.lastSeq).toBe(before)
    await kernel.close()
  })

  it('accepts the three terminal shapes and rejects tampered ones', async () => {
    const { kernel, session } = await setup('side-terminal-shapes')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    for (const terminal of [okTerminal, noSpendTerminal, unknownTerminal]) {
      const row = port.terminalRow(identity, terminal)
      expect(row).toMatchObject({ type: 'x/core/side-call-terminal', ignorable: true })
      expect(row.data).toEqual({
        version: 1,
        effectId: identity.effectId,
        bindingHash: sha256Hex(canonicalJson(identity)),
        terminal,
        terminalHash: sha256Hex(canonicalJson(terminal)),
      })
    }
    const tampered: unknown[] = [
      { ...okTerminal, interrupted: true },
      { ...okTerminal, visionText: 'media output field' },
      { ...okTerminal, model: 'other-model' },
      { ...okTerminal, purpose: 'media' },
      { ...okTerminal, credits: -1 },
      { ...noSpendTerminal, reason: 'deadline_exceeded' },
      { ...noSpendTerminal, code: undefined },
      { ...noSpendTerminal, outcome: 'ok' },
      { ...unknownTerminal, creditSource: 'gateway' },
      { ...unknownTerminal, code: 'AUTH' },
      { ...unknownTerminal, outcome: 'ok' },
      { ...unknownTerminal, reason: 'driver_failed' },
      { ...unknownTerminal, outcome: 'unknown', reason: 'driver_outcome_unknown' },
      { ...unknownTerminal, latencyMs: -1 },
      {
        kind: 'known_spend',
        outcome: 'error',
        ...head,
        interrupted: true,
        tokens: okTerminal.tokens,
        credits: 0.42,
        creditSource: 'gateway',
        reason: 'driver_failed',
        latencyMs: 5,
      },
    ]
    for (const terminal of tampered)
      expect(() => port.terminalRow(identity, terminal as SideCallEffectTerminal)).toThrow()
    const getter = vi.fn(() => 'text')
    const hostile = { ...okTerminal } as Record<string, unknown>
    Object.defineProperty(hostile, 'text', { enumerable: true, get: getter })
    expect(() => port.terminalRow(identity, hostile as SideCallEffectTerminal)).toThrow()
    expect(getter).not.toHaveBeenCalled()
    await kernel.close()
  })

  it('keeps a retry hint on an adapter-error terminal only, in whole milliseconds up to an hour', async () => {
    const { kernel, session } = await setup('side-retry-hint')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    const limited = { ...unknownTerminal, reason: 'adapter_error', code: 'RATE_LIMIT', retryable: true }
    const context = { invocationId: 'call-1', output: 'json', replayed: true } as const
    for (const retryAfterMs of [0, 2500, 3_600_000]) {
      const terminal = { ...limited, retryAfterMs } as SideCallEffectTerminal
      expect((port.terminalRow(identity, terminal).data as { terminal: unknown }).terminal).toEqual(terminal)
      expect(sideCallResult(terminal, context)).toMatchObject({ reason: 'adapter-error', retryAfterMs })
    }
    for (const retryAfterMs of [-1, 1.5, 3_600_001, Number.NaN, '2500'])
      expect(() =>
        port.terminalRow(identity, { ...limited, retryAfterMs } as unknown as SideCallEffectTerminal),
      ).toThrow()
    for (const other of [unknownTerminal, okTerminal])
      expect(() =>
        port.terminalRow(identity, { ...other, retryAfterMs: 2500 } as unknown as SideCallEffectTerminal),
      ).toThrow()
    expect(sideCallResult(limited as SideCallEffectTerminal, context)).not.toHaveProperty('retryAfterMs')
    await kernel.close()
  })

  it('commits cost, settlement and terminal in that order and refuses any other batch', async () => {
    const { kernel, session } = await setup('side-order')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity, audit)
    const [cost, settled, terminal] = commitRows(session, port, identity, okTerminal) as [
      EventInput,
      EventInput,
      EventInput,
    ]
    const before = session.lastSeq
    const wrongHash = { ...terminal, data: { ...(terminal.data as object), bindingHash: hash('e') } }
    const wrongTerminalHash = { ...terminal, data: { ...(terminal.data as object), terminalHash: hash('e') } }
    const wrongCredits = { ...cost, data: { ...(cost.data as object), credits: 0.43 } }
    const wrongOutcome = { ...settled, data: { ...(settled.data as object), outcome: 'error' } }
    const untrusted = { ...cost, origin: 'external:fixture', trust: 'untrusted' } as EventInput
    for (const batch of [
      [settled, terminal, cost],
      [cost, terminal, settled],
      [settled, cost, terminal],
      [terminal, cost, settled],
      [cost, settled],
      [cost, settled, terminal, cost],
      [cost, settled, wrongHash],
      [cost, settled, wrongTerminalHash],
      [wrongCredits, settled, terminal],
      [cost, wrongOutcome, terminal],
      [untrusted, settled, terminal],
    ])
      await expect(port.write(batch as EventInput[])).rejects.toThrow()
    expect(session.lastSeq).toBe(before)

    const seqs = await port.write([cost, settled, terminal])
    expect(seqs).toEqual([before + 1, before + 2, before + 3])
    const rows = await session.scan({ fromSeq: before + 1, toSeq: session.lastSeq })
    expect(rows.map((row) => row.type)).toEqual([
      'cost/ledger',
      'effect/settled',
      'x/core/side-call-terminal',
    ])
    await expect(port.write([cost, settled, terminal])).rejects.toMatchObject({ code: 'E_RELATION' })

    const media = [
      { type: 'effect/settled', data: { effectId: 'aux:1', outcome: 'ok' } },
      { type: 'x/core/auxiliary-vision-terminal', data: { effectId: 'aux:1' } },
      { type: 'cost/ledger', data: { effectId: 'aux:1' } },
    ]
    expect(() => checkSettlementOrder('media', media, 'aux:1', 'known_spend')).not.toThrow()
    expect(() => checkSettlementOrder('media', media.slice(0, 2), 'aux:1', 'no_spend')).not.toThrow()
    expect(() => checkSettlementOrder('side-call', media, 'aux:1', 'known_spend')).toThrow()
    const sideCall = [
      { type: 'cost/ledger', data: { effectId: 'side:x' } },
      { type: 'effect/settled', data: { effectId: 'side:x' } },
      { type: 'x/core/side-call-terminal', data: { effectId: 'side:x' } },
    ]
    for (const kind of ['known_spend', 'no_spend', 'unknown_spend'] as const)
      expect(() => checkSettlementOrder('side-call', sideCall, 'side:x', kind)).not.toThrow()
    expect(() => checkSettlementOrder('media', sideCall, 'side:x', 'known_spend')).toThrow()
    expect(() => checkSettlementOrder('side-call', sideCall, 'side:y', 'known_spend')).toThrow()
    await kernel.close()
  })

  it('accepts the rows a model execution writes for a call refused before it was sent', async () => {
    const { kernel, session } = await setup('side-execution')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    const intentSeq = await port.begin(identity, audit)
    const op = session.op()
    if (!op) throw new Error('expected an open turn')
    const effect: EffectHandle = {
      effectId: identity.effectId,
      intent: session.ev('effect/intent', {
        effectId: identity.effectId,
        kind: 'side-call',
        replay: 'never',
      }),
      settle: (outcome: EffectOutcome) =>
        session.ev('effect/settled', {
          effectId: identity.effectId,
          outcome,
          code: 'CONTRACT_MISMATCH',
          durationMs: 3,
        }),
    }
    const settledBudget: Array<number | undefined> = []
    const execution = new ModelExecution(session, {
      wire: { model: 'side-model', route: 'side-route', tools: [] } as unknown as RequestBody,
      effect,
      intentSeq,
      signal: new AbortController().signal,
      turnId: op.meta.turn,
      step: op.step,
      memory: session.turn,
      purpose: 'side-call',
      unobserved: { inputTokens: 120, credits: 0.5 },
      outcomeFromCaller: true,
      retry: false,
      replaceable: false,
      extraCostFields: {
        route: 'side-route',
        adapter: { id: 'sample-adapter', version: '1.0.0' },
        endpointHost: 'models.example.com',
      },
      settleTreeBudget: async (credits) => {
        settledBudget.push(credits)
      },
      write: (events) => port.write(events),
    })
    await execution.commit(
      [...execution.rows('error', true), port.terminalRow(identity, noSpendTerminal)],
      (current) => current,
    )
    expect(settledBudget).toEqual([0])
    const status = await port.status('call-1')
    expect(status).toMatchObject({
      status: 'finished',
      result: {
        status: 'failed',
        reason: 'adapter-error',
        code: 'CONTRACT_MISMATCH',
        dispatch: 'not-sent',
        retryable: false,
        usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, credits: 0 },
      },
    })
    await kernel.close()
  })

  it('reads a binding back only from a trusted row whose hash matches', async () => {
    const { kernel, session } = await setup('side-binding-read')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    const intentSeq = await port.begin(identity, audit)
    await expect(readSideCallBinding(session, intentSeq, identity.effectId)).resolves.toEqual({
      binding: identity,
      audit,
    })
    await expect(readSideCallBinding(session, intentSeq, 'side:other')).resolves.toBeUndefined()
    await expect(readSideCallBinding(session, intentSeq + 1, identity.effectId)).resolves.toBeUndefined()

    const append = async (
      effectId: string,
      data: Record<string, unknown>,
      authority: Partial<EventInput> = {},
    ): Promise<number> => {
      const committed = await session.append([
        { ...session.ev('effect/intent', { effectId, kind: 'side-call', replay: 'never' }), ...authority },
        { ...session.ev('x/core/side-call-intent', data, { ignorable: true }), ...authority },
      ])
      return committed.seqs[0] as number
    }
    const forged = binding(session.key, { effectId: 'side:forged' })
    const forgedSeq = await append(
      forged.effectId,
      { version: 1, binding: forged, bindingHash: sha256Hex(canonicalJson(forged)), audit },
      { origin: 'external:fixture', trust: 'untrusted' },
    )
    await expect(readSideCallBinding(session, forgedSeq, forged.effectId)).resolves.toBeUndefined()

    const mismatched = binding(session.key, { effectId: 'side:mismatched' })
    const mismatchedSeq = await append(mismatched.effectId, {
      version: 1,
      binding: mismatched,
      bindingHash: hash('f'),
      audit,
    })
    await expect(readSideCallBinding(session, mismatchedSeq, mismatched.effectId)).resolves.toBeUndefined()

    const altered = binding(session.key, { effectId: 'side:altered' })
    const alteredSeq = await append(altered.effectId, {
      version: 1,
      binding: { ...altered, model: 'swapped-model' },
      bindingHash: sha256Hex(canonicalJson(altered)),
      audit,
    })
    await expect(readSideCallBinding(session, alteredSeq, altered.effectId)).resolves.toBeUndefined()

    for (const [name, swapped] of [
      ['lane', { lane: 'other' }],
      ['key', { sessionKey: 'other-session' }],
    ] as const) {
      const foreign = binding(session.key, { effectId: `side:foreign-${name}`, ...swapped })
      const bindingHash = sha256Hex(canonicalJson(foreign))
      const seq = await append(foreign.effectId, { version: 1, binding: foreign, bindingHash, audit })
      await expect(readSideCallBinding(session, seq, foreign.effectId)).resolves.toBeUndefined()
    }

    const fresh = createSideCallEffectPort(session)
    await expect(fresh.status('forged')).resolves.toEqual({ status: 'absent', invocationId: 'forged' })
    await expect(fresh.status('mismatched')).rejects.toMatchObject({ code: 'E_RELATION' })
    await expect(fresh.status('altered')).rejects.toMatchObject({ code: 'E_RELATION' })
    await expect(fresh.status('call-1')).resolves.toMatchObject({ status: 'in-flight' })
    await kernel.close()
  })

  it('answers status from an index built once: absent, in-flight, then finished', async () => {
    const { kernel, session } = await setup('side-status')
    const scan = vi.spyOn(session, 'scan')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    await expect(port.status('call-1')).resolves.toEqual({ status: 'absent', invocationId: 'call-1' })
    const indexScans = () =>
      scan.mock.calls.filter(
        ([query]) => Array.isArray(query.type) && query.type.includes('x/core/side-call-intent'),
      ).length
    expect(indexScans()).toBe(1)

    await port.begin(identity, audit)
    await expect(port.status('call-1')).resolves.toEqual({ status: 'in-flight', invocationId: 'call-1' })
    await port.write(commitRows(session, port, identity, okTerminal))
    const finished = await port.status('call-1')
    expect(finished).toEqual({
      status: 'finished',
      invocationId: 'call-1',
      label: 'sample.decide',
      requestHash: identity.auditBindingHash,
      result: {
        status: 'ok',
        invocationId: 'call-1',
        text: '{"move":"e4"}',
        json: { move: 'e4' },
        usage: {
          tokens: okTerminal.tokens,
          credits: 0.42,
          creditSource: 'gateway',
          billing: { usdMicros: 420, source: 'gateway', subscription: false },
        },
        latencyMs: 700,
        response: { id: 'r-1', model: 'side-model' },
        replayed: true,
      },
    })
    await expect(port.status('call-2')).resolves.toEqual({ status: 'absent', invocationId: 'call-2' })
    for (const [value, terminal] of [
      [binding(session.key, { effectId: 'side:call-2' }), noSpendTerminal],
      [binding(session.key, { effectId: 'side:call-3' }), unknownTerminal],
    ] as const) {
      await port.begin(value, audit)
      await port.write(commitRows(session, port, value, terminal))
    }
    expect(indexScans()).toBe(1)
    for (const query of scan.mock.calls.map(([query]) => query).filter((query) => query.type === undefined))
      expect((query.toSeq ?? 0) - (query.fromSeq ?? 0)).toBeLessThanOrEqual(2)

    const fresh = createSideCallEffectPort(session)
    await expect(fresh.status('call-1')).resolves.toEqual(finished)
    await expect(fresh.status('call-2')).resolves.toMatchObject({
      status: 'finished',
      result: {
        status: 'failed',
        reason: 'adapter-error',
        code: 'CONTRACT_MISMATCH',
        retryable: false,
        dispatch: 'not-sent',
        latencyMs: 3,
        replayed: true,
      },
    })
    await expect(fresh.status('call-3')).resolves.toMatchObject({
      status: 'finished',
      result: {
        status: 'failed',
        reason: 'deadline',
        code: 'TIMEOUT',
        retryable: true,
        dispatch: 'may-have-sent',
        usage: { tokens: unknownTerminal.tokens, credits: 0.5, creditSource: 'estimated' },
        latencyMs: 10_000,
        replayed: true,
      },
    })
    expect(indexScans()).toBe(2)
    await kernel.close()
  })

  it('reports a call settled as unknown by recovery as interrupted', async () => {
    const { kernel, session } = await setup('side-recovered')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity, audit)
    await session.append([session.ev('effect/settled', { effectId: identity.effectId, outcome: 'unknown' })])
    await expect(createSideCallEffectPort(session).status('call-1')).resolves.toEqual({
      status: 'finished',
      invocationId: 'call-1',
      label: 'sample.decide',
      requestHash: identity.auditBindingHash,
      result: { status: 'unknown', invocationId: 'call-1', reason: 'interrupted', replayed: true },
    })
    await kernel.close()
  })

  it('treats a late receipt written after revocation as a finished, cancelled call', async () => {
    const { kernel, session } = await setup('side-late-receipt')
    const scoped = sessionForLoop(session)
    const port = createSideCallEffectPort(scoped)
    const identity = binding(session.key)
    const intentSeq = await port.begin(identity, audit)
    const rows = commitRows(session, port, identity, okTerminal)
    scoped.loopScope.revoke()
    await expect(port.write(rows)).rejects.toMatchObject({ code: 'E_CLOSED' })
    const written = effectRows(
      await session.scan({ fromSeq: intentSeq, toSeq: session.lastSeq }),
      'side:call-1',
    )
    expect(written.map((row) => row.type)).toEqual([
      'effect/intent',
      'x/core/side-call-intent',
      'cost/ledger',
      'x/core/late-effect-receipt',
    ])
    expect(written[3]?.sourceEventSeqs).toEqual([intentSeq])

    await expect(createSideCallEffectPort(session).status('call-1')).resolves.toEqual({
      status: 'finished',
      invocationId: 'call-1',
      label: 'sample.decide',
      requestHash: identity.auditBindingHash,
      result: {
        status: 'failed',
        invocationId: 'call-1',
        reason: 'cancelled',
        retryable: false,
        dispatch: 'may-have-sent',
        latencyMs: 0,
        replayed: true,
      },
    })
    await kernel.close()
  })

  it('refuses a settlement that records a live call as unknown', async () => {
    const { kernel, session } = await setup('side-live-unknown')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity, audit)
    const unknown = { ...unknownTerminal, outcome: 'unknown', reason: 'driver_outcome_unknown' }
    const { cost, settled } = settlementRows(session, identity.effectId, unknown as SideCallEffectTerminal)
    const before = session.lastSeq
    const batch = [cost, settled, forgedTerminal(session, identity, unknown)]
    await expect(port.write(batch)).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(session.lastSeq).toBe(before)
    await expect(port.status('call-1')).resolves.toEqual({ status: 'in-flight', invocationId: 'call-1' })
    await kernel.close()
  })

  it('leaves a call in flight when its settlement or receipt rows lack Core authority', async () => {
    const { kernel, session } = await setup('side-forged')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    const intentSeq = await port.begin(identity, audit)
    const status = () => createSideCallEffectPort(session).status('call-1')
    const inFlight = { status: 'in-flight', invocationId: 'call-1' }
    const { cost, settled } = settlementRows(session, identity.effectId, okTerminal)
    await session.append([cost, settled, port.terminalRow(identity, okTerminal)].map(external))
    await expect(status()).resolves.toEqual(inFlight)
    const receipt = session.ev(
      'x/core/late-effect-receipt',
      { version: 1, effects: [settled.data], receipts: [] },
      { ignorable: true, sourceEventSeqs: [intentSeq] },
    )
    await session.append([external(receipt)])
    await expect(status()).resolves.toEqual(inFlight)
    await session.append([
      session.ev('effect/intent', { effectId: identity.effectId, kind: 'side-call', replay: 'never' }),
      session.ev(
        'x/core/side-call-intent',
        { version: 1, binding: identity, bindingHash: sha256Hex(canonicalJson(identity)), audit },
        { ignorable: true },
      ),
    ])
    await expect(status()).rejects.toMatchObject({ code: 'E_RELATION' })
    await kernel.close()
  })

  it('checks the cost and settlement rows it keeps when revocation turns them into a late receipt', async () => {
    const { kernel, session } = await setup('side-revoked-cost')
    const scoped = sessionForLoop(session)
    const port = createSideCallEffectPort(scoped)
    const identity = binding(session.key)
    const intentSeq = await port.begin(identity, audit)
    const { cost, settled } = settlementRows(session, identity.effectId, okTerminal)
    const changed = (data: object) => ({ ...cost, data: { ...(cost.data as object), ...data } })
    const settledWith = (data: object) => ({ ...settled, data: { ...(settled.data as object), ...data } })
    scoped.loopScope.revoke()
    const before = session.lastSeq
    for (const row of [
      changed({ purpose: 'inference' }),
      changed({ model: 'other-model' }),
      changed({ route: 'other-route' }),
      external(cost),
    ])
      await expect(port.write([row as EventInput, settled])).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    for (const row of [
      external(settled),
      { ...settled, lane: 'other-lane' },
      settledWith({ outcome: 'unknown' }),
      settledWith({ code: 'NOT_A_CODE' }),
      settledWith({ durationMs: -1 }),
      settledWith({ note: 'extra' }),
    ])
      await expect(port.write([cost, row as EventInput])).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    expect(session.lastSeq).toBe(before)
    const closed = { code: 'E_CLOSED', detail: { costSeq: before + 1 } }
    await expect(port.write([cost, settled])).rejects.toMatchObject(closed)
    const written = await session.scan({ fromSeq: intentSeq + 2, toSeq: session.lastSeq })
    expect(written.map((row) => row.type)).toEqual(['cost/ledger', 'x/core/late-effect-receipt'])
    expect(written[0]?.data).toMatchObject({ purpose: 'side-call', effectId: 'side:call-1' })
    await kernel.close()
  })

  it('keeps prompt and payload text out of the ledger', async () => {
    const { kernel, session } = await setup('side-digests')
    const port = createSideCallEffectPort(session)
    const identity = binding(session.key)
    await port.begin(identity, audit)
    await port.write(commitRows(session, port, identity, okTerminal))
    const rows = await session.scan({ fromSeq: 1, toSeq: session.lastSeq })
    expect(rows.some((row) => row.type === 'x/core/side-call-terminal')).toBe(true)
    expect(JSON.stringify(rows)).not.toContain(SENTINEL)
    await kernel.close()
  })

  it('maps each terminal to the result a loop sees', () => {
    const context = { invocationId: 'call-1', output: 'text' as const, replayed: false }
    expect(sideCallResult(okTerminal, context)).toMatchObject({ status: 'ok', replayed: false })
    expect(sideCallResult(okTerminal, context)).not.toHaveProperty('json')
    const result = (terminal: object, output: 'text' | 'json' = 'text') =>
      sideCallResult({ ...head, ...terminal } as SideCallEffectTerminal, { ...context, output })
    const spent = { tokens: okTerminal.tokens, creditSource: 'estimated', interrupted: true }
    expect(
      result({ kind: 'no_spend', outcome: 'aborted', reason: 'cancelled_before_dispatch', latencyMs: 1 }),
    ).toMatchObject({ status: 'failed', reason: 'cancelled', retryable: false, dispatch: 'not-sent' })
    expect(
      result(
        { ...okTerminal, outcome: 'error', reason: 'invalid_output', text: 'not json', latencyMs: 9 },
        'json',
      ),
    ).toMatchObject({
      status: 'failed',
      reason: 'invalid-output',
      retryable: false,
      dispatch: 'may-have-sent',
    })
    expect(
      result({
        ...spent,
        kind: 'unknown_spend',
        outcome: 'aborted',
        reason: 'session_cancelled',
        latencyMs: 4,
      }),
    ).toEqual({
      status: 'failed',
      invocationId: 'call-1',
      reason: 'cancelled',
      retryable: false,
      dispatch: 'may-have-sent',
      latencyMs: 4,
      replayed: false,
    })
    const adapterError = { ...spent, kind: 'unknown_spend', outcome: 'error', reason: 'adapter_error' }
    const failed = result({ ...adapterError, code: 'RATE_LIMIT', retryable: true, latencyMs: 4 })
    expect(failed).toMatchObject({ status: 'failed', reason: 'adapter-error', retryable: true })
    expect(failed).not.toHaveProperty('usage')
  })
})

describe('media rows through the shared ledger-row layer', () => {
  it('writes the same bytes as before', async () => {
    const { kernel, session } = await setup('media-pinned')
    const port = createAuxiliaryVisionEffectPort(session)
    const identity = {
      effectId: 'aux:pinned',
      sessionKey: session.key,
      lane: 'main',
      auditBindingHash: hash('a'),
      budgetBindingHash: hash('b'),
      mediaManifestHash: hash('c'),
      requestDerivedHash: hash('d'),
      model: 'vision-model',
    }
    const bindingHash = sha256Hex(canonicalJson(identity))
    await port.begin(identity)
    await port.finish(identity, {
      kind: 'known_spend',
      outcome: 'ok',
      purpose: 'media',
      model: 'vision-model',
      interrupted: false,
      tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 },
      credits: 0.25,
      creditSource: 'gateway',
      visionText: 'Save is visible',
    })
    const rows = effectRows(await session.scan({ fromSeq: 1, toSeq: session.lastSeq }), 'aux:pinned')
    const bytes = rows.map(({ type, data, origin, trust, ignorable }) =>
      JSON.stringify({ type, data, origin, trust, ignorable }),
    )
    expect(bytes).toEqual([
      '{"type":"effect/intent","data":{"effectId":"aux:pinned","kind":"media","replay":"never"},"origin":"system","trust":"trusted"}',
      `{"type":"x/core/auxiliary-vision-intent","data":{"version":1,"binding":{"effectId":"aux:pinned","sessionKey":"media-pinned","lane":"main","auditBindingHash":"${hash('a')}","budgetBindingHash":"${hash('b')}","mediaManifestHash":"${hash('c')}","requestDerivedHash":"${hash('d')}","model":"vision-model"},"bindingHash":"${bindingHash}"},"origin":"system","trust":"trusted","ignorable":true}`,
      '{"type":"effect/settled","data":{"effectId":"aux:pinned","outcome":"ok"},"origin":"system","trust":"trusted"}',
      `{"type":"x/core/auxiliary-vision-terminal","data":{"version":1,"effectId":"aux:pinned","bindingHash":"${bindingHash}","terminal":{"kind":"known_spend","outcome":"ok","purpose":"media","model":"vision-model","interrupted":false,"tokens":{"input":11,"output":7,"cacheRead":0,"cacheWrite":0},"credits":0.25,"creditSource":"gateway","visionText":"Save is visible"},"terminalHash":"3e632da74ea58f6d9875538fea46bed7fcf4f20c7463a0d0547c11fa9bce8ae7"},"origin":"system","trust":"trusted","ignorable":true}`,
      '{"type":"cost/ledger","data":{"purpose":"media","effectId":"aux:pinned","tokens":{"input":11,"output":7,"cacheRead":0,"cacheWrite":0},"credits":0.25,"creditSource":"gateway","model":"vision-model","interrupted":false},"origin":"system","trust":"trusted"}',
    ])
    await kernel.close()
  })
})
