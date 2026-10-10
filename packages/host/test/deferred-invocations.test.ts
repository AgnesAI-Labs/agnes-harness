import { defaultLoopPlugin } from '@agnes/base'
import { Context } from '@agnes/cordis'
import { MemoryStorage, SessionLogImpl } from '@agnes/core'
import { defaultIds } from '@agnes/core-common/ids'
import type { LoopContext, LoopFactory, ToolResult } from '@agnes/extension-api'
import {
  createDeferredInvocationQueue,
  type DeferredInvocationLedgerPort,
  DeferredInvocationsService,
} from '@agnes/host-providers/assemble/deferred-invocations'
import { drainDeferredToolInvocations } from '@agnes/plugin-runtime'
import {
  deferredQueueKind,
  type DeferredInvocationReceipt,
  type DeferredToolInvocation,
} from '@agnes/plugin-runtime/deferred-contract'
import type { Actor, EventEnvelope } from '@agnes/protocol'
import { expect, it } from 'vitest'

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
    wake: async () => undefined,
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

