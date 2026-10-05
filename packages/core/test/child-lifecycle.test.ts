import type { ModelRecord } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { childInboxCommandId } from '../src/child/continuation.js'
import { KernelChildren } from '../src/child/factory.js'
import { CHILD_CONTROL_FORMAT } from '../src/child/types.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { canonicalJson, sha256Hex } from '../src/request/hash.js'
import { reserveSessionConfiguration } from '../src/step/configuration-admission.js'
import { presetDefaults } from '../src/step/preset.js'
import { acquireSessionIdleGate } from '../src/step/session-idle-gate.js'
import { CoreError } from '../src/types.js'
import { fakeProvider, sent, textTurn } from './helpers/fake-provider.js'

const catalogue = (): ModelRecord => ({
  id: 'm1',
  name: 'm1',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 128,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
})

import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, testFsOps } from './helpers/open-session.js'

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

function kernel(
  over: Partial<Parameters<typeof Kernel.create>[0]> & { treeBudgetCredits?: number | null } = {},
) {
  const { treeBudgetCredits = 100, ...rest } = over
  return Kernel.create({
    storage: new MemoryStorage(),
    seams: fakeSeams(),
    provider: Object.assign(fakeProvider([textTurn('child says hi'), textTurn('second')]), {
      models: () => [catalogue()],
    }),
    contract: { contract_id: null, parser_version: '1' },
    preset: { ...presetDefaults(), treeBudgetCredits, generationLimit: 1, maxFanOut: 2 },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    logger,
    timers: noTimers,
    clock: () => 1_757_203_200_000,
    ...rest,
  })
}

const sessionOpts = { actor, resolvedProfileHash: 'h1', cwd: '/w', writerRunId: 'r1' }

describe('Kernel child lifecycle (generation, fan-out, budget)', () => {
  it.each([
    { baseline: 'manual', mode: 'off', cancel: false },
    { baseline: 'off', mode: 'manual', cancel: false },
    { baseline: 'manual', mode: 'off', cancel: true },
  ] as const)(
    'scopes inherited $mode approval over a $baseline profile to the original owner and child run (cancel=$cancel)',
    async ({ baseline, mode, cancel }) => {
      let finishInference!: () => void
      const waiting = new Promise<void>((resolve) => {
        finishInference = resolve
      })
      let calls = 0
      const observed: Array<{ key: string; mode: string | undefined }> = []
      const k = kernel({
        approvalMode: baseline,
        preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 3, maxFanOut: 3 },
        provider: {
          models: () => [catalogue()],
          async *infer(request, options) {
            calls++
            for (const session of k.sessions.values())
              if (session.executionActive) observed.push({ key: session.key, mode: session.d.approvalMode })
            await waiting
            yield* fakeProvider([textTurn('done')]).infer(request, options)
          },
        },
      })
      const runs: Promise<unknown>[] = []
      try {
        const parent = await k.session('parent', sessionOpts)
        const capture = () => ({ approvalMode: parent.d.approvalMode })
        const reserve = (id: string, approvalMode: 'manual' | 'off') =>
          reserveSessionConfiguration(
            parent,
            {
              id,
              commandId: id,
              payloadDigest: sha256Hex('[]'),
              approvalMode,
              expectedConfigurationDigest: sha256Hex(canonicalJson(capture())),
            },
            capture,
            () => undefined,
          )
        const first = await reserve('first', mode)
        const factory = parent.d.children as KernelChildren
        const handle = await factory.createWithKind('spawn', {
          parent: parent.key,
          cwd: '/w',
          input: 'child',
        })
        const child = k.get(handle.key)
        if (!child) throw new Error('Missing child')
        const childDescriptor = Object.getOwnPropertyDescriptor(child.d, 'approvalMode')
        const running = handle.run('child')
        runs.push(running)
        void running.catch(() => undefined)
        await vi.waitFor(() => expect(calls).toBe(1))
        expect(child.d.approvalMode).toBe(mode)
        const grandchildHandle = await (child.d.children as KernelChildren).createWithKind('spawn', {
          parent: child.key,
          cwd: '/w',
          input: 'grandchild',
        })
        const grandchild = k.get(grandchildHandle.key)
        if (!grandchild) throw new Error('Missing grandchild')
        const descendant = grandchildHandle.run('grandchild')
        runs.push(descendant)
        void descendant.catch(() => undefined)
        await vi.waitFor(() => expect(calls).toBe(2))
        expect(grandchild.d.approvalMode).toBe(mode)
        expect(child.yolo).toBe(false)
        expect(grandchild.yolo).toBe(false)
        if (cancel) {
          await parent.abort(actor)
          expect(child.d.approvalMode).toBe('manual')
          expect(grandchild.d.approvalMode).toBe('manual')
        }
        await first.lease.release()
        expect(parent.d.approvalMode).toBe(baseline)
        expect(child.d.approvalMode).toBe('manual')
        expect(grandchild.d.approvalMode).toBe('manual')
        const second = await reserve('second', 'off')
        expect(parent.d.approvalMode).toBe('off')
        expect(child.d.approvalMode).toBe('manual')
        expect(grandchild.d.approvalMode).toBe('manual')
        const lateHandle = await (child.d.children as KernelChildren).createWithKind('spawn', {
          parent: child.key,
          cwd: '/w',
          input: 'late descendant',
        })
        const late = lateHandle.run('late descendant')
        runs.push(late)
        void late.catch(() => undefined)
        await vi.waitFor(() => expect(calls).toBe(3))
        expect(k.get(lateHandle.key)?.d.approvalMode).toBe('manual')
        finishInference()
        await Promise.all(runs)
        expect(Object.getOwnPropertyDescriptor(child.d, 'approvalMode')).toEqual(childDescriptor)
        await second.lease.release()
        // Releasing the owner also flushes canonical descendant reports to the parent writer.
        await new Promise<void>((resolve) => setImmediate(resolve))
        const manual = await reserve('manual-continuation', 'manual')
        const before = observed.length
        await factory.sendMessage(handle.key, 'another task', {
          deliveryId: 'manual-followup',
          parentEffectId: 'followup',
          signal: new AbortController().signal,
        })
        await vi.waitFor(async () => expect((await factory.inspect(handle.key))?.state).toBe('done'))
        expect(observed.slice(before)).toContainEqual({ key: handle.key, mode: 'manual' })
        await manual.lease.release()
        expect(parent.d.approvalMode).toBe(baseline)
      } finally {
        finishInference()
        await Promise.allSettled(runs)
        await k.close()
      }
    },
  )

  it('keeps receipted child reports pending after cancellation until an explicit new user run', async () => {
    const k = kernel({
      childParentWake: async (parent) => {
        await parent.run({ until: 'idle', signal: new AbortController().signal })
      },
    })
    try {
      const parent = await k.session('parent', sessionOpts)
      const handle = await (parent.d.children as KernelChildren).createWithKind('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'child',
      })
      const child = k.get(handle.key)
      if (!child) throw new Error('Missing child')
      const held = await reserveSessionConfiguration(
        parent,
        { id: 'held', commandId: 'input', payloadDigest: sha256Hex('[]') },
        () => parent.preset,
        () => undefined,
      )
      await parent.abort(actor)
      await (child.d.children as KernelChildren).sendMessage(parent.key, 'CANCELLED_REPORT', {
        deliveryId: 'cancel-report',
        parentEffectId: 'call',
        signal: new AbortController().signal,
      })
      await held.lease.release()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
      expect(await parent.scan({ type: 'turn/start', limit: 10 })).toEqual([])
      expect(parent.latest('inbox')).toMatchObject({
        items: [expect.objectContaining({ trust: 'untrusted' })],
      })
      await parent.enqueue('next-turn', {
        actor,
        commandId: 'new-user',
        content: [{ type: 'text', text: 'Explicit resume' }],
      })
      expect((await parent.run({ until: 'idle', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect((await parent.run({ until: 'idle', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(parent.latest('inbox')).toMatchObject({ items: [] })
      expect(JSON.stringify(await parent.scan({ type: 'user/message', limit: 10 }))).toContain(
        'Explicit resume',
      )
      expect(JSON.stringify(await parent.scan({ type: 'assistant/message', limit: 10 }))).toContain('second')
    } finally {
      await k.close()
    }
  })
  it('refuses an idle proof while child allocation is in flight and fences later allocation', async () => {
    const k = kernel()
    try {
      const parent = await k.session('parent', sessionOpts)
      const factory = parent.d.children as KernelChildren
      const storage = k.o.storage as MemoryStorage
      let proceed!: () => void
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const paused = new Promise<void>((resolve) => {
        proceed = resolve
      })
      const create = storage.createDelegatedChild.bind(storage)
      const spy = vi.spyOn(storage, 'createDelegatedChild').mockImplementation(async (...args) => {
        entered()
        await paused
        return create(...args)
      })
      const creating = factory.createWithKind('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'deferred',
        start: false,
      })
      await started
      await expect(acquireSessionIdleGate(parent, () => factory.allocationActive)).rejects.toMatchObject({
        code: 'E_LANE_BUSY',
      })
      proceed()
      await creating
      spy.mockRestore()
      const gate = await acquireSessionIdleGate(parent, () => factory.allocationActive)
      try {
        gate.check()
        expect(() =>
          factory.createWithKind('spawn', { parent: parent.key, cwd: '/w', input: 'blocked' }),
        ).toThrow(/E_LANE_BUSY/)
        await expect(parent.step()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
      } finally {
        gate.release()
      }
      expect(parent.idleGateReserved).toBe(false)
    } finally {
      await k.close()
    }
  })
  it.each(['ordinary', 'configuration-held', 'retirement-held'] as const)(
    'wakes an admitted %s parent even when the sender ACK fails, and retries do not duplicate delivery',
    async (mode) => {
      const k = kernel({
        childParentWake: async (parent) => {
          await parent.run({ until: 'idle', signal: new AbortController().signal })
        },
      })
      try {
        const parent = await k.session('parent', sessionOpts)
        const handle = await (parent.d.children as KernelChildren).createWithKind('spawn', {
          parent: parent.key,
          cwd: '/w',
          input: 'child',
        })
        const child = k.get(handle.key)
        if (!child) throw new Error('Missing child')
        const append = child.d.log.append.bind(child.d.log)
        const spy = vi.spyOn(child.d.log, 'append').mockImplementation(async (events) => {
          if (events.some((event) => event.type === 'x/core/child-delivered'))
            throw new CoreError('E_STORAGE_FAULT', 'sender ACK-only storage fault')
          return append(events)
        })
        const send = () =>
          (child.d.children as KernelChildren).sendMessage(parent.key, 'ADMITTED_REPORT', {
            deliveryId: 'ack-fault',
            parentEffectId: 'child-call',
            signal: new AbortController().signal,
          })
        if (mode === 'configuration-held') {
          const held = await reserveSessionConfiguration(
            parent,
            { id: 'held', commandId: 'input', payloadDigest: sha256Hex('[]') },
            () => parent.preset,
            () => undefined,
          )
          await expect(send()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
          expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
          await held.lease.release()
        } else if (mode === 'retirement-held') {
          const gate = await acquireSessionIdleGate(parent, () => false)
          await expect(send()).rejects.toMatchObject({ code: 'E_LANE_BUSY' })
          expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toEqual([])
          expect(parent.latest('inbox')).toBeUndefined()
          gate.release()
        } else await expect(send()).rejects.toMatchObject({ code: 'E_STORAGE_FAULT' })
        await vi.waitFor(async () =>
          expect(await parent.scan({ type: 'user/message', limit: 10 })).toHaveLength(1),
        )
        await vi.waitFor(() => expect(parent.executionActive).toBe(false))
        expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
        expect(await child.scan({ type: 'x/core/child-delivered', limit: 10 })).toEqual([])
        spy.mockRestore()
        const receipt = await send()
        expect((await parent.scan({ type: 'x/core/child-received', limit: 10 }))[0]?.seq).toBe(
          receipt.acceptedSeq,
        )
        expect(await parent.scan({ type: 'user/message', limit: 10 })).toHaveLength(1)
        expect(await child.scan({ type: 'x/core/child-outbox', limit: 10 })).toHaveLength(1)
        expect(await child.scan({ type: 'x/core/child-delivered', limit: 10 })).toHaveLength(1)
      } finally {
        await k.close()
      }
    },
    5000,
  )

  it('retries a busy wake whose rejection arrives after the competing run already ended', async () => {
    let wakeAttempts = 0
    const k = kernel({
      childParentWake: async (parent) => {
        if (wakeAttempts++ === 0) {
          await parent.run({ until: 'turn-end', signal: new AbortController().signal })
          expect(parent.executionActive).toBe(false)
          throw new CoreError('E_LANE_BUSY', 'competing run won admission')
        }
        await parent.run({ until: 'idle', signal: new AbortController().signal })
      },
    })
    try {
      const parent = await k.session('parent', sessionOpts)
      const handle = await (parent.d.children as KernelChildren).createWithKind('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'child',
      })
      const child = k.get(handle.key)
      if (!child) throw new Error('Missing child')
      await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'RPC_TASK' }] })
      await (child.d.children as KernelChildren).sendMessage(parent.key, 'REPORT', {
        deliveryId: 'busy-race',
        parentEffectId: 'child-call',
        signal: new AbortController().signal,
      })
      await vi.waitFor(() => expect((parent.latest('inbox') as { items: unknown[] }).items).toEqual([]))
      await vi.waitFor(() => expect(parent.executionActive).toBe(false))
      expect(await parent.scan({ type: 'user/message', limit: 10 })).toHaveLength(2)
      expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
    } finally {
      await k.close()
    }
  }, 5000)

  it.each(['failed', 'parent-close'] as const)(
    'keeps a truthful %s settlement and never wakes a closing parent',
    async (finish) => {
      let entered = false
      const wake = vi.fn(async () => undefined)
      const scripted = fakeProvider([textTurn('unused')])
      const provider = {
        ...scripted,
        models: () => [catalogue()],
        async *infer(
          _request: Parameters<typeof scripted.infer>[0],
          options: Parameters<typeof scripted.infer>[1],
        ) {
          entered = true
          if (finish === 'parent-close')
            await new Promise<void>((resolve) => {
              const signal = options?.signal
              if (!signal || signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
          yield* fakeProvider([
            [
              sent(),
              {
                type: 'error',
                reason: 'error',
                code: 'TRANSPORT',
                message: 'bounded provider failure',
                retryable: false,
              },
            ],
          ]).infer(_request, options)
        },
      }
      const k = kernel({ provider, childParentWake: wake })
      try {
        const parent = await k.session('parent', sessionOpts)
        const factory = parent.d.children as KernelChildren
        const handle = await factory.createWithKind('spawn', {
          parent: parent.key,
          cwd: '/w',
          input: 'child',
        })
        const running = handle.run('child').catch((error: unknown) => error)
        await vi.waitFor(() => expect(entered).toBe(true))
        if (finish === 'parent-close') await parent.close()
        expect(await running).toBeInstanceOf(Error)
        const outbox = await k.o.storage.scan(handle.key, { type: 'x/core/child-outbox', limit: 10 })
        expect(outbox).toHaveLength(1)
        expect(outbox[0]?.data).toMatchObject({
          kind: 'subagent-settled',
          outcome: finish === 'failed' ? 'failed' : 'cancelled',
          text: expect.stringContaining('It left no closing message.'),
        })
        const receipts = await k.o.storage.scan(parent.key, { type: 'x/core/child-received', limit: 10 })
        expect(receipts).toHaveLength(finish === 'failed' ? 1 : 0)
        if (finish === 'parent-close') expect(wake).not.toHaveBeenCalled()
      } finally {
        await k.close()
      }
    },
    5000,
  )

  it('waits for a running descendant on natural completion, consumes its notice, then settles to the direct parent', async () => {
    let releaseGrand!: () => void
    const grandGate = new Promise<void>((resolve) => {
      releaseGrand = resolve
    })
    let childAnswered = false
    const scripted = fakeProvider([textTurn('unused')])
    const provider = {
      ...scripted,
      models: () => [catalogue()],
      async *infer(
        request: Parameters<typeof scripted.infer>[0],
        options: Parameters<typeof scripted.infer>[1],
      ) {
        const messages = JSON.stringify(request.messages)
        if (messages.includes('GRAND_TASK')) {
          await grandGate
          yield* fakeProvider([textTurn('GRAND_DONE')]).infer(request, options)
        } else {
          const afterGrand = messages.includes('Background subagent')
          yield* fakeProvider([textTurn(afterGrand ? 'CHILD_AFTER_GRAND' : 'WAITING_FOR_GRAND')]).infer(
            request,
            options,
          )
          childAnswered = true
        }
      },
    }
    const k = kernel({
      provider,
      preset: { ...presetDefaults(), treeBudgetCredits: null, generationLimit: 2, maxFanOut: 4 },
    })
    try {
      const parent = await k.session('parent', sessionOpts)
      const first = parent.d.children as KernelChildren
      const handle = await first.createWithKind('spawn', {
        parent: parent.key,
        cwd: '/w',
        input: 'CHILD_TASK',
      })
      const child = k.get(handle.key)
      if (!child) throw new Error('Missing child')
      const grandchildren = child.d.children as KernelChildren
      const grand = await grandchildren.createWithKind('spawn', {
        parent: child.key,
        cwd: '/w',
        input: 'GRAND_TASK',
      })
      const grandRun = grand.run('GRAND_TASK')
      const childRun = handle.run('CHILD_TASK')
      await vi.waitFor(() => expect(childAnswered).toBe(true))
      expect((await first.inspect(handle.key))?.state).toBe('running')
      expect((await grandchildren.inspect(grand.key))?.state).toBe('running')
      expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toEqual([])
      releaseGrand()
      expect(await grandRun).toMatchObject({ text: 'GRAND_DONE' })
      expect(await childRun).toMatchObject({ text: 'CHILD_AFTER_GRAND' })
      expect((await first.inspect(handle.key))?.state).toBe('done')
      expect((await grandchildren.inspect(grand.key))?.state).toBe('done')
      expect(await k.o.storage.scan(child.key, { type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
      expect((await parent.scan({ type: 'x/core/child-received', limit: 10 }))[0]?.data).toMatchObject({
        senderKey: child.key,
        kind: 'subagent-settled',
        outcome: 'completed',
      })
    } finally {
      releaseGrand()
      await k.close()
    }
  }, 5000)

  it('retargets a late next-step report after the last response without losing its identity or overlapping a run', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    let calls = 0
    const scripted = fakeProvider([textTurn('FIRST'), textTurn('REPORT_ACCEPTED')])
    const provider = {
      ...scripted,
      models: () => [catalogue()],
      async *infer(
        request: Parameters<typeof scripted.infer>[0],
        options: Parameters<typeof scripted.infer>[1],
      ) {
        if (calls++ === 0) {
          entered = true
          await barrier
        }
        yield* scripted.infer(request, options)
      },
    }
    const k = kernel({
      provider,
      childParentWake: async (parent) => {
        await parent.run({ until: 'idle', signal: new AbortController().signal })
      },
    })
    try {
      const parent = await k.session('parent', sessionOpts)
      const factory = parent.d.children as KernelChildren
      const handle = await factory.createWithKind('spawn', { parent: parent.key, cwd: '/w', input: 'child' })
      const child = k.get(handle.key)
      if (!child) throw new Error('Missing child')
      let receipt: Awaited<ReturnType<typeof factory.sendMessage>> | undefined
      const original = parent.runInference.bind(parent)
      vi.spyOn(parent, 'runInference').mockImplementation(async () => {
        const result = await original()
        if (!receipt) {
          receipt = await (child.d.children as KernelChildren).sendMessage(parent.key, 'LATE_REPORT', {
            deliveryId: 'late-report',
            parentEffectId: 'actual-child-call',
            signal: new AbortController().signal,
          })
          expect((parent.latest('inbox') as { items: Array<{ target: string }> }).items[0]?.target).toBe(
            'next-step',
          )
        }
        return result
      })
      await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'parent' }] })
      const running = parent.run({ until: 'turn-end', signal: new AbortController().signal })
      await vi.waitFor(() => expect(entered).toBe(true))
      await expect(parent.run({ until: 'idle', signal: new AbortController().signal })).rejects.toMatchObject(
        { code: 'E_LANE_BUSY' },
      )
      release()
      await running
      await vi.waitFor(() => expect(receipt).toBeDefined())
      await vi.waitFor(() => expect(parent.executionActive).toBe(false))
      await vi.waitFor(() => expect((parent.latest('inbox') as { items: unknown[] }).items).toEqual([]))
      const accepted = await parent.scan({ type: 'x/core/child-received', limit: 10 })
      expect(accepted).toHaveLength(1)
      expect(accepted[0]?.data).toMatchObject({ messageId: receipt?.messageId })
      expect(
        await (child.d.children as KernelChildren).sendMessage(parent.key, 'LATE_REPORT', {
          deliveryId: 'late-report',
          parentEffectId: 'actual-child-call',
          signal: new AbortController().signal,
        }),
      ).toEqual(receipt)
      expect(await parent.scan({ type: 'x/core/child-received', limit: 10 })).toHaveLength(1)
      expect(await parent.scan({ type: 'user/message', limit: 10 })).toHaveLength(2)
    } finally {
      release()
      await k.close()
    }
  }, 5000)

  it.each(['settled', 'before-interrupt', 'during-drain'] as const)(
    'interrupt/send %s preserves exactly one message on the same conversation',
    async (deliveryPhase) => {
      let releaseDrain!: () => void
      const draining = new Promise<void>((resolve) => {
        releaseDrain = resolve
      })
      if (deliveryPhase !== 'during-drain') releaseDrain()
      let entered = false
      const scripted = fakeProvider([textTurn('follow-up answer')])
      let first = true
      const provider = {
        ...scripted,
        models: () => [catalogue()],
        async *infer(
          request: Parameters<typeof scripted.infer>[0],
          options: Parameters<typeof scripted.infer>[1],
        ) {
          if (first) {
            first = false
            entered = true
            const signal = options?.signal
            if (!signal) throw new Error('Missing signal')
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve()
              else signal.addEventListener('abort', () => resolve(), { once: true })
            })
            await draining
            throw new DOMException('interrupted', 'AbortError')
          }
          yield* scripted.infer(request, options)
        },
      }
      const k = kernel({ provider })
      try {
        const parent = await k.session('parent', sessionOpts)
        const factory = parent.d.children
        if (!(factory instanceof KernelChildren)) throw new Error('Missing factory')
        const handle = await factory.createWithKind('spawn', {
          parent: parent.key,
          cwd: '/w',
          input: 'initial',
        })
        const child = k.get(handle.key)
        if (!child) throw new Error('Missing child')
        const originalRun = child.run.bind(child)
        let attempts = 0
        // Bound the pre-fix orphan-inbox loop without relying on an event-loop timer.
        vi.spyOn(child, 'run').mockImplementation((options) => {
          if (++attempts > 4) return Promise.reject(new Error('bounded orphan inbox loop'))
          return originalRun(options)
        })
        const running = handle.run('initial').catch((error: unknown) => error)
        await vi.waitFor(() => expect(entered).toBe(true))
        const deliver = () =>
          factory.sendMessage(handle.key, 'follow-up', {
            deliveryId: 'follow-up',
            parentEffectId: 'direct',
            signal: new AbortController().signal,
          })
        let receipt = deliveryPhase === 'before-interrupt' ? await deliver() : undefined
        if (receipt)
          expect((child.latest('inbox') as { items: unknown[] }).items).toContainEqual(
            expect.objectContaining({
              itemId: receipt.messageId,
              commandId: childInboxCommandId(parent.key, child.key, 'follow-up'),
            }),
          )
        await factory.interrupt(handle.key)
        if (deliveryPhase === 'during-drain') {
          receipt = await deliver()
          expect((child.latest('inbox') as { items: unknown[] }).items).toContainEqual(
            expect.objectContaining({
              itemId: receipt.messageId,
              commandId: childInboxCommandId(parent.key, child.key, 'follow-up'),
            }),
          )
          releaseDrain()
        }
        expect(await running).toBeInstanceOf(Error)
        const storage = k.o.storage as MemoryStorage
        if (deliveryPhase === 'settled') {
          expect((await storage.lookupByKey(handle.key))?.state).toBe('interrupted')
          expect(k.get(handle.key)).toBeDefined()
          receipt = await deliver()
        }
        await vi.waitFor(async () =>
          expect(await factory.inspect(handle.key)).toMatchObject({
            state: 'done',
            text: 'follow-up answer',
          }),
        )
        const rows = await storage.scan(handle.key, { type: 'user/message', limit: 100 })
        expect(
          rows.map((row) => (row.data as { content: Array<{ text: string }> }).content[0]?.text),
        ).toEqual(['initial', 'follow-up'])
        expect((child.latest('inbox') as { items: unknown[] }).items).toEqual([])
        expect(await deliver()).toEqual(receipt)
        expect(await storage.scan(handle.key, { type: 'x/core/child-delivery', limit: 100 })).toHaveLength(1)
        await vi.waitFor(async () =>
          expect(
            (await parent.scan({ type: 'x/core/child-received', limit: 10 })).map(
              (row) => (row.data as { outcome: string }).outcome,
            ),
          ).toEqual(['cancelled', 'completed']),
        )
        await factory.cancel(handle.key)
        await expect(
          factory.sendMessage(handle.key, 'revive', {
            deliveryId: 'revive',
            parentEffectId: 'direct',
            signal: new AbortController().signal,
          }),
        ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
      } finally {
        releaseDrain()
        await k.close()
      }
    },
  )

  it('does not turn a one-shot fork into a continuable conversation', async () => {
    const k = kernel()
    try {
      const parent = await k.session('parent', sessionOpts)
      const factory = parent.d.children
      if (!(factory instanceof KernelChildren)) throw new Error('Missing factory')
      const fork = await factory.createWithKind('fork', { parent: parent.key, cwd: '/w', input: 'one-shot' })
      await fork.run('one-shot')
      await expect(
        factory.sendMessage(fork.key, 'another', {
          deliveryId: 'another',
          parentEffectId: 'direct',
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
      const record = await (k.o.storage as MemoryStorage).lookupByKey(fork.key)
      expect(record?.state).toBe('completed')
      expect(await k.o.storage.scan(fork.key, { type: 'x/core/child-delivery', limit: 100 })).toEqual([])
    } finally {
      await k.close()
    }
  })

  it('owner close cancels a constructor admitted before its first await and waits for its rollback', async () => {
    let entered!: () => void
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    let cancelled = false
    const k = kernel({
      childSessionSupportsRuntime: () => true,
      childSessionOpen: async (_parent, request) => {
        entered()
        await new Promise<void>((resolve) =>
          request.signal.addEventListener(
            'abort',
            () => {
              cancelled = true
              resolve()
            },
            { once: true },
          ),
        )
        request.signal.throwIfAborted()
        throw new Error('unreachable')
      },
    })
    const parent = await k.session('parent', sessionOpts)
    const opening = parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'pending',
    })
    if (!opening) throw new Error('Missing default factory')
    const settled = opening.catch((error: unknown) => error)
    await entering
    await parent.close()
    expect(cancelled).toBe(true)
    expect(await settled).toBeInstanceOf(Error)
    expect(k.sessions.size).toBe(1)
    const storage = parent.d.log.storage
    if (!('listByParent' in storage)) throw new Error('Missing child control')
    expect(await (storage as MemoryStorage).listByParent(parent.key)).toMatchObject([
      { creationPhase: 'cancelled', state: 'failed' },
    ])
    await k.close()
  })

  it('failed constructor rollback retains the parent and child writers until an exact close retry drains', async () => {
    let entered!: () => void
    const entering = new Promise<void>((resolve) => {
      entered = resolve
    })
    let childKey = ''
    let permitDrain = false
    const k = kernel({
      childSessionSupportsRuntime: () => true,
      childSessionOpen: async (_parent, request) => {
        const child = await k.session(request.key, request.options)
        childKey = child.key
        const close = child.close.bind(child)
        child.close = async () => {
          if (!permitDrain) throw new Error('runtime drain failed')
          await close()
        }
        entered()
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        return child
      },
    })
    const parent = await k.session('parent', sessionOpts)
    const opening = parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'pending',
    })
    if (!opening) throw new Error('Missing default factory')
    const settled = opening.catch((error: unknown) => error)
    await entering
    await expect(parent.close()).rejects.toThrow('owned child drain failed')
    await settled
    expect(parent.d.log.isClosed).toBe(false)
    expect(k.get(childKey)?.d.log.isClosed).toBe(false)
    permitDrain = true
    await parent.close()
    expect(parent.d.log.isClosed).toBe(true)
    expect(k.get(childKey)).toBeUndefined()
    await k.close()
  })

  it('a published fresh spawn outlives its creation signal and contains no parent answer', async () => {
    const k = kernel()
    const parent = await k.session('parent', sessionOpts)
    await parent.enqueue('next-turn', { actor, content: [{ type: 'text', text: 'parent' }] })
    await parent.run({ until: 'turn-end', signal: new AbortController().signal })
    const controller = new AbortController()
    const child = await parent.d.children.createWithKind?.('spawn', {
      parent: parent.key,
      cwd: '/w',
      input: 'child',
      signal: controller.signal,
    })
    if (!child) throw new Error('Missing default factory')
    controller.abort()
    expect((await child.status()).text).toBeUndefined()
    expect((await child.run('child')).text).toBe('second')
    await k.close()
  })

  it('refuses a child when generationLimit is 0 and does not start a model', async () => {
    const provider = fakeProvider([textTurn('should not run')])
    const k = kernel({
      provider,
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 0, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const calls = provider.requests?.length ?? 0
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'nope' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    expect(provider.requests?.length ?? 0).toBe(calls)
    expect(k.sessions.size).toBe(1)
    await k.close()
  })

  it('admits one generation and refuses a grandchild even if tool nesting depth is 0', async () => {
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 1, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'first' })
    const childSession = k.get(child.key)
    expect(childSession?.generationDepth).toBe(1)
    await expect(
      childSession?.d.children.create({ parent: child.key, cwd: '/w', input: 'grand' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    await child.run('first')
    await k.close()
  })

  it('counts creating and running children toward fan-out and frees the slot on terminal without collect', async () => {
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: 100, generationLimit: 2, maxFanOut: 1 },
    })
    const parent = await k.session('parent', sessionOpts)
    const factory = parent.d.children as KernelChildren
    const first = await factory.createWithKind('spawn', { parent: parent.key, cwd: '/w', input: 'one' })
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'two' }),
    ).rejects.toMatchObject({ code: 'E_CHILD_LIMIT' })
    await first.run('one')
    const second = await factory.createWithKind('spawn', { parent: parent.key, cwd: '/w', input: 'two' })
    expect(second.key).not.toBe(first.key)
    await second.run('two')
    const received = await parent.scan({ type: 'x/core/child-received', limit: 10 })
    expect(received.map((row) => (row.data as { senderKey: string }).senderKey)).toEqual([
      first.key,
      second.key,
    ])
    const commands = (parent.latest('inbox') as { items: Array<{ commandId: string }> }).items.map(
      (item) => item.commandId,
    )
    expect(commands).toHaveLength(2)
    expect(new Set(commands).size).toBe(2)
    await k.close()
  })

  it('delegates with a built-in default tree budget when tree_budget_credits is missing', async () => {
    // Every shipped preset left this unset, which used to refuse every fork/spawn outright — a
    // missing knob, not a deliberate "no subagents" decision. The factory falls back to
    // DEFAULT_TREE_BUDGET_CREDITS instead of throwing E_BUDGET.
    const k = kernel({
      preset: { ...presetDefaults(), treeBudgetCredits: null, generationLimit: 2, maxFanOut: 4 },
    })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' })
    expect(child.key).toBeDefined()
    await k.close()
  })

  it('refuses own budget inherit mode', async () => {
    const k = kernel({
      preset: {
        ...presetDefaults(),
        treeBudgetCredits: 100,
        budgetInherit: 'own',
        generationLimit: 2,
        maxFanOut: 4,
      },
    })
    const parent = await k.session('parent', sessionOpts)
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await k.close()
  })

  it('atomically admits only one of two overlapping reservations against a tree cap of 10', async () => {
    const storage = new MemoryStorage()
    await storage.ensureRootScope('root', 10_000_000n)
    const first = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'a',
      requestHash: 'a',
      writerGeneration: 1,
    })
    const second = await storage.reserve({
      rootTaskId: 'root',
      scopeIds: ['root:root'],
      qMicro: 8_000_000n,
      effectId: 'b',
      requestHash: 'b',
      writerGeneration: 1,
    })
    expect(first).toEqual({ ok: true, permitId: 'p1', status: 'held', existing: false })
    expect(second).toMatchObject({ ok: false, reason: 'cap' })
  })

  it('inspect of an unknown key does not create a session or take a writer', async () => {
    const storage = new MemoryStorage()
    const open = vi.spyOn(storage, 'open')
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const inspect = parent.d.children.inspect
    expect(inspect).toBeTypeOf('function')
    await expect(inspect?.('missing-child')).resolves.toBeNull()
    expect(await storage.existsSession('missing-child')).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
    await k.close()
  })

  it('rejects a child-control format newer than this runtime', async () => {
    const storage = new MemoryStorage({ childControlFormat: CHILD_CONTROL_FORMAT + 1 })
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    await expect(
      parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'x' }),
    ).rejects.toMatchObject({ code: 'E_FORMAT' })
    await k.close()
  })

  it('keeps a durable child record after the in-memory handle is closed', async () => {
    const storage = new MemoryStorage()
    const k = kernel({ storage })
    const parent = await k.session('parent', sessionOpts)
    const child = await parent.d.children.create({ parent: parent.key, cwd: '/w', input: 'keep' })
    await child.run('keep')
    await child.close()
    const record = await storage.lookupByKey(child.key)
    expect(record?.state).toBe('completed')
    expect(await storage.existsSession(child.key)).toBe(true)
    await k.close()
  })
})

describe('CoreError', () => {
  it('is the class thrown for child limit failures', () => {
    expect(new CoreError('E_CHILD_LIMIT', 'x')).toBeInstanceOf(Error)
  })
})
