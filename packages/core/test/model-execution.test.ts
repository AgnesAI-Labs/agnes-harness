import { presetDefaults } from '@agnes/core-common/step/preset'
import { type LoopContext, type LoopFactory, loopCheckpointCodec } from '@agnes/extension-api'
import { defaultLoopFactory } from '@agnes/loop-default'
import { describe, expect, it, vi } from 'vitest'
import type { ReplacementOperation } from '../src/step/session.js'
import { fakeProvider, sentFor, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

const codec = loopCheckpointCodec(1, () => null)
const independent: LoopFactory = {
  id: 'test.independent-model',
  version: '1.0.0',
  capabilities: ['model'],
  codec,
  create(ctx) {
    return {
      checkpoint: () => codec.encode(null),
      cancel() {},
      dispose() {},
      async step(signal) {
        if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
        const events = await ctx.model.complete(await ctx.prepareRequest(), signal)
        const error = events.find((event) => event.type === 'error')
        if (error) return ctx.events.finish(error.reason === 'aborted' ? 'aborted' : 'error', error)
        await ctx.events.assistant(
          {
            content: events.flatMap((event) =>
              event.type === 'text_delta' ? [{ type: 'text', text: event.delta }] : [],
            ),
            stopReason: 'end_turn',
          },
          codec.encode(null),
        )
        return ctx.events.finish('completed')
      },
    }
  },
  resume(ctx) {
    return this.create(ctx)
  },
}
const cases = [
  'usage',
  'usage-twice',
  'throw-before-sent',
  'no-done',
  'no-sent',
  'done-tail-throw',
  'error-tail-throw',
  'no-usage',
  'provider-error',
  'error-no-usage',
  'throw',
  'cancel',
  'cancel-with-usage',
] as const

describe('model execution guarantees across Loop implementations', () => {
  it.each(['cancel', 'timeout', 'done', 'invalid-stamp', 'invalid-no-sent'] as const)(
    'Core settles a generic iterator abandoned after %s',
    async (mode) => {
      vi.useFakeTimers()
      let entered!: () => void
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      let context!: LoopContext
      const orphan: LoopFactory = {
        ...independent,
        create(ctx) {
          context = ctx
          return {
            checkpoint: () => codec.encode(null),
            cancel() {},
            dispose() {},
            async step(signal) {
              await ctx.input.accept()
              await ctx.checkpoints.write(codec.encode(null))
              const iterator = ctx.model
                .stream(await ctx.prepareRequest({ invocationId: 'abandoned' }), signal)
                [Symbol.asyncIterator]()
              let event = await iterator.next()
              if (mode === 'done' || mode.startsWith('invalid'))
                while (!event.done && !['done', 'error'].includes(event.value.type))
                  event = await iterator.next()
              entered()
              await new Promise<never>(() => {})
              return { outcome: 'idle' }
            },
          }
        },
      }
      const preset = presetDefaults()
      preset.model.timeoutMs = 5
      const billing: unknown[] = []
      const seams = fakeSeams()
      seams.billing.record = async (row) => {
        billing.push(row)
      }
      const f = await openSession({
        provider: fakeProvider([]),
        loopFactory: orphan,
        preset,
        seams,
        loopStepTimeoutMs: 30,
      })
      // Use a correctly bound deterministic transcript, including a terminal usage report.
      f.session.d.provider = fakeProvider([])
      let cleanups = 0
      f.session.d.provider.infer = async function* (request) {
        try {
          if (mode === 'invalid-no-sent') yield { type: 'text_delta', delta: 'invalid' }
          const event = sentFor(request)
          if (mode === 'invalid-stamp') event.stamp.model.id = 'wrong-model'
          yield event
          yield usage()
          yield { type: 'done', reason: 'stop' }
        } finally {
          cleanups++
        }
      }
      const stop = new AbortController()
      try {
        await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        const running = f.session.run({ until: 'turn-end', signal: stop.signal })
        await started
        if (mode.startsWith('invalid')) expect(cleanups).toBe(1)
        if (mode === 'done') {
          expect(await f.session.scan({ type: 'cost/ledger', limit: 10 })).toHaveLength(1)
          expect(await context.effects.status('abandoned')).toMatchObject({
            status: 'responded',
            result: expect.arrayContaining([{ type: 'done', reason: 'stop' }]),
          })
        }
        if (mode !== 'timeout') stop.abort()
        await vi.advanceTimersByTimeAsync(mode === 'timeout' ? 60 : 5000)
        await running
        const costs = await f.session.scan({ type: 'cost/ledger', limit: 10 })
        expect(costs).toHaveLength(1)
        expect(billing).toHaveLength(1)
        expect(cleanups).toBe(1)
        expect(costs[0]?.data).toMatchObject({ tokens: { output: mode === 'done' ? 5 : 0 } })
        expect(f.session.pendingEffects()).toEqual([])
        if (mode === 'done') {
          await f.session.close()
          let restoredContext!: LoopContext
          const restored = await openSession({
            provider: fakeProvider([]),
            storage: f.storage,
            writerRunId: 'r2',
            loopFactory: {
              ...independent,
              create(ctx) {
                restoredContext = ctx
                return independent.create(ctx, new AbortController().signal)
              },
            },
          })
          try {
            expect(await restoredContext.effects.status('abandoned')).toMatchObject({
              status: 'responded',
              result: expect.arrayContaining([{ type: 'done', reason: 'stop' }]),
            })
          } finally {
            await restored.session.close()
          }
        }
      } finally {
        await f.session.close()
        vi.useRealTimers()
      }
    },
  )

  it.each(['delegation', 'owned-source'] as const)(
    'cancels a hung Inference replacement and cleans its late %s for both Loops',
    async (mode) => {
      for (const loopFactory of [defaultLoopFactory, independent]) {
        let entered!: () => void, release!: () => void, finished!: () => void
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const late = new Promise<void>((resolve) => {
          finished = resolve
        })
        let resourceOpen = true
        let closed!: () => void
        const cleaned = new Promise<void>((resolve) => {
          closed = resolve
        })
        const replacement: ReplacementOperation<'Inference'> = {
          name: 'test.hung-inference',
          slot: { replace: 'Inference' },
          replay: 'never',
          applicable: async () => 'applied',
          run: async () => ({}),
          replace: async ({ next }) => {
            entered()
            await gate
            try {
              if (mode === 'delegation') return await next()
              return {
                [Symbol.asyncIterator]() {
                  return {
                    next: async () => ({ done: true as const, value: undefined }),
                    return: async () => {
                      resourceOpen = false
                      closed()
                      return { done: true as const, value: undefined }
                    },
                  }
                },
              }
            } finally {
              finished()
            }
          },
        }
        const billing: unknown[] = []
        const seams = fakeSeams()
        seams.billing.record = async (row) => {
          billing.push(row)
        }
        const provider = fakeProvider([])
        const f = await openSession({
          provider,
          loopFactory,
          seams,
          operations: [replacement],
          segments: { Inference: replacement },
        })
        const stop = new AbortController()
        try {
          await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
          const running = f.session.run({ until: 'turn-end', signal: stop.signal })
          await started
          stop.abort()
          expect((await running).reason).toBe('aborted')
          expect(await f.session.scan({ type: 'cost/ledger', limit: 10 })).toHaveLength(1)
          expect(billing).toHaveLength(1)
          await f.session.run({ until: 'idle', signal: new AbortController().signal })
          release()
          await late
          if (mode === 'owned-source') {
            await cleaned
            expect(resourceOpen).toBe(false)
          }
          expect(provider.calls).toBe(0)
        } finally {
          release()
          await f.session.close()
        }
      }
    },
  )

  it.each(cases)('settles %s identically through default and independent ports', async (scenario) => {
    const outcomes = []
    for (const loopFactory of [defaultLoopFactory, independent]) {
      const stop = new AbortController()
      const provider = fakeProvider([])
      let sends = 0
      provider.infer = async function* (request) {
        sends++
        if (scenario === 'throw-before-sent') throw new Error('synthetic pre-send failure')
        if (scenario !== 'no-sent') yield sentFor(request)
        yield { type: 'text_delta', delta: 'partial answer' }
        if (['usage', 'usage-twice', 'provider-error', 'cancel-with-usage'].includes(scenario))
          yield {
            ...usage(),
            type: 'usage',
            tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
            credits: 2,
            creditSource: 'gateway',
            billing: { usdMicros: 250, source: 'gateway', subscription: false },
            timing: { ttftMs: 12, durationMs: 30, firstOutputMs: 15 },
          }
        if (scenario === 'usage-twice')
          yield { ...usage(), timing: { ttftMs: 12, durationMs: 30, firstOutputMs: 15 } }
        if (scenario === 'throw') throw new Error('synthetic provider failure')
        if (scenario.startsWith('cancel')) {
          stop.abort()
          await new Promise<never>(() => {})
        }
        if (scenario.includes('error'))
          yield {
            type: 'error',
            reason: 'error',
            code: 'TRANSPORT',
            message: 'synthetic failure',
            retryable: false,
            timing: { outputMs: 20 },
            ...(scenario === 'error-tail-throw'
              ? { response: { status: 503, id: 'original-failure', headerNames: [] } }
              : {}),
          }
        else if (scenario !== 'no-done')
          yield { type: 'done', reason: 'stop', timing: { providerCallMs: 50, finalizeMs: 10 } }
        if (scenario.endsWith('tail-throw')) throw new Error('synthetic tail failure')
      }
      const billing: unknown[] = []
      const seams = fakeSeams()
      seams.billing.record = async (row) => {
        billing.push(row)
      }
      const preset = presetDefaults()
      preset.model.retry.maxAttempts = ['no-done', 'no-sent', 'done-tail-throw', 'error-tail-throw'].includes(
        scenario,
      )
        ? 3
        : 1
      const f = await openSession({ provider, loopFactory, seams, preset })
      try {
        await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        await f.session.run({ until: 'turn-end', signal: stop.signal })
        expect(sends).toBe(1)
        const rows = await f.session.scan({ fromSeq: 1, limit: 200 })
        const costs = rows
          .filter((row) => row.type === 'cost/ledger')
          .map((row) => {
            const { effectId: _effect, ...cost } = row.data as Record<string, unknown>
            return cost
          })
        const records = billing.map((row) => {
          const { effectId: _effect, ...record } = row as Record<string, unknown>
          return record
        })
        expect(costs).toHaveLength(1)
        if (scenario === 'error-tail-throw')
          expect(costs[0]).toMatchObject({ response: { status: 503, id: 'original-failure' } })
        expect(records).toHaveLength(1)
        expect(rows.filter((row) => row.type === 'effect/intent')).toHaveLength(1)
        const settled = rows
          .filter((row) => row.type === 'effect/settled')
          .map((row) => (row.data as { outcome: string }).outcome)
        expect(settled).toHaveLength(1)
        expect(costs[0]).toMatchObject({
          creditSource: ['usage', 'provider-error', 'cancel-with-usage'].includes(scenario)
            ? 'gateway'
            : 'estimated',
          tokens: {
            output:
              scenario === 'usage' ||
              scenario === 'usage-twice' ||
              scenario === 'provider-error' ||
              scenario === 'cancel-with-usage'
                ? 5
                : scenario === 'throw-before-sent' || scenario === 'no-sent'
                  ? 0
                  : 4,
          },
        })
        if (['usage', 'provider-error', 'cancel-with-usage'].includes(scenario)) {
          for (const row of [costs[0], records[0]])
            expect(row).toMatchObject({
              credits: 2,
              creditSource: 'gateway',
              billing: { usdMicros: 250, source: 'gateway' },
              timing: { ttftMs: 12, durationMs: 30, firstOutputMs: 15 },
            })
        }
        if (['usage', 'usage-twice', 'done-tail-throw', 'no-usage'].includes(scenario))
          for (const row of [costs[0], records[0]])
            expect(row).toMatchObject({ timing: { providerCallMs: 50, finalizeMs: 10 } })
        if (scenario === 'provider-error')
          for (const row of [costs[0], records[0]]) expect(row).toMatchObject({ timing: { outputMs: 20 } })
        if (scenario === 'cancel-with-usage') {
          expect(costs[0]).toMatchObject({ interrupted: true })
          expect(costs[0]).not.toHaveProperty('timing.finalizeMs')
        }
        outcomes.push({ costs, records, settled })
      } finally {
        await f.session.close()
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0])
  })
})
