import { withPhase } from '@agnes/core-common/step/op-state'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { Event } from '@agnes/core-common/types'
import { type LoopContext, type LoopFactory, loopCheckpointCodec } from '@agnes/extension-api'
import { defaultLoopFactory } from '@agnes/loop-default'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, type MockInstance, vi } from 'vitest'
import { settleTreeSpend } from '../src/child/runtime-budget.js'
import { ModelExecution } from '../src/execution/model-execution.js'
import { sessionForLoop } from '../src/loop/scope.js'
import type { ReplacementOperation, SessionImpl } from '../src/step/session.js'
import { fakeProvider, sent, sentFor, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, openSession } from './helpers/open-session.js'

// The real tree settlement still runs; the spy only shows which settlement a call reached.
vi.mock('../src/child/runtime-budget.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/child/runtime-budget.js')>()
  return { ...actual, settleTreeSpend: vi.fn(actual.settleTreeSpend) }
})

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

type Script = Provider['infer']
type Controls = Partial<
  Omit<
    ConstructorParameters<typeof ModelExecution>[1],
    'wire' | 'effect' | 'intentSeq' | 'signal' | 'turnId' | 'step' | 'memory' | 'header' | 'headerSeq'
  >
>

const conversationLoops = [defaultLoopFactory, independent]
const hang = () => new Promise<never>(() => {})
const costs = (rows: Event[]) => rows.filter((row) => row.type === 'cost/ledger')
const settledOutcomes = (rows: Event[]) =>
  rows.filter((row) => row.type === 'effect/settled').map((row) => (row.data as { outcome: string }).outcome)

/** A request to a model that is not part of the conversation: its own route and model, no tools. */
const decision = (s: SessionImpl): RequestBody => ({
  kind: 'inference',
  sessionKey: s.key,
  slot: 'fast',
  route: 'decision',
  model: 'decider',
  contractId: null,
  derivedHash: 'c'.repeat(64),
  system: 'Decide.',
  messages: [],
  tools: [],
})

/** A sent stamp that agrees with the request on its model and route, and on nothing else. */
const stampOnly = (request: RequestBody) => {
  const event = sent()
  event.stamp.model = { ...event.stamp.model, id: request.model, route: request.route }
  return event
}

const answer: Script = async function* (request) {
  yield sentFor(request)
  yield { type: 'text_delta', delta: 'partial answer' }
  yield usage()
  yield { type: 'done', reason: 'stop' }
}

/** A non-streaming adapter: nothing arrives until the response does, and here it never does. */
const silent =
  (onRead: () => void): Script =>
  () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        onRead()
        return hang()
      },
      return: async () => ({ done: true as const, value: undefined }),
    }),
  })

async function drain(execution: ModelExecution, onEvent: (event: InferenceEvent) => void = () => undefined) {
  const events: InferenceEvent[] = []
  for await (const event of execution.stream()) {
    events.push(event)
    onEvent(event)
  }
  return events
}

const settle = (execution: ModelExecution, outcome = execution.outcome, interrupted = outcome !== 'ok') =>
  execution.commit(execution.rows(outcome, interrupted), (cur) => cur)

/** One conversation turn through a Loop, against the provider stream the test scripts. */
async function converse(
  loopFactory: LoopFactory,
  script: (stop: AbortController) => Script,
  prepare: (session: SessionImpl) => void = () => undefined,
) {
  const billing: Array<Record<string, unknown>> = []
  const seams = fakeSeams()
  seams.billing.record = async (row) => {
    billing.push(row)
  }
  const stop = new AbortController()
  const provider = fakeProvider([])
  provider.infer = script(stop)
  const f = await openSession({ provider, loopFactory, seams })
  prepare(f.session)
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
    await f.session.run({ until: 'turn-end', signal: stop.signal })
    return { rows: await f.session.scan({ fromSeq: 1, limit: 200 }), billing }
  } finally {
    await f.session.close()
  }
}

type Begin = (controls?: Controls, signal?: AbortSignal) => Promise<ModelExecution>

/**
 * A model call made from inside an open turn the way a call outside the conversation makes it: its
 * own effect, no request header and no step, written through the Loop's scoped session.
 */
async function aside(
  script: Script,
  body: (begin: Begin, s: SessionImpl) => Promise<void>,
  over: Pick<Parameters<typeof openSession>[0], 'operations' | 'segments'> = {},
) {
  const billing: Array<Record<string, unknown>> = []
  const seams = fakeSeams()
  seams.billing.record = async (row) => {
    billing.push(row)
  }
  let session!: SessionImpl
  let failure: unknown
  const loopFactory: LoopFactory = {
    ...independent,
    create(ctx) {
      return {
        checkpoint: () => codec.encode(null),
        cancel() {},
        dispose() {},
        async step() {
          if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
          const s = sessionForLoop(session)
          const started: ModelExecution[] = []
          const begin: Begin = async (controls = {}, signal = new AbortController().signal) => {
            const effect = s.effects.start({ kind: 'side-call', replay: 'never' })
            const [intentSeq] = (await s.d.log.append([effect.intent])).seqs
            const op = s.op()
            if (!op || intentSeq === undefined) throw new Error('expected an open turn')
            const execution = new ModelExecution(s, {
              wire: decision(s),
              effect,
              intentSeq,
              signal,
              turnId: op.meta.turn,
              step: op.step,
              memory: s.turn,
              ...controls,
            })
            started.push(execution)
            return execution
          }
          try {
            await body(begin, s)
          } catch (error) {
            failure = error
            // A failed assertion must not leave a receipt that close() would wait on forever.
            for (const execution of started)
              if (!execution.settled) await settle(execution).catch(() => undefined)
          }
          return ctx.events.finish('completed')
        },
      }
    },
  }
  const provider = fakeProvider([])
  provider.infer = script
  const f = await openSession({ provider, loopFactory, seams, ...over })
  session = f.session
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
    await f.session.run({ until: 'turn-end', signal: new AbortController().signal })
    if (failure) throw failure
    return { rows: await f.session.scan({ fromSeq: 1, limit: 200 }), billing }
  } finally {
    await f.session.close()
  }
}

describe('optional ModelExecution controls for calls outside the conversation', () => {
  describe('cost purpose', () => {
    it('records inference spend when the call names no purpose', async () => {
      for (const loopFactory of conversationLoops) {
        const { rows } = await converse(loopFactory, () => answer)
        expect(costs(rows).map((row) => row.data)).toEqual([
          expect.objectContaining({ purpose: 'inference' }),
        ])
      }
    })

    it('records the purpose the call names', async () => {
      const { rows, billing } = await aside(answer, async (begin) => {
        const execution = await begin({ purpose: 'side-call' })
        await drain(execution)
        await settle(execution)
      })
      expect(costs(rows).map((row) => row.data)).toEqual([expect.objectContaining({ purpose: 'side-call' })])
      expect(billing).toEqual([expect.objectContaining({ purpose: 'side-call' })])
    })
  })

  describe('request header', () => {
    it('checks the stamp against the header and records the receipt when the call has one', async () => {
      for (const loopFactory of conversationLoops) {
        const { rows } = await converse(loopFactory, () => answer)
        const header = rows.find((row) => row.type === 'request/header')
        const intent = rows.find((row) => row.type === 'effect/intent')
        const receipts = rows.filter((row) => row.type === 'request/sent')
        expect(receipts).toHaveLength(1)
        expect(receipts[0]?.sourceEventSeqs).toEqual([header?.seq, intent?.seq])

        const stale = await converse(
          loopFactory,
          () =>
            async function* (request) {
              const event = sentFor(request)
              event.stamp.derived_hash = 'd'.repeat(64)
              yield event
              yield usage()
              yield { type: 'done', reason: 'stop' }
            },
        )
        expect(stale.rows.filter((row) => row.type === 'request/sent')).toEqual([])
        expect(settledOutcomes(stale.rows)).toEqual(['error'])
        // The independent Loop reports its own step failure; the default Loop ends on the code itself.
        if (loopFactory === defaultLoopFactory)
          expect(stale.rows.find((row) => row.type === 'turn/end')?.data).toMatchObject({
            error: { code: 'CONTRACT_MISMATCH' },
          })
      }
    })

    it('without a header, checks only the model and route of the stamp and records no receipt', async () => {
      const { rows } = await aside(
        async function* (request) {
          yield stampOnly(request)
          yield { type: 'text_delta', delta: 'yes' }
          yield usage()
          yield { type: 'done', reason: 'stop' }
        },
        async (begin) => {
          const execution = await begin()
          const events = await drain(execution)
          expect(events.map((event) => event.type)).toEqual(['sent', 'text_delta', 'usage', 'done'])
          expect(execution.outcome).toBe('ok')
          await settle(execution)
        },
      )
      expect(rows.filter((row) => row.type === 'request/sent')).toEqual([])
      expect(settledOutcomes(rows)).toEqual(['ok'])
    })

    it.each(['model', 'route'] as const)(
      'without a header, refuses a stamp for another %s',
      async (field) => {
        const { rows } = await aside(
          async function* (request) {
            const event = stampOnly(request)
            if (field === 'model') event.stamp.model = { ...event.stamp.model, id: 'other' }
            else event.stamp.model = { ...event.stamp.model, route: 'other' }
            yield event
            yield usage()
            yield { type: 'done', reason: 'stop' }
          },
          async (begin) => {
            const execution = await begin()
            expect(await drain(execution)).toEqual([
              expect.objectContaining({ type: 'error', code: 'CONTRACT_MISMATCH', retryable: false }),
            ])
            await settle(execution)
          },
        )
        expect(rows.filter((row) => row.type === 'request/sent')).toEqual([])
        expect(settledOutcomes(rows)).toEqual(['error'])
      },
    )

    it('without a header, still requires sent before any other event', async () => {
      await aside(
        async function* (request) {
          yield { type: 'text_delta', delta: 'early' }
          yield stampOnly(request)
          yield { type: 'done', reason: 'stop' }
        },
        async (begin) => {
          const execution = await begin()
          expect(await drain(execution)).toEqual([
            expect.objectContaining({
              type: 'error',
              code: 'TRANSPORT',
              message: expect.stringContaining('missing sent'),
              retryable: false,
            }),
          ])
          await settle(execution)
        },
      )
    })
  })

  describe('spend that was never reported', () => {
    const estimate = { inputTokens: 1234, credits: 0.5 }
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const cutAfterText = (stop: () => void): Script =>
      async function* (request) {
        yield stampOnly(request)
        yield { type: 'text_delta', delta: 'partial answer' }
        stop()
        await hang()
      }
    const refusal: Script = async function* () {
      yield {
        type: 'error',
        reason: 'error',
        code: 'CONTRACT_MISMATCH',
        message: 'not supported',
        retryable: false,
      }
    }

    it('keeps the conversation rows unchanged: no input estimate and no credits', async () => {
      for (const loopFactory of conversationLoops) {
        const cut = await converse(
          loopFactory,
          (stop) =>
            async function* (request) {
              yield sentFor(request)
              yield { type: 'text_delta', delta: 'partial answer' }
              stop.abort()
              await hang()
            },
        )
        expect(costs(cut.rows).map((row) => row.data)).toEqual([
          expect.objectContaining({
            tokens: { input: 0, output: 4, cacheRead: 0, cacheWrite: 0 },
            creditSource: 'estimated',
            interrupted: true,
          }),
        ])
        expect(costs(cut.rows)[0]?.data).not.toHaveProperty('credits')
        const refused = await converse(loopFactory, () => refusal)
        expect(costs(refused.rows).map((row) => row.data)).toEqual([
          expect.objectContaining({ tokens: zero, creditSource: 'estimated' }),
        ])
        expect(costs(refused.rows)[0]?.data).not.toHaveProperty('credits')
      }
    })

    it.each(['cut after sending', 'cut before any event', 'refused before sending'] as const)(
      'keeps the row unchanged for a call %s that gives no estimate',
      async (mode) => {
        let stop!: () => void
        const script =
          mode === 'cut after sending'
            ? cutAfterText(() => stop())
            : mode === 'cut before any event'
              ? silent(() => stop())
              : refusal
        const { rows } = await aside(script, async (begin) => {
          const execution = await begin()
          stop = () => execution.controller.abort()
          await drain(execution)
          await settle(execution)
        })
        expect(costs(rows).map((cost) => cost.data)).toEqual([
          expect.objectContaining({
            tokens: { ...zero, output: mode === 'cut after sending' ? 4 : 0 },
            creditSource: 'estimated',
          }),
        ])
        expect(costs(rows)[0]?.data).not.toHaveProperty('credits')
      },
    )

    it('estimates a call that sent its request and was cut before any usage', async () => {
      let stop!: () => void
      const { rows, billing } = await aside(
        cutAfterText(() => stop()),
        async (begin) => {
          const signal = new AbortController()
          stop = () => signal.abort()
          const execution = await begin({ unobserved: estimate }, signal.signal)
          await drain(execution)
          await settle(execution)
        },
      )
      const row = {
        tokens: { input: 1234, output: 4, cacheRead: 0, cacheWrite: 0 },
        credits: 0.5,
        creditSource: 'estimated',
        interrupted: true,
      }
      expect(costs(rows).map((cost) => cost.data)).toEqual([expect.objectContaining(row)])
      expect(billing).toEqual([expect.objectContaining(row)])
    })

    it('estimates a call cut before its first event arrived, as a non-streaming adapter is', async () => {
      let deadline!: () => void
      const { rows } = await aside(
        silent(() => deadline()),
        async (begin) => {
          const execution = await begin({ unobserved: estimate })
          deadline = () => execution.controller.abort()
          expect(await drain(execution)).toEqual([expect.objectContaining({ type: 'error' })])
          await settle(execution, 'error', true)
        },
      )
      expect(costs(rows).map((cost) => cost.data)).toEqual([
        expect.objectContaining({
          tokens: { input: 1234, output: 0, cacheRead: 0, cacheWrite: 0 },
          credits: 0.5,
          creditSource: 'estimated',
          interrupted: true,
        }),
      ])
    })

    it('leaves credits out of an estimate that has none', async () => {
      let stop!: () => void
      const { rows } = await aside(
        cutAfterText(() => stop()),
        async (begin) => {
          const signal = new AbortController()
          stop = () => signal.abort()
          const execution = await begin({ unobserved: { inputTokens: 77 } }, signal.signal)
          await drain(execution)
          await settle(execution)
        },
      )
      expect(costs(rows)[0]?.data).toMatchObject({
        tokens: { input: 77, output: 4 },
        creditSource: 'estimated',
        interrupted: true,
      })
      expect(costs(rows)[0]?.data).not.toHaveProperty('credits')
    })

    it('writes a zero row for a call refused before it was sent', async () => {
      const { rows } = await aside(refusal, async (begin) => {
        const execution = await begin({ unobserved: estimate })
        expect(await drain(execution)).toEqual([expect.objectContaining({ code: 'CONTRACT_MISMATCH' })])
        await settle(execution, 'error', false)
      })
      expect(costs(rows).map((cost) => cost.data)).toEqual([
        expect.objectContaining({ tokens: zero, credits: 0, creditSource: 'estimated' }),
      ])
      expect(costs(rows)[0]?.data).not.toHaveProperty('interrupted')
    })

    it('writes a zero row for a call cancelled before its first read', async () => {
      let reads = 0
      const { rows } = await aside(
        async function* (request, options) {
          reads++
          yield* answer(request, options)
        },
        async (begin) => {
          const signal = new AbortController()
          signal.abort()
          const execution = await begin({ unobserved: estimate }, signal.signal)
          await drain(execution)
          await settle(execution)
        },
      )
      expect(reads).toBe(0)
      expect(costs(rows).map((cost) => cost.data)).toEqual([
        expect.objectContaining({ tokens: zero, credits: 0, creditSource: 'estimated' }),
      ])
    })

    it('uses reported usage over the estimate', async () => {
      const { rows } = await aside(answer, async (begin) => {
        const execution = await begin({ unobserved: estimate })
        await drain(execution)
        await settle(execution)
      })
      expect(costs(rows)[0]?.data).toMatchObject({
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        credits: 1,
      })
      expect(costs(rows)[0]?.data).not.toHaveProperty('interrupted')
    })
  })

  describe('tree budget settlement', () => {
    it('settles the session tree permit when the call brings no settlement of its own', async () => {
      for (const loopFactory of conversationLoops) {
        vi.mocked(settleTreeSpend).mockClear()
        const { rows } = await converse(loopFactory, () => answer)
        expect(vi.mocked(settleTreeSpend).mock.calls.map(([, credits, seq]) => [credits, seq])).toEqual([
          [1, costs(rows)[0]?.seq],
        ])
      }
    })

    it('settles through the settlement the call brings', async () => {
      vi.mocked(settleTreeSpend).mockClear()
      const settled: Array<[number | undefined, number]> = []
      const { rows } = await aside(answer, async (begin) => {
        const execution = await begin({
          settleTreeBudget: async (credits, costSeq) => {
            settled.push([credits, costSeq])
          },
        })
        await drain(execution)
        await settle(execution)
      })
      expect(settled).toEqual([[1, costs(rows)[0]?.seq]])
      expect(settleTreeSpend).not.toHaveBeenCalled()
    })
  })

  describe('outcome of a cut call', () => {
    it('records any cancellation as aborted when the call leaves the outcome to Core', async () => {
      let stop!: () => void
      const { rows } = await aside(
        silent(() => stop()),
        async (begin) => {
          const signal = new AbortController()
          stop = () => signal.abort()
          const execution = await begin({}, signal.signal)
          await drain(execution)
          expect(execution.outcome).toBe('aborted')
          await settle(execution, 'error', false)
        },
      )
      expect(settledOutcomes(rows)).toEqual(['aborted'])
      expect(costs(rows)[0]?.data).toMatchObject({ interrupted: true })
    })

    it('records a caller cancellation as an error when the call decides its outcome', async () => {
      let stop!: () => void
      const { rows } = await aside(
        silent(() => stop()),
        async (begin) => {
          const signal = new AbortController()
          stop = () => signal.abort()
          const execution = await begin({ outcomeFromCaller: true }, signal.signal)
          await drain(execution)
          expect(execution.outcome).toBe('error')
          await settle(execution, 'error', false)
        },
      )
      expect(settledOutcomes(rows)).toEqual(['error'])
      expect(costs(rows)[0]?.data).toMatchObject({ interrupted: true })
    })

    it('records only a session stop as aborted when the call decides its outcome', async () => {
      let stop!: () => void
      const { rows } = await aside(
        silent(() => stop()),
        async (begin, s) => {
          const signal = new AbortController()
          stop = () => signal.abort()
          const execution = await begin({ outcomeFromCaller: true }, signal.signal)
          await drain(execution)
          await s.transition([], (cur) =>
            cur
              ? withPhase(cur, cur.phase, {
                  control: { status: 'cancel_requested', requestedAt: 't', by: actor },
                })
              : cur,
          )
          expect(execution.outcome).toBe('aborted')
          await settle(execution)
        },
      )
      expect(settledOutcomes(rows)).toEqual(['aborted'])
    })
  })

  describe('adapter retries', () => {
    it('hands the provider only the signal and tool names by default', async () => {
      for (const loopFactory of conversationLoops) {
        const seen: object[] = []
        await converse(
          loopFactory,
          () =>
            async function* (request, options) {
              seen.push(options)
              yield* answer(request, options)
            },
        )
        expect(seen.map((options) => Object.keys(options).sort())).toEqual([['signal', 'toolNames']])
      }
    })

    it('asks the provider not to retry when the call says so', async () => {
      const seen: object[] = []
      await aside(
        async function* (request, options) {
          seen.push(options)
          yield* answer(request, options)
        },
        async (begin) => {
          const execution = await begin({ retry: false })
          await drain(execution)
          await settle(execution)
        },
      )
      expect(seen).toEqual([expect.objectContaining({ retry: false, toolNames: [] })])
    })
  })

  describe('Inference replacement', () => {
    const recording = (calls: string[]): ReplacementOperation<'Inference'> => ({
      name: 'test.recording-inference',
      slot: { replace: 'Inference' },
      replay: 'never',
      applicable: async () => 'applied',
      run: async () => ({}),
      replace: async ({ next }) => {
        calls.push('replace')
        return await next()
      },
    })
    const counted = (calls: string[]): Script =>
      async function* (request, options) {
        calls.push('provider')
        yield* answer(request, options)
      }

    it('runs an installed replacement by default', async () => {
      const calls: string[] = []
      const replacement = recording(calls)
      await aside(
        counted(calls),
        async (begin) => {
          const execution = await begin()
          await drain(execution)
          await settle(execution)
        },
        { operations: [replacement], segments: { Inference: replacement } },
      )
      expect(calls).toEqual(['replace', 'provider'])
    })

    it('sends straight to the provider when the call cannot be replaced', async () => {
      const calls: string[] = []
      const replacement = recording(calls)
      await aside(
        counted(calls),
        async (begin) => {
          const execution = await begin({ replaceable: false })
          await drain(execution)
          await settle(execution)
        },
        { operations: [replacement], segments: { Inference: replacement } },
      )
      expect(calls).toEqual(['provider'])
    })
  })

  describe('cost row audit fields', () => {
    const audit = ['route', 'adapter', 'endpointHost']

    it('writes no audit fields by default', async () => {
      for (const loopFactory of conversationLoops) {
        const { rows, billing } = await converse(loopFactory, () => answer)
        for (const row of [costs(rows)[0]?.data, billing[0]])
          for (const key of audit) expect(row).not.toHaveProperty(key)
      }
    })

    it('writes the audit fields the call supplies, and nothing else from the object', async () => {
      // A route description carries more than the cost row records.
      const target = {
        route: 'decision',
        model: 'not-the-cost-model',
        adapter: { id: 'jev', version: '1.2.0', apiKeyRef: 'secret' },
        endpointHost: 'api.example.com',
      }
      const { rows, billing } = await aside(answer, async (begin) => {
        const execution = await begin({ extraCostFields: target })
        await drain(execution)
        await settle(execution)
      })
      const expected = {
        route: 'decision',
        adapter: { id: 'jev', version: '1.2.0' },
        endpointHost: 'api.example.com',
      }
      for (const row of [costs(rows)[0]?.data, billing[0]]) {
        expect(row).toMatchObject({ ...expected, model: 'decider' })
        expect((row as { adapter: object }).adapter).toEqual(expected.adapter)
      }
    })
  })

  describe('settlement writer', () => {
    it('commits settlement through a session transition by default', async () => {
      for (const loopFactory of conversationLoops) {
        let transition!: MockInstance<SessionImpl['transition']>
        await converse(
          loopFactory,
          () => answer,
          (session) => {
            transition = vi.spyOn(session, 'transition')
          },
        )
        const settlements = transition.mock.calls.filter(
          ([events]) => Array.isArray(events) && events.some((row) => row.type === 'cost/ledger'),
        )
        expect(settlements).toHaveLength(1)
      }
    })

    it('commits settlement, and what follows it, through the writer the call brings', async () => {
      const writes: string[][] = []
      const settled: number[] = []
      const { rows } = await aside(answer, async (begin, s) => {
        const transition = vi.spyOn(s, 'transition')
        const execution = await begin({
          write: async (events) => {
            writes.push(events.map((row) => row.type))
            return (await s.d.log.append(events)).seqs
          },
          settleTreeBudget: async (_credits, costSeq) => {
            settled.push(costSeq)
          },
        })
        await drain(execution)
        await settle(execution)
        // A later commit adds only the rows the settlement has not written.
        await execution.commit(
          [...execution.rows('ok', false), s.ev('x/test/after-settlement', { n: 1 }, { ignorable: true })],
          (cur) => cur,
        )
        expect(transition).not.toHaveBeenCalled()
        transition.mockRestore()
      })
      expect(writes).toEqual([['cost/ledger', 'effect/settled'], ['x/test/after-settlement']])
      expect(settled).toEqual([costs(rows)[0]?.seq])
      expect(rows.filter((row) => row.type === 'x/test/after-settlement')).toHaveLength(1)
    })
  })

  it('settles a revoked call through the caller writer, budget and outcome as a late receipt', async () => {
    vi.useFakeTimers()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const writes: string[][] = []
    const settled: Array<[number | undefined, number]> = []
    let session!: SessionImpl
    const loopFactory: LoopFactory = {
      ...independent,
      create(ctx) {
        return {
          checkpoint: () => codec.encode(null),
          cancel() {},
          dispose() {},
          async step() {
            await ctx.input.accept()
            const s = sessionForLoop(session)
            const effect = s.effects.start({ kind: 'side-call', replay: 'never' })
            const [intentSeq] = (await s.d.log.append([effect.intent])).seqs
            const op = s.op()
            if (!op || intentSeq === undefined) throw new Error('expected an open turn')
            const execution = new ModelExecution(s, {
              wire: decision(s),
              effect,
              intentSeq,
              signal: new AbortController().signal,
              turnId: op.meta.turn,
              step: op.step,
              memory: s.turn,
              purpose: 'side-call',
              unobserved: { inputTokens: 1234, credits: 0.5 },
              outcomeFromCaller: true,
              settleTreeBudget: async (credits, costSeq) => {
                settled.push([credits, costSeq])
              },
              write: async (events) => {
                writes.push(events.map((row) => row.type))
                return (await s.d.log.append(events)).seqs
              },
            })
            void drain(execution, () => entered())
            await hang()
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
    const provider = fakeProvider([])
    provider.infer = async function* (request) {
      yield stampOnly(request)
      await hang()
    }
    const f = await openSession({ provider, loopFactory, preset, seams, loopStepTimeoutMs: 30 })
    session = f.session
    const warn = vi.spyOn(f.session.d.logger, 'warn')
    try {
      await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      const running = f.session.run({ until: 'turn-end', signal: new AbortController().signal })
      await started
      await vi.advanceTimersByTimeAsync(60)
      await running
      const rows = await f.session.scan({ fromSeq: 1, limit: 200 })
      const [cost] = costs(rows)
      expect(costs(rows)).toHaveLength(1)
      expect(cost?.data).toMatchObject({
        purpose: 'side-call',
        tokens: { input: 1234 },
        credits: 0.5,
        creditSource: 'estimated',
        interrupted: true,
      })
      expect(rows.filter((row) => row.type === 'effect/settled')).toEqual([])
      const receipts = rows.filter((row) => row.type === 'x/core/late-effect-receipt')
      expect(receipts.map((row) => row.data)).toEqual([
        expect.objectContaining({ effects: [expect.objectContaining({ outcome: 'error' })] }),
      ])
      expect(writes).toEqual([['cost/ledger', 'effect/settled']])
      expect(settled).toEqual([[0.5, cost?.seq]])
      expect(billing).toHaveLength(1)
      expect(warn).not.toHaveBeenCalledWith('model receipt settlement failed', expect.anything())
      expect(f.session.pendingEffects()).toEqual([])
    } finally {
      await f.session.close()
      vi.useRealTimers()
    }
  })
})
