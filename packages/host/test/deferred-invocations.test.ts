import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultLoopPlugin } from '@agnes/base'
import { Context } from '@agnes/cordis'
import { CoreError, MemoryStorage, SessionLogImpl } from '@agnes/core'
import { defaultIds } from '@agnes/core-common/ids'
import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import type { LoopContext, LoopFactory, ToolResult } from '@agnes/extension-api'
import { loopKind } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import {
  createDeferredInvocationQueue,
  DEFERRED_INVOCATION_EVENT,
  type DeferredInvocationLedgerPort,
  DeferredInvocationsService,
  ownerDeferredQueue,
} from '@agnes/host-providers/assemble/deferred-invocations'
import { defaultLoopFactory } from '@agnes/loop-default'
import { hashDirectory, type RuntimePluginSnapshot } from '@agnes/package-manager'
import { defineAgnesPlugin, drainDeferredToolInvocations } from '@agnes/plugin-runtime'
import {
  type DeferredActor,
  type DeferredInvocationReceipt,
  type DeferredToolInvocation,
  deferredQueueKind,
} from '@agnes/plugin-runtime/deferred-contract'
import type { Actor, DecisionSnapshot, EventEnvelope, JsonValue, UiSurface } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { assertMigrationSettled } from '../src/runtime/generation/migration-state.js'
import { deferredQueueFor } from '../src/runtime/sessions/deferred-invocations.js'
import { createTestHost } from '../testkit/index.js'
import { fixtureTool } from './fixtures/tool.js'

const actor: Actor = { id: 'human', org: 'local', role: 'owner', deptPath: [], attrs: {} }
const signal = new AbortController().signal
const call: DeferredToolInvocation = {
  id: 'deferred:test:1',
  sessionKey: 's',
  lane: 'main',
  source: 'test',
  sourceSeq: 1,
  actor,
  tool: 'business_adjust',
  args: { cents: 100 },
}

async function fixture() {
  const storage = new MemoryStorage()
  let log = await SessionLogImpl.open({
    storage,
    key: 's',
    writerRunId: 'writer',
    ttlMs: 30000,
    ids: defaultIds(),
    clock: Date.now,
  })
  await log.append([
    {
      type: 'x/test/source',
      data: {},
      actor,
      origin: 'system',
      trust: 'trusted',
      lane: 'main',
      ignorable: true,
    },
  ])
  const changed: DeferredInvocationReceipt[] = []
  const effects = new Map<string, { resultSeq?: number; approvalId?: string; result?: ToolResult }>()
  let rejectNotification = false
  let failNextWake = false
  let wakes = 0
  const ports: DeferredInvocationLedgerPort = {
    scan: async () => (await log.scan({ toSeq: log.lastSeq, limit: 500 })) as EventEnvelope[],
    append: async (type, data, by, sourceSeq) =>
      (
        await log.append([
          {
            type,
            data,
            actor: by,
            origin: 'system',
            trust: 'trusted',
            lane: 'main',
            ignorable: true,
            ...(sourceSeq ? { sourceEventSeqs: [sourceSeq] } : {}),
          },
        ])
      ).seqs[0]!,
    outcome: async (id) => effects.get(id) ?? {},
    wake: async () => {
      wakes += 1
      if (failNextWake) {
        failNextWake = false
        throw new Error('Wake interrupted')
      }
    },
  }
  const producer = {
    source: 'test',
    validate: async (value: DeferredToolInvocation) => {
      if (value.tool !== 'business_adjust') throw new Error('Not in the session tool catalog')
    },
    changed: async (receipt: DeferredInvocationReceipt) => {
      if (rejectNotification && (receipt.state === 'succeeded' || receipt.state === 'failed'))
        throw new Error('Delivery interrupted')
      changed.push(receipt)
    },
  }
  const queue = () => createDeferredInvocationQueue('s', 'main', ports, () => producer)
  const executed: string[] = []
  const ctx = (q = queue(), park = false, unknown = false) =>
    ({
      sessionKey: 's',
      lane: 'main',
      services: {
        get: async (kind: unknown) => (kind === deferredQueueKind ? q : undefined),
      },
      turn: { continuation: () => 'model', cancelled: () => false },
      effects: {
        status: async (id: string) =>
          effects.get(id)?.result
            ? { status: 'responded', invocationId: id, result: effects.get(id)!.result, checkpoint: null }
            : unknown || effects.has(id)
              ? { status: 'may-have-sent', invocationId: id, checkpoint: null }
              : { status: 'not-sent', invocationId: id },
      },
      tools: {
        execute: async ({ invocationId }: { invocationId: string }) => {
          if (effects.get(invocationId)?.result) return effects.get(invocationId)!.result
          if (park) {
            effects.set(invocationId, { approvalId: 'ticket-original' })
            throw Object.assign(new Error('waiting'), { code: 'PARKED' })
          }
          executed.push(invocationId)
          const result = { content: [{ type: 'text' as const, text: 'Adjusted synthetic transaction' }] }
          const resultSeq = await ports.append('x/test/tool-receipt', { invocationId }, actor)
          effects.set(invocationId, { resultSeq, result })
          return result
        },
        resume: async (id: string) => {
          executed.push(id)
          const result = { content: [{ type: 'text' as const, text: 'Approved original call' }] }
          const resultSeq = await ports.append('x/test/tool-receipt', { invocationId: id }, actor)
          effects.set(id, { resultSeq, result, approvalId: 'ticket-original' })
          return result
        },
      },
    }) as unknown as LoopContext
  return {
    queue,
    ctx,
    changed,
    executed,
    effects,
    ports,
    failNotify: () => {
      rejectNotification = true
    },
    allowNotify: () => {
      rejectNotification = false
    },
    failNextWake: () => {
      failNextWake = true
    },
    wakes: () => wakes,
    close: () => log.close(),
    restart: async () => {
      await log.close()
      log = await SessionLogImpl.open({
        storage,
        key: 's',
        writerRunId: 'restart',
        ttlMs: 30000,
        ids: defaultIds(),
        clock: Date.now,
      })
    },
  }
}

it.each(['previous-seq-mismatch', 'invocation-changed', 'not-queued-first', 'terminal-reset'] as const)(
  'diagnoses deferred chain corruption: %s',
  async (reason) => {
    const { ports, rows } = memoryLedger()
    const append = (data: unknown) =>
      ports.append(DEFERRED_INVOCATION_EVENT, JSON.parse(JSON.stringify(data)), actor)
    let seq: number
    if (reason === 'not-queued-first') {
      seq = await append({ invocation: call, state: 'running' })
    } else {
      const first = await append({ invocation: call, state: 'queued' })
      const previousSeq =
        reason === 'terminal-reset'
          ? await append({ invocation: call, state: 'succeeded', previousSeq: first })
          : first
      seq = await append({
        invocation: reason === 'invocation-changed' ? { ...call, args: { cents: 101 } } : call,
        state: reason === 'terminal-reset' ? 'queued' : 'running',
        previousSeq: reason === 'previous-seq-mismatch' ? first + 100 : previousSeq,
      })
    }
    const queue = createDeferredInvocationQueue('s', 'main', ports, () => undefined)
    const diagnostic = {
      code: 'E_LEDGER_INTEGRITY',
      detail: {
        kind: 'deferred-invocation-chain',
        sessionKey: 's',
        lane: 'main',
        invocationId: call.id,
        seq,
        reason,
      },
    }
    await expect(queue.next(signal)).rejects.toBeInstanceOf(CoreError)
    await expect(queue.read(call.id, signal)).rejects.toMatchObject(diagnostic)
    await expect(queue.enqueue(call, signal)).rejects.toMatchObject(diagnostic)
    try {
      await queue.next(signal)
    } catch (error) {
      expect((error as Error).message).toContain(reason)
      expect((error as Error).message).toContain(call.id)
      expect((error as Error).message).toContain(`"seq":${seq}`)
    }
    expect(rows).toHaveLength(seq)
  },
)

it('deduplicates canonical bindings across restart and validates session/tool ownership', async () => {
  const f = await fixture()
  try {
    const first = await f.queue().enqueue(call, signal)
    expect(await f.queue().enqueue({ ...call, args: { cents: 100 } }, signal)).toEqual(first)
    await expect(f.queue().enqueue({ ...call, args: { cents: 101 } }, signal)).rejects.toThrow('conflicts')
    await expect(
      f.queue().enqueue({ ...call, id: 'wrong-session', sessionKey: 'other' }, signal),
    ).rejects.toThrow('Invalid')
    await expect(f.queue().enqueue({ ...call, id: 'hidden-tool', tool: 'hidden' }, signal)).rejects.toThrow(
      'catalog',
    )
    await f.restart()
    expect(await f.queue().read(call.id, signal)).toEqual(first)
  } finally {
    await f.close()
  }
})

it('recovers the original approved invocation and delivers its result without another dispatch', async () => {
  const f = await fixture()
  try {
    const q = f.queue()
    await q.enqueue(call, signal)
    expect(await drainDeferredToolInvocations(f.ctx(q, true), signal)).toMatchObject({ outcome: 'parked' })
    expect(await q.read(call.id, signal)).toMatchObject({
      state: 'pending-approval',
      approvalId: 'ticket-original',
    })
    await f.restart()
    const recovered = f.queue()
    expect(await drainDeferredToolInvocations(f.ctx(recovered), signal)).toMatchObject({ outcome: 'running' })
    expect(await recovered.read(call.id, signal)).toMatchObject({
      state: 'succeeded',
      result: { content: [{ text: 'Approved original call' }] },
    })
    expect(await drainDeferredToolInvocations(f.ctx(recovered), signal)).toBeNull()
    expect(f.executed).toEqual([call.id])
  } finally {
    await f.close()
  }
})

it('retries notification after a durable outcome and refuses uncertain effects without replay', async () => {
  const f = await fixture()
  try {
    const q = f.queue()
    await q.enqueue(call, signal)
    await q.notify(signal)
    f.failNotify()
    await expect(drainDeferredToolInvocations(f.ctx(q), signal)).rejects.toThrow('Delivery interrupted')
    expect(await q.read(call.id, signal)).toMatchObject({ state: 'succeeded' })
    await f.restart()
    f.allowNotify()
    expect(await drainDeferredToolInvocations(f.ctx(), signal)).toBeNull()
    expect(f.executed).toEqual([call.id])
    const uncertain = { ...call, id: 'uncertain' }
    const restored = f.queue()
    const received = await restored.enqueue(uncertain, signal)
    await restored.transition(uncertain.id, received.seq, 'executing')
    await drainDeferredToolInvocations(f.ctx(restored, false, true), signal)
    expect(await restored.read(uncertain.id, signal)).toMatchObject({
      state: 'failed',
      error: { outcomeUnknown: true, retryable: false },
    })
    expect(f.executed).toEqual([call.id])
  } finally {
    await f.close()
  }
})

it('leaves the default scheduler unchanged without a producing plugin and ignores cancelled work', async () => {
  const f = await fixture()
  try {
    const context = f.ctx()
    const admitted = await context.services!.get(deferredQueueKind)
    await admitted!.enqueue(call, signal)
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(drainDeferredToolInvocations(context, cancelled.signal)).rejects.toThrow()
    expect(f.executed).toEqual([])
    const bare = {
      ...context,
      services: undefined,
      input: { resumeParked: async () => false, claim: async () => null },
      turn: { continuation: () => null },
    } as unknown as LoopContext
    let factory: LoopFactory | undefined
    defaultLoopPlugin.apply({
      providers: {
        register: (_kind: unknown, value: LoopFactory) => {
          factory = value
          return async () => undefined
        },
      },
    } as unknown as import('@agnes/extension-api').ProviderPluginContext)
    const driver = await factory!.create(bare)
    expect(await driver.step(signal)).toEqual({ outcome: 'idle', phase: 'idle' })
    await driver.dispose()
  } finally {
    await f.close()
  }
})

it('settles an original rejected approval after restart even when no turn reopens', async () => {
  const f = await fixture()
  try {
    const queue = f.queue()
    await queue.enqueue(call, signal)
    await drainDeferredToolInvocations(f.ctx(queue, true), signal)
    await f.restart()
    const restored = f.queue(),
      context = f.ctx(restored)
    const result = {
      content: [{ type: 'text' as const, text: 'Denied' }],
      isError: true,
      details: { code: 'APPROVAL_REJECTED' },
    }
    Object.assign(context, {
      turn: { continuation: () => null, cancelled: () => false },
      input: {
        resumeParked: async () => {
          const resultSeq = await f.ports.append('x/test/tool-receipt', { invocationId: call.id }, actor)
          f.effects.set(call.id, { resultSeq, result, approvalId: 'ticket-original' })
          return 'blocked'
        },
      },
    })
    await drainDeferredToolInvocations(context, signal)
    expect(await restored.read(call.id, signal)).toMatchObject({
      state: 'failed',
      approvalId: 'ticket-original',
      error: { code: 'APPROVAL_REJECTED', outcomeUnknown: false },
    })
    expect(f.executed).toEqual([])
    expect(f.changed.at(-1)).toMatchObject({ state: 'failed' })
  } finally {
    await f.close()
  }
})

it('keeps the raw deferred queue off a plugin context', async () => {
  const root = new Context()
  const owner = root.extend()
  const service = new DeferredInvocationsService(owner, { lookup: () => undefined })
  const producer = { source: 'fixture', validate: async () => {}, changed: async () => {} }
  const { ports } = memoryLedger()
  try {
    const off = service.register(producer)
    expect(() => service.register(producer)).toThrow('Duplicate')
    off()
    const release = service.register(producer)
    service.bind('s', 'main', ports)
    const raw = service.forSession('s', 'main')
    const receipt = await raw!.enqueue({ ...call, source: 'fixture' }, signal)
    const foreign = service.ownerFacade('s', 'main', {
      owner: 'other',
      actor,
      confirmSource: async () => undefined,
    })
    let listed = true
    let visible: unknown = 'present'
    let refused: unknown
    const plugin = owner.plugin(async (ctx) => {
      listed = 'deferredInvocations' in ctx
      try {
        visible = (ctx as { deferredInvocations?: unknown }).deferredInvocations
      } catch {
        visible = undefined
      }
      try {
        await foreign!.read(receipt.invocation.id, signal)
      } catch (error) {
        refused = error
      }
    })
    await plugin
    expect(listed).toBe(false)
    expect(visible).toBeUndefined()
    expect(String(refused)).toContain('another producer')
    expect(await raw!.read(receipt.invocation.id, signal)).toMatchObject({ state: 'queued' })
    release()
  } finally {
    await root.fiber.dispose()
  }
})

it('pins a plugin registration to the verified package id', async () => {
  const root = new Context()
  const origin = {
    trustTier: 'third-party' as const,
    packageId: 'pkg.alpha',
    snapshotId: 'snap',
    rowId: 'row',
    exportName: 'default',
    declaredProvides: [] as readonly string[],
  }
  let service: DeferredInvocationsService | undefined
  let mismatch: unknown
  try {
    const plugin = root.plugin((ctx) => {
      const registry = new DeferredInvocationsService(ctx, {
        lookup: (fiber) => (fiber === ctx.fiber ? origin : undefined),
      })
      service = registry
      try {
        registry.register({
          source: 'forged',
          validate: async () => undefined,
          changed: async () => undefined,
        })
      } catch (error) {
        mismatch = error
      }
      registry.register({
        source: 'pkg.alpha',
        validate: async () => undefined,
        changed: async () => undefined,
      })
    })
    await plugin
    expect(mismatch).toMatchObject({ code: 'E_EXT_LOAD' })
    expect(String(mismatch)).toContain('does not match')
    const { ports } = memoryLedger()
    service!.bind('s', 'main', ports)
    const queue = service!.forSession('s', 'main')
    await expect(queue!.enqueue({ ...call, source: 'forged' }, signal)).rejects.toThrow(
      'producer is unavailable',
    )
    await queue!.enqueue({ ...call, id: 'pinned', source: 'pkg.alpha' }, signal)
    expect((await queue!.read('pinned', signal))?.invocation.source).toBe('pkg.alpha')
  } finally {
    await root.fiber.dispose()
  }
})

function memoryLedger() {
  const rows: EventEnvelope[] = []
  const effects = new Map<string, { resultSeq?: number; approvalId?: string; result?: ToolResult }>()
  let seq = 0
  const ports: DeferredInvocationLedgerPort = {
    scan: async () => rows,
    append: async (type, data, by, sourceSeq) => {
      seq += 1
      rows.push({
        seq,
        id: `row-${seq}`,
        type,
        data,
        actor: by,
        origin: 'system',
        trust: 'trusted',
        lane: 'main',
        ts: new Date(seq).toISOString(),
        ignorable: true,
        ...(sourceSeq ? { sourceEventSeqs: [sourceSeq] } : {}),
      })
      return seq
    },
    outcome: async (id) => effects.get(id) ?? {},
    wake: async () => undefined,
  }
  return { ports, effects, rows }
}

function ownerCall(source: string, id: string, by: Actor): DeferredToolInvocation {
  return { ...call, id, source, actor: by }
}

it('keeps each producer inside its own invocations', async () => {
  const { ports, effects } = memoryLedger()
  const changed: string[] = []
  const producers = new Map([
    [
      'alpha',
      {
        source: 'alpha',
        validate: async (value: DeferredToolInvocation) => {
          if (value.tool !== 'business_adjust') throw new Error('Not in the session tool catalog')
        },
        changed: async () => {
          changed.push('alpha')
        },
      },
    ],
    [
      'beta',
      {
        source: 'beta',
        validate: async () => undefined,
        changed: async () => {
          changed.push('beta')
        },
      },
    ],
  ])
  const raw = createDeferredInvocationQueue('s', 'main', ports, (source) => producers.get(source))
  const sourceChecks = new Map<string, number>()
  const admit = (owner: string, by: DeferredActor) => ({
    owner,
    actor: by,
    confirmSource: async (seq: number, source: string) => {
      sourceChecks.set(owner, (sourceChecks.get(owner) ?? 0) + 1)
      if (source !== owner || seq !== 1) throw new Error('Deferred invocation source event is missing')
    },
  })
  const alpha = ownerDeferredQueue(raw, admit('alpha', actor))
  const betaActor: Actor = { ...actor, id: 'other-human' }
  const beta = ownerDeferredQueue(raw, admit('beta', betaActor))
  const first = await alpha.enqueue(ownerCall('alpha', 'owned-by-alpha', actor), signal)
  expect(sourceChecks.get('alpha')).toBe(1)
  await alpha.enqueue(ownerCall('alpha', 'owned-by-alpha', actor), signal)
  expect(sourceChecks.get('alpha')).toBe(1)
  expect(await beta.next(signal)).toBeNull()
  await expect(beta.read(first.invocation.id, signal)).rejects.toThrow('another producer')
  await expect(beta.transition(first.invocation.id, first.seq, 'executing')).rejects.toThrow(
    'another producer',
  )
  expect(await raw.read(first.invocation.id, signal)).toMatchObject({ state: 'queued', seq: first.seq })
  await expect(beta.enqueue(ownerCall('alpha', 'forged-source', betaActor), signal)).rejects.toThrow(
    'another producer',
  )
  await expect(
    alpha.enqueue({ ...ownerCall('alpha', 'forged-actor', actor), actor: betaActor }, signal),
  ).rejects.toThrow('actor does not match')
  await expect(
    alpha.enqueue({ ...ownerCall('alpha', 'forged-seq', actor), sourceSeq: 99 }, signal),
  ).rejects.toThrow('source event is missing')
  await expect(alpha.transition(first.invocation.id, 999, 'failed')).rejects.toThrow('stale')
  expect(await raw.read(first.invocation.id, signal)).toMatchObject({ state: 'queued' })
  const trusted = { content: [{ type: 'text' as const, text: 'original' }] }
  effects.set(first.invocation.id, { resultSeq: 8, result: trusted })
  await expect(
    alpha.transition(first.invocation.id, first.seq, 'succeeded', {
      result: { content: [{ type: 'text' as const, text: 'forged' }] },
    }),
  ).rejects.toThrow('does not match its durable result')
  expect(await raw.read(first.invocation.id, signal)).toMatchObject({ state: 'queued' })
  await beta.notify(signal)
  expect(changed).toEqual([])
  await alpha.notify(signal)
  expect(changed).toEqual(['alpha'])
  const second = await beta.enqueue(ownerCall('beta', 'owned-by-beta', betaActor), signal)
  await alpha.notify(signal)
  expect(changed).toEqual(['alpha'])
  await beta.notify(signal)
  expect(changed).toEqual(['alpha', 'beta'])
  await raw.notify(signal)
  expect(changed).toEqual(['alpha', 'beta'])
  expect(second.invocation.source).toBe('beta')
  await expect(alpha.read(second.invocation.id, signal)).rejects.toThrow('another producer')
  expect((await alpha.next(signal))?.invocation.id).toBe('owned-by-alpha')
  expect(await beta.next(signal)).toBeNull()
})

it('keeps an older generation queue on its original producer', async () => {
  const root = new Context()
  const older = new DeferredInvocationsService(root.extend(), { lookup: () => undefined })
  const newer = new DeferredInvocationsService(root.extend(), { lookup: () => undefined })
  const seen: string[] = []
  const producer = (name: string) => ({
    source: 'fixture',
    validate: async () => {
      seen.push(name)
    },
    changed: async () => {
      seen.push(`${name}-changed`)
    },
  })
  try {
    older.register(producer('old'))
    newer.register(producer('new'))
    older.bind('s', 'main', memoryLedger().ports)
    const queue = older.forSession('s', 'main')
    await queue!.enqueue({ ...call, source: 'fixture' }, signal)
    expect(newer.forSession('s', 'main')).toBeUndefined()
    await queue!.notify(signal)
    expect(seen).toEqual(['old', 'old-changed'])
    newer.bind('s', 'main', memoryLedger().ports)
    await newer.forSession('s', 'main')!.enqueue({ ...call, id: 'new-generation', source: 'fixture' }, signal)
    expect(seen).toEqual(['old', 'old-changed', 'new'])
    expect((await queue!.read(call.id, signal))?.invocation.source).toBe('fixture')
  } finally {
    await root.fiber.dispose()
  }
})

it('repairs wake and notification after close and cold resume', async () => {
  const f = await fixture()
  try {
    f.failNextWake()
    await expect(f.queue().enqueue(call, signal)).rejects.toThrow('Wake interrupted')
    expect(await f.queue().read(call.id, signal)).toMatchObject({ state: 'queued' })
    expect(f.wakes()).toBe(1)
    await f.restart()
    const restored = f.queue()
    const again = await restored.enqueue(call, signal)
    expect(again.state).toBe('queued')
    expect(f.wakes()).toBe(2)
    await restored.transition(call.id, again.seq, 'failed', {
      error: { code: 'DEFERRED_NOT_DISPATCHED', message: 'closed', outcomeUnknown: false, retryable: true },
    })
    f.failNotify()
    await expect(restored.notify(signal)).rejects.toThrow('Delivery interrupted')
    expect(f.changed).toEqual([])
    await f.restart()
    f.allowNotify()
    await f.queue().notify(signal)
    expect(f.changed.at(-1)).toMatchObject({ state: 'failed', invocation: { id: call.id } })
  } finally {
    await f.close()
  }
})

it('does not repeat an executing, approved, or unknown effect', async () => {
  const f = await fixture()
  try {
    const queue = f.queue()
    const received = await queue.enqueue(call, signal)
    await queue.transition(call.id, received.seq, 'executing')
    const result = { content: [{ type: 'text' as const, text: 'Already recorded' }] }
    const resultSeq = await f.ports.append('x/test/tool-receipt', { invocationId: call.id }, actor)
    f.effects.set(call.id, { resultSeq, result })
    expect(await drainDeferredToolInvocations(f.ctx(queue), signal)).toMatchObject({ outcome: 'running' })
    expect(f.executed).toEqual([])
    expect(await queue.read(call.id, signal)).toMatchObject({ state: 'succeeded' })
    expect(await drainDeferredToolInvocations(f.ctx(queue), signal)).toBeNull()
  } finally {
    await f.close()
  }
  const parked = await fixture()
  try {
    const parkedQueue = parked.queue()
    await parkedQueue.enqueue({ ...call, id: 'parked-once' }, signal)
    expect(await drainDeferredToolInvocations(parked.ctx(parkedQueue, true), signal)).toMatchObject({
      outcome: 'parked',
    })
    expect(await parkedQueue.read('parked-once', signal)).toMatchObject({
      state: 'pending-approval',
      approvalId: 'ticket-original',
    })
    expect(parked.executed).toEqual([])
  } finally {
    await parked.close()
  }
  const unknown = await fixture()
  try {
    const unknownQueue = unknown.queue()
    const queued = await unknownQueue.enqueue({ ...call, id: 'unknown-once' }, signal)
    await unknownQueue.transition('unknown-once', queued.seq, 'executing')
    await drainDeferredToolInvocations(unknown.ctx(unknownQueue, false, true), signal)
    expect(await unknownQueue.read('unknown-once', signal)).toMatchObject({
      state: 'failed',
      error: { outcomeUnknown: true, retryable: false },
    })
    expect(unknown.executed).toEqual([])
    expect(await drainDeferredToolInvocations(unknown.ctx(unknownQueue, false, true), signal)).toBeNull()
  } finally {
    await unknown.close()
  }
})

it('keeps a bound queue after its producer unloads', async () => {
  const root = new Context()
  const service = new DeferredInvocationsService(root.extend(), { lookup: () => undefined })
  const { ports } = memoryLedger()
  const releaseProducer = service.register({
    source: 'test',
    validate: async () => undefined,
    changed: async () => undefined,
  })
  try {
    service.bind('s', 'main', ports)
    const queue = service.forSession('s', 'main')
    await queue!.enqueue(call, signal)
    releaseProducer()
    expect(service.forSession('s', 'main')).toBe(queue)
    await expect(queue!.enqueue({ ...call, id: 'after-unload' }, signal)).rejects.toThrow(
      'producer is unavailable',
    )
    await expect(queue!.notify(signal)).rejects.toThrow('producer is unavailable during recovery')
    expect(await queue!.read(call.id, signal)).toMatchObject({ state: 'queued' })
  } finally {
    await root.fiber.dispose()
  }
})

async function migrationLog() {
  const storage = new MemoryStorage()
  const log = await SessionLogImpl.open({
    storage,
    key: 's',
    writerRunId: 'migration',
    ttlMs: 30000,
    ids: defaultIds(),
    clock: Date.now,
  })
  return {
    storage,
    log,
    async append(state: string, id = call.id) {
      await log.append([
        {
          type: DEFERRED_INVOCATION_EVENT,
          data: { invocation: { ...call, id }, state },
          actor,
          origin: 'system',
          trust: 'trusted',
          lane: 'main',
          ignorable: true,
        },
      ])
    },
    close: () => log.close(),
  }
}

it('refuses migration while deferred work is unfinished and allows a terminal receipt', async () => {
  const pending = await migrationLog()
  try {
    await assertMigrationSettled(pending.storage, 's', 'generation')
    await expect(assertMigrationSettled(pending.storage, 's', 'generation', true)).rejects.toBeInstanceOf(
      HostError,
    )
    await pending.append('queued')
    await expect(assertMigrationSettled(pending.storage, 's', 'generation')).rejects.toMatchObject({
      code: 'E_GENERATION_EXECUTION_UNSETTLED',
    })
    await expect(assertMigrationSettled(pending.storage, 's', 'generation')).rejects.toThrow(
      'unfinished-deferred-invocation',
    )
  } finally {
    await pending.close()
  }
  for (const state of ['executing', 'pending-approval'] as const) {
    const open = await migrationLog()
    try {
      await open.append(state)
      await expect(assertMigrationSettled(open.storage, 's', 'generation')).rejects.toThrow(
        'unfinished-deferred-invocation',
      )
    } finally {
      await open.close()
    }
  }
  const done = await migrationLog()
  try {
    await done.append('succeeded', 'finished')
    await assertMigrationSettled(done.storage, 's', 'generation')
  } finally {
    await done.close()
  }
})

it('keeps pending and answered but unconsumed decisions on their original generation pin', async () => {
  const f = await migrationLog()
  const subject = { text: 'Complete review content' }
  const snapshot: DecisionSnapshot = {
    handle: { id: 'review', sessionId: 's' },
    revision: 1,
    request: {
      spec: {
        key: 'review',
        purpose: 'business.confirm',
        subject,
        prompt: 'Continue?',
        options: ['continue', 'reject'],
      },
      subjectDigest: sha256Hex(canonicalJson(subject)),
      owner: 'community.review',
      sourcePackage: '@community/review',
      packageVersion: '1.0.0',
      operationId: 'loop:community.review',
      requestedBy: actor,
      lane: 'main',
      createdAt: '2030-01-01T00:00:00.000Z',
      expiresAt: '2030-01-02T00:00:00.000Z',
    },
    result: null,
    answerCommand: null,
    consumption: null,
    invalidation: null,
  }
  const append = (value: DecisionSnapshot) =>
    f.log.append([
      {
        type: 'decision/state',
        register: 'decision/state',
        data: value,
        actor,
        origin: 'system',
        trust: 'trusted',
        lane: 'main',
      },
    ])
  try {
    await append(snapshot)
    await expect(assertMigrationSettled(f.storage, 's', 'generation')).rejects.toThrow(
      'pending-decision:review',
    )
    const answered: DecisionSnapshot = {
      ...snapshot,
      revision: 2,
      result: {
        reason: 'answered',
        at: '2030-01-01T01:00:00.000Z',
        response: { option: 'continue', value: null },
        answeredBy: actor,
      },
      answerCommand: { commandId: 'human', digest: 'a'.repeat(64), revision: 2, seq: f.log.lastSeq + 1 },
    }
    await append(answered)
    await expect(assertMigrationSettled(f.storage, 's', 'generation')).rejects.toThrow(
      'pending-decision:review',
    )
    await append({
      ...answered,
      revision: 3,
      invalidation: { at: '2030-01-02T00:00:00.000Z', code: 'deadline' },
    })
    await assertMigrationSettled(f.storage, 's', 'generation')
  } finally {
    await f.close()
  }
})

const toolIntent = {
  effectId: 'effect',
  kind: 'tool',
  replay: 'never',
  tool: { toolUseId: 'call', name: 'read' },
}

function cancelledReceipt(partial?: boolean) {
  return {
    toolUseId: 'call',
    content: [],
    isError: true,
    code: 'CANCELLED',
    enforcement: { level: 'none', scope: [] },
    authz: { decisionId: 'fixture' },
    ...(partial === undefined ? {} : { partial }),
  }
}

async function migrationFacts(events: { type: string; data: JsonValue }[]) {
  const opened = await migrationLog()
  await opened.log.append(
    events.map((event) => ({
      type: event.type,
      data: event.data,
      actor,
      origin: 'system' as const,
      trust: 'trusted' as const,
      lane: 'main',
      ignorable: true,
    })),
  )
  return opened
}

it('refuses migration while a workspace worktree record is creating or removing', async () => {
  const idle = await migrationLog()
  const elsewhere = '/other/workspace'
  try {
    await assertMigrationSettled(idle.storage, 's', 'generation', false, {
      workspaceRoot: '/workspace',
      records: [{ root: '/workspace', path: '/workspace/.worktrees/agnes-aaaaaaa1', creating: false }],
    })
    await assertMigrationSettled(idle.storage, 's', 'generation', false, {
      workspaceRoot: '/workspace',
      records: [{ root: elsewhere, path: `${elsewhere}/.worktrees/agnes-aaaaaaa2`, creating: true }],
    })
    await expect(
      assertMigrationSettled(idle.storage, 's', 'generation', false, {
        workspaceRoot: '/workspace',
        records: [{ root: '/workspace', path: '/workspace/.worktrees/agnes-aaaaaaa3', creating: true }],
      }),
    ).rejects.toThrow('creating-worktree')
    await expect(
      assertMigrationSettled(idle.storage, 's', 'generation', false, {
        workspaceRoot: '/workspace',
        records: [
          { root: '/workspace/nested', path: '/workspace/nested/.worktrees/agnes-aaaaaaa4', removing: true },
        ],
      }),
    ).rejects.toThrow('removing-worktree')
  } finally {
    await idle.close()
  }
})

it('treats a sent tool cancel as an unknown external outcome', async () => {
  const sent = await migrationFacts([
    { type: 'effect/intent', data: toolIntent },
    { type: 'tool/result', data: cancelledReceipt(true) },
    { type: 'effect/settled', data: { effectId: 'effect', outcome: 'aborted' } },
  ])
  try {
    await expect(assertMigrationSettled(sent.storage, 's', 'generation')).rejects.toMatchObject({
      code: 'E_GENERATION_EXECUTION_UNSETTLED',
      detail: {
        reasons: expect.arrayContaining([
          expect.objectContaining({
            kind: 'unknown-external-outcome',
            id: 'tool:call',
            seq: expect.any(Number),
          }),
        ]),
      },
    })
  } finally {
    await sent.close()
  }
  for (const partial of [false, undefined] as const) {
    const notSent = await migrationFacts([
      { type: 'effect/intent', data: toolIntent },
      { type: 'tool/result', data: cancelledReceipt(partial) },
      { type: 'effect/settled', data: { effectId: 'effect', outcome: 'aborted' } },
    ])
    try {
      await assertMigrationSettled(notSent.storage, 's', 'generation')
    } finally {
      await notSent.close()
    }
  }
  const unproven = await migrationFacts([
    { type: 'effect/intent', data: toolIntent },
    { type: 'effect/settled', data: { effectId: 'effect', outcome: 'aborted' } },
  ])
  try {
    await expect(assertMigrationSettled(unproven.storage, 's', 'generation')).rejects.toThrow(
      'unknown-external-outcome',
    )
  } finally {
    await unproven.close()
  }
  const inference = await migrationFacts([
    { type: 'effect/intent', data: { effectId: 'model', kind: 'inference', replay: 'safe' } },
    { type: 'effect/settled', data: { effectId: 'model', outcome: 'aborted' } },
  ])
  try {
    await assertMigrationSettled(inference.storage, 's', 'generation')
  } finally {
    await inference.close()
  }
  const stillUnknown = await migrationFacts([
    { type: 'effect/settled', data: { effectId: 'effect', outcome: 'unknown' } },
    { type: 'effect/settled', data: { effectId: 'effect', outcome: 'aborted' } },
  ])
  try {
    await expect(assertMigrationSettled(stillUnknown.storage, 's', 'generation')).rejects.toThrow(
      'unknown-external-outcome',
    )
  } finally {
    await stillUnknown.close()
  }
})

it.each(['allowed-once', 'rejected'] as const)(
  'retains the Core decision ticket for a deferred tool across reopen: %s',
  async (verdict) => {
    const root = await mkdtemp(join(tmpdir(), 'agnes-deferred-decision-'))
    const executions: string[] = []
    const notifications = new Map<string, import('@agnes/protocol').SystemInput>()
    const resultActors = new Map<string, Actor>()
    const observe = (ctx: LoopContext): LoopContext =>
      Object.assign(Object.create(ctx), {
        input: {
          ...ctx.input,
          async claim(target: 'next-turn' | 'next-step') {
            const input = await ctx.input.claim(target)
            if (input?.origin === 'system' && input.system) {
              notifications.set(input.id, input.system)
              if (input.system.type === 'action-result') resultActors.set(input.id, input.actor)
            }
            return input
          },
        },
      })
    const loop: LoopFactory = {
      ...defaultLoopFactory,
      id: 'fixture.notifications',
      create: (ctx) => defaultLoopFactory.create(observe(ctx)),
      resume: (ctx, saved) => defaultLoopFactory.resume(observe(ctx), saved),
    }
    const plugin = defineAgnesPlugin({
      inject: ['tools', 'providers'],
      apply(ctx) {
        ctx.providers.registerHost(loopKind, 'fixture/deferred-review', loop)
        ctx.tools.register({
          ...fixtureTool('review_commit'),
          meta: { ...fixtureTool('review_commit').meta, requiresApproval: 'always' },
          async execute() {
            executions.push('committed')
            return { content: [{ type: 'text', text: 'Synthetic change committed' }] }
          },
        })
      },
    })
    const surface: UiSurface = {
      id: 'review',
      revision: 1,
      title: 'Synthetic review',
      placement: { inline: true, workbench: true },
      data: {},
      components: [{ id: 'buttons', kind: 'button-group', actionIds: ['commit'] }],
      actions: [
        {
          id: 'commit',
          label: 'Commit',
          tool: 'review_commit',
          argsTemplate: {},
          paramsSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
      ],
    }
    const packageId = 'fixture/deferred-review'
    const directory = join(root, 'plugin')
    await mkdir(directory)
    await writeFile(join(directory, 'index.mjs'), 'synthetic deferred plugin')
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: packageId,
        version: '1.0.0',
        type: 'module',
        exports: './index.mjs',
        agnes: {
          plugins: [{ export: 'main', apiRange: '^5.0.0', default: true, inject: ['tools', 'providers'] }],
        },
      }),
    )
    const source: RuntimePluginSnapshot = {
      generation: 1,
      trusted: true,
      snapshot: {
        packageId,
        version: '1.0.0',
        snapshotId: `sha256-${'1'.repeat(64)}`,
        integrity: `sha256-${'2'.repeat(64)}`,
        treeIntegrity: hashDirectory(directory, { exclude: [] }),
        capabilityHash: 'fixture',
        directory,
        profile: 'local-dev',
        contributions: [],
      },
    }
    const { host } = await createTestHost({
      dataDir: root,
      disableSessionTitle: true,
      packageDirs: {
        '@agnes/base': fileURLToPath(new URL('../../base', import.meta.url)),
        [packageId]: directory,
      },
      presets: {
        standard: {
          name: 'standard',
          extends: 'base',
          tools: { core: ['tool_describe', 'ui_render', 'review_commit'] },
        },
      },
      lock: {
        packages: Object.fromEntries(
          ['@agnes/ai', '@agnes/base', '@agnes/code', packageId].map((id) => [
            id,
            {
              version: id === packageId ? '1.0.0' : '0.1.0',
              integrity: id === packageId ? source.snapshot.integrity : 'builtin:0.1.0',
              ...(id === packageId ? {} : { source: { type: 'builtin', ref: 'builtin' } }),
              trust: id === packageId ? 'trusted' : 'builtin',
              enabled: true,
            },
          ]),
        ),
      },
      profileInputs: {
        user: {
          name: 'local-dev',
          packages: [{ id: packageId, source: `file:${directory}` }],
          providers: { loop: { provider: loop.id, version: loop.version } },
        },
      },
      runtimePluginSnapshots: [source],
      runtimePluginCatalogue: [source],
      runtimePluginSources: async () => [source],
      extensionLoader: { import: async () => ({ main: plugin }) },
      approval: async () => ({ verdict: 'unavailable', reason: 'no-handler' }),
      script: [
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: { toolUseId: '', name: 'tool_describe', args: { name: 'ui_render' }, ordinal: 0 },
          },
          { type: 'done', reason: 'toolUse' },
        ],
        [
          {
            type: 'toolcall_end',
            via: 'native',
            call: {
              toolUseId: '',
              name: 'ui_render',
              args: { surface: surface as unknown as JsonValue },
              ordinal: 0,
            },
          },
          { type: 'done', reason: 'toolUse' },
        ],
        [{ type: 'text_delta', delta: 'done' }, { type: 'done', reason: 'stop' }],
        [{ type: 'text_delta', delta: 'done' }, { type: 'done', reason: 'stop' }],
      ],
    })
    try {
      let session = await host.createSession({ key: 'deferred-review', cwd: root })
      await session.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'Review' }] })
      const rendered = await session.run({ until: 'turn-end', signal })
      const history = await session.scan({ toSeq: session.lastSeq, type: ['tool/result', 'x/core/failure'] })
      expect(rendered, JSON.stringify({ rendered, history })).toMatchObject({ reason: 'completed' })
      const shown = await session.intelligentUi!.read({ sessionId: session.key }, signal)
      expect(shown.surfaces, JSON.stringify(history)).toContainEqual(
        expect.objectContaining({ status: 'open', surface: expect.objectContaining({ id: surface.id }) }),
      )
      const action = {
        sessionId: session.key,
        surfaceId: surface.id,
        revision: 1,
        actionId: 'commit',
        commandId: 'commit-once',
        input: {},
        selection: {},
        confirmed: true,
      }
      const actionActor = structuredClone(session.d.actor)
      const admitted = await session.intelligentUi!.action(action, actionActor, signal)
      expect(admitted, JSON.stringify(admitted)).toMatchObject({ status: 'received' })
      const run = await session.run({ until: 'turn-end', signal })
      expect(run, JSON.stringify(run)).toMatchObject({ reason: 'parked' })
      const [decision] = await session.decisions.list()
      expect(decision).toMatchObject({
        request: {
          owner: 'core/tool-permission',
          sourcePackage: '@agnes/core',
          spec: { purpose: 'tool.permission' },
        },
        result: null,
      })
      const readAction = async () =>
        (await session.intelligentUi!.read({ sessionId: session.key }, signal)).actions[0]!
      const pending = await readAction()
      expect(pending).toMatchObject({ status: 'pending-approval', approvalId: decision!.handle.id })
      expect(executions).toEqual([])
      await session.close()
      session = await host.createSession({ key: 'deferred-review', cwd: root })
      const queue = deferredQueueFor(session)!.forSession(session.key, session.lane)!
      expect(await queue.read(pending.invocationId!, signal)).toMatchObject({
        state: 'pending-approval',
        approvalId: decision!.handle.id,
      })
      await session.decisions.answer(
        {
          handle: decision!.handle,
          revision: decision!.revision,
          commandId: 'human-answer',
          response: { option: verdict, value: null },
        },
        { actor, category: 'human', authorize() {} },
      )
      const resumed = await session.run({ until: 'turn-end', signal })
      const completed = await readAction()
      expect(resumed, JSON.stringify(resumed)).toMatchObject({ reason: 'completed' })
      expect(completed).toMatchObject({ status: verdict === 'allowed-once' ? 'succeeded' : 'rejected' })
      expect(await queue.read(pending.invocationId!, signal)).toMatchObject({
        state: verdict === 'allowed-once' ? 'succeeded' : 'failed',
        approvalId: decision!.handle.id,
      })
      await session.intelligentUi!.action(action, session.d.actor, signal)
      await session.run({ until: 'turn-end', signal })
      expect(executions).toEqual(verdict === 'allowed-once' ? ['committed'] : [])
      const results = [...notifications.values()].filter((input) => input.type === 'action-result')
      expect(results).toHaveLength(1)
      expect([...resultActors.values()]).toEqual([actionActor])
      expect(results[0]).toMatchObject({
        source: 'agnes/intelligent-ui',
        data: {
          commandId: 'commit-once',
          status: verdict === 'allowed-once' ? 'succeeded' : 'rejected',
          invocation: { tool: 'review_commit' },
        },
      })
      expect([...notifications.values()]).toContainEqual(
        expect.objectContaining({
          source: 'agnes/deferred-invocations',
          type: 'invocation-queued',
          data: { invocationId: pending.invocationId },
        }),
      )
      const calls = await session.scan({ type: 'tool/call', toSeq: session.lastSeq })
      expect(calls.filter((row) => (row.data as { name: string }).name === 'review_commit')).toHaveLength(1)
      expect(await session.decisions.list()).toHaveLength(1)
      const settled = await session.decisions.get(decision!.handle)
      expect(settled.consumption).toMatchObject({
        operationId: decision!.request.operationId,
        effectId: verdict === 'allowed-once' ? expect.any(String) : null,
      })
      if (verdict === 'rejected') {
        const checkpoints = await session.scan({ type: 'x/core/decision-checkpoint', toSeq: session.lastSeq })
        expect(checkpoints).toContainEqual(
          expect.objectContaining({
            data: { handle: decision!.handle, operationId: decision!.request.operationId },
          }),
        )
        const effects = await session.scan({ type: 'effect/intent', toSeq: session.lastSeq })
        expect(
          effects.some(
            (row) =>
              (row.data as { tool?: { toolUseId: string } }).tool?.toolUseId ===
              decision!.request.operationId,
          ),
        ).toBe(false)
      }
    } finally {
      await host.close()
      await rm(root, { recursive: true, force: true })
    }
  },
)
