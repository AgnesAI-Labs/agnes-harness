import { defaultLoopPlugin } from '@agnes/base'
import { Context } from '@agnes/cordis'
import { MemoryStorage, SessionLogImpl } from '@agnes/core'
import { defaultIds } from '@agnes/core-common/ids'
import type { LoopContext, LoopFactory, ToolResult } from '@agnes/extension-api'
import { HostError } from '@agnes/host-common/errors'
import {
  createDeferredInvocationQueue,
  DEFERRED_INVOCATION_EVENT,
  type DeferredInvocationLedgerPort,
  DeferredInvocationsService,
  ownerDeferredQueue,
} from '@agnes/host-providers/assemble/deferred-invocations'
import { drainDeferredToolInvocations } from '@agnes/plugin-runtime'
import {
  deferredQueueKind,
  type DeferredActor,
  type DeferredInvocationReceipt,
  type DeferredToolInvocation,
} from '@agnes/plugin-runtime/deferred-contract'
import type { Actor, EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'
import { assertMigrationSettled } from '../src/runtime/generation/migration-state.js'

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
      loops: {
        register: (_source, value) => {
          factory = value
          return async () => undefined
        },
        resolve: () => {
          throw new Error('Not used')
        },
        catalog: () => [],
      },
      effect: (callback) => callback(),
    })
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

it('permits the registry owner bridge while refusing a plugin without a verified row', async () => {
  const root = new Context()
  const owner = root.extend()
  new DeferredInvocationsService(owner, { lookup: () => undefined })
  const producer = { source: 'fixture', validate: async () => {}, changed: async () => {} }
  try {
    const off = owner.deferredInvocations.register(producer)
    expect(() => owner.deferredInvocations.register(producer)).toThrow('Duplicate')
    off()
    let failure: unknown
    const plugin = owner.plugin((ctx) => {
      try {
        ctx.deferredInvocations.register(producer)
      } catch (error) {
        failure = error
      }
    })
    await plugin
    expect(failure).toMatchObject({ code: 'E_EXT_LOAD' })
    expect(String(failure)).toContain('verified plugin row')
    const release = owner.deferredInvocations.register(producer)
    release()
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
        ts: seq,
        ignorable: true,
        ...(sourceSeq ? { sourceEventSeqs: [sourceSeq] } : {}),
      } as EventEnvelope)
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
