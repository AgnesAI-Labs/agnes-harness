import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import {
  reconcileTreeReservationHandle,
  releaseTreeReservation,
  releaseTreeReservationHandle,
  reserveTreeBudget,
  reserveTreeBudgetHandle,
  setTreePermit,
  settleTreeSpend,
  settleTreeSpendHandle,
  takeoverTreeReservationWriter,
  treePermitOf,
} from '../src/child/runtime-budget.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { presetDefaults } from '../src/step/preset.js'
import type { Seq } from '../src/types.js'
import { fakeProvider } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

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

function setup(storage = new MemoryStorage(), treeBudgetCredits: number | null = 10) {
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

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }
const target = { route: 'aux', model: 'vision' }

describe('explicit tree budget reservation handles', () => {
  it('fences stale primary permit release and settlement after writer takeover', async () => {
    for (const terminal of ['release', 'settle'] as const) {
      const { kernel, storage } = setup()
      const session = await kernel.session(`primary-${terminal}`, sessionOpts)
      await expect(reserveTreeBudget(session, 1, target)).resolves.toBe('ok')
      const permit = treePermitOf(session)
      if (!permit?.rootTaskId || permit.writerGeneration === undefined)
        throw new Error('expected fenced primary permit')
      await storage.takeoverReservation?.(permit.permitId, permit.writerGeneration)

      if (terminal === 'release')
        await expect(releaseTreeReservation(session)).rejects.toThrow('stale reservation writer generation')
      else
        await expect(settleTreeSpend(session, 1, 6 as Seq)).rejects.toThrow(
          'stale reservation writer generation',
        )
      expect(await storage.peekReservation?.(permit.permitId)).toMatchObject({
        status: 'held',
        writerGeneration: permit.writerGeneration + 1,
      })
      await kernel.close()
    }
  })

  it('keeps concurrent auxiliary holds independent from the primary permit', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const settle = vi.spyOn(storage, 'settleOrigin')
    setTreePermit(session, { permitId: 'primary', requestHash: 'primary-hash' })

    const first = await reserveTreeBudgetHandle(
      session,
      2,
      target,
      { effectId: 'aux:one', requestHash: '1'.repeat(64) },
      10,
    )
    const second = await reserveTreeBudgetHandle(
      session,
      3,
      target,
      { effectId: 'aux:two', requestHash: '2'.repeat(64) },
      20,
    )

    expect(first.status).toBe('reserved')
    expect(second.status).toBe('reserved')
    expect(treePermitOf(session)).toEqual({ permitId: 'primary', requestHash: 'primary-hash' })
    if (first.status !== 'reserved' || second.status !== 'reserved') return
    expect(first.handle.permitId).not.toBe(second.handle.permitId)
    expect(await storage.peekReservation?.(first.handle.permitId)).toMatchObject({
      effectId: 'aux:one',
      requestHash: first.handle.requestHash,
      status: 'held',
    })
    expect(await storage.peekReservation?.(second.handle.permitId)).toMatchObject({
      effectId: 'aux:two',
      requestHash: second.handle.requestHash,
      status: 'held',
    })

    await Promise.all([
      releaseTreeReservationHandle(session, first.handle),
      settleTreeSpendHandle(session, second.handle, 1, 7 as Seq, 'gateway'),
    ])
    expect(await storage.peekReservation?.(first.handle.permitId)).toMatchObject({ status: 'released' })
    expect(await storage.peekReservation?.(second.handle.permitId)).toMatchObject({ status: 'settled' })
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ creditSource: 'gateway' }))
    await kernel.close()
  })

  it('makes identical terminal operations idempotent and rejects conflicting operations', async () => {
    const { kernel } = setup()
    const session = await kernel.session('s', sessionOpts)
    const released = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:release',
      requestHash: '3'.repeat(64),
    })
    const settled = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:settle',
      requestHash: '4'.repeat(64),
    })
    if (released.status !== 'reserved' || settled.status !== 'reserved') return

    await Promise.all([
      releaseTreeReservationHandle(session, released.handle),
      releaseTreeReservationHandle(session, released.handle),
    ])
    await expect(settleTreeSpendHandle(session, released.handle, 1, 8 as Seq)).rejects.toThrow(
      'already released',
    )

    await Promise.all([
      settleTreeSpendHandle(session, settled.handle, undefined, 9 as Seq),
      settleTreeSpendHandle(session, settled.handle, undefined, 9 as Seq),
    ])
    await expect(settleTreeSpendHandle(session, settled.handle, 1, 9 as Seq)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(releaseTreeReservationHandle(session, settled.handle)).rejects.toThrow(
      'requires reconciliation',
    )
    await kernel.close()
  })

  it('coalesces concurrent and sequential reservation retries and rejects quote conflicts', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const identity = { effectId: 'aux:idempotent', requestHash: '7'.repeat(64) }

    const [first, concurrent] = await Promise.all([
      reserveTreeBudgetHandle(session, 2, target, identity, 10),
      reserveTreeBudgetHandle(session, 2, target, identity, 10),
    ])
    const sequential = await reserveTreeBudgetHandle(session, 2, target, identity, 10)
    expect(first.status).toBe('reserved')
    expect(concurrent.status).toBe('reserved')
    expect(sequential.status).toBe('reserved')
    if (first.status !== 'reserved' || concurrent.status !== 'reserved' || sequential.status !== 'reserved')
      return
    expect(concurrent.handle).toBe(first.handle)
    expect(sequential.handle).toBe(first.handle)
    expect((await storage.projectTree('s:main:0'))?.heldMicro).toBe(2_000_000n)
    await expect(reserveTreeBudgetHandle(session, 3, target, identity, 10)).rejects.toThrow(
      'reused with a different quote',
    )
    await releaseTreeReservationHandle(session, first.handle)
    await kernel.close()
  })

  it('recovers the durable handle identity after the session object is replaced', async () => {
    const storage = new MemoryStorage()
    const firstKernel = setup(storage).kernel
    const firstSession = await firstKernel.session('s', sessionOpts)
    const identity = { effectId: 'aux:crash-recovery', requestHash: 'd'.repeat(64) }
    const first = await reserveTreeBudgetHandle(firstSession, 2, target, identity, 10)
    if (first.status !== 'reserved') return
    expect(first.existing).toBe(false)
    await firstKernel.close()

    const recoveredKernel = setup(storage).kernel
    const recoveredSession = await recoveredKernel.session('s', sessionOpts)
    const recovered = await reserveTreeBudgetHandle(recoveredSession, 2, target, identity, 10)
    expect(recovered).toMatchObject({
      status: 'reserved',
      existing: true,
      durableStatus: 'held',
      handle: { permitId: first.handle.permitId, requestHash: first.handle.requestHash },
    })
    expect((await storage.projectTree('s:main:0'))?.heldMicro).toBe(2_000_000n)
    if (recovered.status === 'reserved')
      await releaseTreeReservationHandle(recoveredSession, recovered.handle)
    await recoveredKernel.close()
  })

  it('requires durable reconciliation after ambiguous release and settlement failures', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const release = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:release-failure',
      requestHash: '8'.repeat(64),
    })
    const settle = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:settle-failure',
      requestHash: '9'.repeat(64),
    })
    if (release.status !== 'reserved' || settle.status !== 'reserved') return

    const durableRelease = storage.releaseReservation.bind(storage)
    storage.releaseReservation = async () => {
      throw new Error('release transport failed before write')
    }
    await expect(releaseTreeReservationHandle(session, release.handle)).rejects.toThrow('transport failed')
    await expect(releaseTreeReservationHandle(session, release.handle)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(reconcileTreeReservationHandle(session, release.handle)).resolves.toEqual({ status: 'held' })
    storage.releaseReservation = durableRelease
    await releaseTreeReservationHandle(session, release.handle)

    const durableSettle = storage.settleOrigin.bind(storage)
    storage.settleOrigin = async () => {
      throw new Error('settle transport failed before write')
    }
    await expect(settleTreeSpendHandle(session, settle.handle, 1, 10 as Seq)).rejects.toThrow(
      'transport failed',
    )
    await expect(settleTreeSpendHandle(session, settle.handle, 1, 10 as Seq)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(reconcileTreeReservationHandle(session, settle.handle)).resolves.toEqual({ status: 'held' })
    storage.settleOrigin = durableSettle
    await settleTreeSpendHandle(session, settle.handle, 1, 10 as Seq)
    await kernel.close()
  })

  it('reconciles a settlement rejection that happened after the durable write', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const reserved = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:settle-after-write',
      requestHash: 'c'.repeat(64),
    })
    if (reserved.status !== 'reserved') return
    const durableSettle = storage.settleOrigin.bind(storage)
    storage.settleOrigin = async (request) => {
      await durableSettle(request)
      throw new Error('settle acknowledgement lost')
    }

    await expect(settleTreeSpendHandle(session, reserved.handle, 1, 11 as Seq)).rejects.toThrow(
      'acknowledgement lost',
    )
    await expect(reconcileTreeReservationHandle(session, reserved.handle)).resolves.toEqual({
      status: 'settled',
    })
    await expect(settleTreeSpendHandle(session, reserved.handle, 1, 11 as Seq)).resolves.toBeUndefined()
    await kernel.close()
  })

  it('rejects unsafe settlement numbers before touching the durable hold', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const reserved = await reserveTreeBudgetHandle(session, 1, target, {
      effectId: 'aux:invalid-settlement',
      requestHash: 'b'.repeat(64),
    })
    if (reserved.status !== 'reserved') return
    await expect(settleTreeSpendHandle(session, reserved.handle, 1, 0 as Seq)).rejects.toThrow(
      'origin sequence is invalid',
    )
    await expect(settleTreeSpendHandle(session, reserved.handle, Number.NaN, 1 as Seq)).rejects.toThrow(
      'settlement credits are invalid',
    )
    expect(await storage.peekReservation?.(reserved.handle.permitId)).toMatchObject({ status: 'held' })
    await releaseTreeReservationHandle(session, reserved.handle)
    await kernel.close()
  })

  it('rejects malformed or credential-bearing audit identities before creating a hold', async () => {
    const { kernel } = setup()
    const session = await kernel.session('s', sessionOpts)
    const invalid = [
      { effectId: '', requestHash: 'a'.repeat(64) },
      { effectId: 'x'.repeat(129), requestHash: 'a'.repeat(64) },
      { effectId: 'aux\ncontrol', requestHash: 'a'.repeat(64) },
      { effectId: 'Authorization:Bearer-token', requestHash: 'a'.repeat(64) },
      { effectId: 'sk-sensitivevalue', requestHash: 'a'.repeat(64) },
      { effectId: 'aux:valid', requestHash: 'A'.repeat(64) },
      { effectId: 'aux:valid', requestHash: 'short' },
    ]
    for (const identity of invalid)
      await expect(reserveTreeBudgetHandle(session, 1, target, identity)).rejects.toThrow(
        'audit identity is invalid',
      )
    await kernel.close()
  })

  it('fails closed at the cap without consuming the primary permit', async () => {
    const { kernel } = setup()
    const session = await kernel.session('s', sessionOpts)
    const endTurn = vi.spyOn(session, 'endTurn')
    setTreePermit(session, { permitId: 'primary', requestHash: 'primary-hash' })

    await expect(
      reserveTreeBudgetHandle(session, 11, target, {
        effectId: 'aux:blocked',
        requestHash: '5'.repeat(64),
      }),
    ).resolves.toEqual({ status: 'blocked', reason: 'budget' })
    await expect(
      reserveTreeBudgetHandle(session, Number.NaN, target, {
        effectId: 'aux:nan',
        requestHash: '6'.repeat(64),
      }),
    ).resolves.toEqual({ status: 'blocked', reason: 'budget' })
    await expect(
      reserveTreeBudgetHandle(session, -1, target, {
        effectId: 'aux:negative',
        requestHash: 'd'.repeat(64),
      }),
    ).resolves.toEqual({ status: 'blocked', reason: 'budget' })
    expect(endTurn).not.toHaveBeenCalled()
    expect(treePermitOf(session)).toEqual({ permitId: 'primary', requestHash: 'primary-hash' })
    await kernel.close()
  })

  it('preserves the legacy primary reservation turn-ending behavior', async () => {
    const { kernel } = setup()
    const session = await kernel.session('s', sessionOpts)
    const endTurn = vi.spyOn(session, 'endTurn')

    await expect(reserveTreeBudget(session, 11, target)).resolves.toEqual({ reason: 'budget' })
    expect(endTurn).toHaveBeenCalledOnce()
    expect(endTurn).toHaveBeenCalledWith('budget')
    await kernel.close()
  })

  it('keeps legacy child control usable while explicit handles fail closed without recovery capabilities', async () => {
    const backing = new MemoryStorage()
    const unavailable = new Set([
      'lookupReservationByIdentity',
      'peekReservation',
      'writerGeneration',
      'takeoverReservation',
    ])
    const legacy = new Proxy(backing, {
      get(target, property, receiver) {
        if (typeof property === 'string' && unavailable.has(property)) return undefined
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const { kernel } = setup(legacy)
    const session = await kernel.session('s', sessionOpts)

    await expect(reserveTreeBudget(session, 1, target)).resolves.toBe('ok')
    await expect(
      reserveTreeBudgetHandle(session, 1, target, {
        effectId: 'aux:no-durable-recovery',
        requestHash: 'e'.repeat(64),
      }),
    ).rejects.toThrow('durable explicit tree reservations are unavailable')
    await kernel.close()
  })

  it('does not require durable reservation capabilities outside a configured or inherited tree', async () => {
    const backing = new MemoryStorage()
    const legacy = new Proxy(backing, {
      get(target, property, receiver) {
        if (
          property === 'lookupReservationByIdentity' ||
          property === 'peekReservation' ||
          property === 'writerGeneration' ||
          property === 'takeoverReservation'
        )
          return undefined
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const { kernel } = setup(legacy, null)
    const session = await kernel.session('outside-tree', sessionOpts)

    await expect(
      reserveTreeBudgetHandle(session, 1, target, {
        effectId: 'aux:no-tree',
        requestHash: 'b'.repeat(64),
      }),
    ).resolves.toEqual({ status: 'unreserved' })
    await kernel.close()
  })

  it('returns terminal non-dispatch states after release, settlement, and unknown spend', async () => {
    const { kernel } = setup()
    const session = await kernel.session('s', sessionOpts)
    const cases = [
      { effectId: 'aux:terminal-release', hash: '1'.repeat(64), credits: 'release' as const },
      { effectId: 'aux:terminal-settle', hash: '2'.repeat(64), credits: 1 },
      { effectId: 'aux:terminal-unknown', hash: '3'.repeat(64), credits: undefined },
    ]
    for (const [index, item] of cases.entries()) {
      const identity = { effectId: item.effectId, requestHash: item.hash }
      const held = await reserveTreeBudgetHandle(session, 1, target, identity)
      if (held.status !== 'reserved') throw new Error('expected reservation')
      if (item.credits === 'release') await releaseTreeReservationHandle(session, held.handle)
      else await settleTreeSpendHandle(session, held.handle, item.credits, (20 + index) as Seq)
      await expect(reserveTreeBudgetHandle(session, 1, target, identity)).resolves.toMatchObject({
        status: 'terminal',
        durableStatus:
          item.credits === 'release' ? 'released' : item.credits === undefined ? 'unknown' : 'settled',
      })
    }
    await kernel.close()
  })

  it('fences old handles after explicit writer takeover without bumping ordinary retries', async () => {
    const { kernel, storage } = setup()
    const session = await kernel.session('s', sessionOpts)
    const identity = { effectId: 'aux:fenced', requestHash: 'f'.repeat(64) }
    const held = await reserveTreeBudgetHandle(session, 1, target, identity)
    if (held.status !== 'reserved') throw new Error('expected reservation')
    const siblingIdentity = { effectId: 'aux:fenced-sibling', requestHash: 'a'.repeat(64) }
    const sibling = await reserveTreeBudgetHandle(session, 1, target, siblingIdentity)
    if (sibling.status !== 'reserved') throw new Error('expected sibling reservation')
    const retry = await reserveTreeBudgetHandle(session, 1, target, identity)
    if (retry.status !== 'reserved') throw new Error('expected retry')
    expect(retry.handle.writerGeneration).toBe(held.handle.writerGeneration)

    const takenOver = await takeoverTreeReservationWriter(session, held.handle)
    expect(takenOver).toMatchObject({
      permitId: held.handle.permitId,
      writerGeneration: 2,
    })
    const takeoverRetry = await reserveTreeBudgetHandle(session, 1, target, identity)
    if (takeoverRetry.status !== 'reserved') throw new Error('expected taken-over retry')
    expect(takeoverRetry.handle).toBe(takenOver)
    await expect(releaseTreeReservationHandle(session, held.handle)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(settleTreeSpendHandle(session, held.handle, 1, 30 as Seq)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(releaseTreeReservationHandle(session, sibling.handle)).rejects.toThrow(
      'requires reconciliation',
    )
    await expect(settleTreeSpendHandle(session, takenOver, 1, 30 as Seq)).resolves.toBeUndefined()
    await kernel.close()

    const recoveredKernel = setup(storage).kernel
    const recoveredSession = await recoveredKernel.session('s', sessionOpts)
    const recoveredSibling = await reserveTreeBudgetHandle(recoveredSession, 1, target, siblingIdentity)
    if (recoveredSibling.status !== 'reserved') throw new Error('expected sibling recovery')
    expect(recoveredSibling.handle.writerGeneration).toBe(2)
    await releaseTreeReservationHandle(recoveredSession, recoveredSibling.handle)
    await recoveredKernel.close()
  })
})
