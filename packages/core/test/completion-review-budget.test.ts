import { ToolPolicyRegistry, ToolRuntimeRegistry } from '@agnes/core-effects/effects/tool-providers'
import type { Provider } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createLoopContext } from '../src/loop/ports.js'
import { ToolRegistry } from '../src/registry/tools.js'
import { atReview, input, ran, reopen, run, signal } from './helpers/completion-review.js'
import { fakeProvider, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, readTool, writeTool } from './helpers/open-session.js'

describe('additional completion review admission', () => {
  it('delivers an early local stop to a tool already running in the default batch', async () => {
    let entered: () => void = () => undefined
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let toolSignal: AbortSignal | undefined
    let childDispatches = 0
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    registry.add(
      {
        ...(readTool(async (_args, ctx) => {
          toolSignal = ctx.signal
          entered()
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => resolve(), { once: true })
            if (ctx.signal.aborted) resolve()
          })
          return { content: [{ type: 'text', text: 'read stopped' }] }
        }) as import('@agnes/extension-api').ToolDef),
        name: 'waiting_read',
      },
      { source: 'test', trust: 'builtin' },
    )
    registry.add(
      {
        ...(readTool(async (_args, ctx) => {
          await ready
          await ctx.subagent.spawn('extra work')
          return { content: [] }
        }) as import('@agnes/extension-api').ToolDef),
        name: 'request_child',
      },
      { source: 'test', trust: 'builtin' },
    )
    const one = toolTurn('waiting_read', {})
    const batch = [...one.slice(0, 2), toolTurn('request_child', {}, 1)[1]!, ...one.slice(2)]
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      batch,
      textTurn('must not run'),
    ])
    const h = await atReview({
      registry,
      provider,
      children: {
        create: async () => {
          childDispatches++
          throw new Error('must not start')
        },
      },
    })
    try {
      expect((await run(h)).reason).toBe('blocked')
      expect(toolSignal?.aborted).toBe(true)
      expect(childDispatches).toBe(0)
      expect(provider.requests).toHaveLength(3)
      expect(h.session.ac.signal.aborted).toBe(false)
      expect(h.session.pendingEffects()).toEqual([])
      expect(h.session.state.openStep.size).toBe(0)
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_UNAVAILABLE' },
      })
    } finally {
      await h.session.close()
    }
  })

  it.each(['live', 'cold'] as const)(
    'refuses a non-workspace tool through the real %s batch path',
    async (mode) => {
      let hostDispatches = 0
      const registry = new ToolRegistry()
      registry.add(writeTool(), { source: 'test', trust: 'builtin' })
      registry.add(readTool(), {
        source: 'agnes/computer-use',
        trust: 'builtin',
        packageIdentity: '@agnes/base',
        packageVersion: '1.0.0',
        executionDomain: 'host-computer-use',
      })
      const provider = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        toolTurn('read', {}),
        textTurn('must not run'),
      ])
      let h = await atReview({
        registry,
        provider,
        hostToolDispatch: {
          dispatch: async () => {
            hostDispatches++
            return { phase: 'responded', result: { content: [] } }
          },
        },
      })
      const anchor = await ran(h)
      try {
        if (mode === 'cold') {
          for (
            let n = 0;
            n < 10 && !(await h.log.scan({ type: 'tool/call', fromSeq: anchor.seq, limit: 10 })).length;
            n++
          )
            await h.session.step()
          h = await reopen(h, { hostToolDispatch: h.session.d.hostToolDispatch! })
          await h.session.resume()
        }
        expect((await run(h)).reason).toBe('blocked')
        expect(hostDispatches).toBe(0)
        expect(provider.requests).toHaveLength(3)
        const intents = await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 20 })
        expect(intents.filter((row) => (row.data as { kind: string }).kind === 'tool')).toEqual([])
        expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
          error: { code: 'COMPLETION_REVIEW_UNAVAILABLE' },
        })
        expect(h.session.pendingEffects()).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )

  it('does not bypass the existing turn verifier to preserve the last natural answer', async () => {
    let checks = 0
    const provider = fakeProvider([
      toolTurn('write_note', {}),
      textTurn('candidate'),
      toolTurn('read', {}),
      toolTurn('read', {}),
      textTurn('third final answer'),
    ])
    const h = await atReview({
      provider,
      seams: fakeSeams({
        verifier: {
          verify: async (scope) =>
            scope === 'turn' && ++checks > 1
              ? { verdict: 'fail', reasons: ['schema_invalid'] }
              : { verdict: 'pass', reasons: [] },
        },
      }),
    })
    try {
      expect((await run(h)).reason).toBe('blocked')
      expect(provider.requests).toHaveLength(5)
      expect((await h.log.scan({ type: 'verifier/signal', limit: 50 })).at(-1)?.data).toMatchObject({
        scope: 'turn',
        verdict: 'fail',
      })
    } finally {
      await h.session.close()
    }
  })

  it('keeps a user stop authoritative while an in-flight model crosses the deadline', async () => {
    let now = 1_757_203_200_000
    const scripted = fakeProvider([toolTurn('write_note', {}), textTurn('candidate')])
    let reviewing = false
    let cancel: () => Promise<unknown> = async () => undefined
    const provider: Provider = {
      models: scripted.models,
      async *infer(request, options) {
        if (reviewing) {
          yield sentFor(request)
          now += 60_000
          await cancel()
          yield { type: 'text_delta', delta: 'late' }
          return
        }
        yield* scripted.infer(request, options)
      },
    }
    const h = await atReview({ provider, clock: () => now })
    reviewing = true
    cancel = () => h.session.abort()
    try {
      expect((await run(h)).reason).toBe('aborted')
      const [end] = await h.log.scan({ type: 'turn/end', limit: 10 })
      expect(end?.data).toMatchObject({ error: { code: 'ABORTED' } })
    } finally {
      await h.session.close()
    }
  })

  it.each(['spawn', 'fork', 'resume', 'job', 'compaction', 'decision'] as const)(
    'refuses unsupported Core capability %s before its external dispatch',
    async (capability) => {
      let dispatched = 0
      const registry = new ToolRegistry()
      registry.add(writeTool(), { source: 'test', trust: 'builtin' })
      registry.add(
        readTool(async (_args, ctx) => {
          if (capability === 'spawn') await ctx.subagent.spawn('extra work', { resident: true })
          if (capability === 'fork') await ctx.subagent.fork('extra work')
          if (capability === 'resume') await ctx.subagent.resume('existing-idle-child')
          if (capability === 'job')
            await ctx.artifacts.submitJob({ idempotencyKey: 'extra', payload: { prompt: 'extra work' } })
          if (capability === 'compaction') ctx.requestCompaction('extra model work')
          if (capability === 'decision')
            await ctx.decisions.request({
              key: 'extra',
              purpose: 'tool.permission',
              subject: {},
              prompt: 'Allow extra?',
              options: ['allowed-once', 'rejected'],
              responseSchema: { type: 'null' },
            })
          return { content: [] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      const h = await atReview({
        registry,
        children: {
          create: async () => {
            dispatched++
            throw new Error('must not create child')
          },
          resume: async () => {
            dispatched++
            throw new Error('must not run existing child')
          },
        },
        seams: fakeSeams({
          artifacts: {
            submitJob: async () => {
              dispatched++
              return 'forbidden-job'
            },
          },
        }),
        provider: fakeProvider([
          toolTurn('write_note', {}),
          textTurn('candidate'),
          toolTurn('read', {}),
          textTurn('must not dispatch'),
        ]),
      })
      if (capability === 'compaction') h.session.preset.compaction.enabled = true
      try {
        expect((await run(h)).reason).toBe('blocked')
        expect(dispatched).toBe(0)
        const anchor = await ran(h)
        expect(
          (await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 50 })).every((row) =>
            ['inference', 'tool'].includes((row.data as { kind: string }).kind),
          ),
        ).toBe(true)
        expect(await h.log.scan({ type: 'artifact/job', limit: 10 })).toEqual([])
        expect(await h.session.decisions.list()).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )

  it('refuses side-call preparation and existing-child new work while preserving read-only observation', async () => {
    let messages = 0
    let starts = 0
    let cancellations = 0
    const children = {
      start: async () => {
        starts++
        throw new Error('must not start')
      },
      list: async () => [],
      sendMessage: async () => {
        messages++
        return { messageId: 'extra' }
      },
      interrupt: async () => ({ accepted: false }),
      result: async () => ({ status: 'completed' as const, text: 'existing result' }),
      events: () => ({ async *[Symbol.asyncIterator]() {} }),
      dispose: async () => {
        cancellations++
      },
    }
    const h = await atReview({ loopChildren: children })
    const ctx = await createLoopContext(h.session)
    try {
      expect(await ctx.children!.list()).toEqual([])
      expect(messages + starts + cancellations).toBe(0)
      await expect(ctx.children!.sendMessage('existing', 'extra work', signal())).rejects.toMatchObject({
        code: 'COMPLETION_REVIEW_UNAVAILABLE',
      })
      expect(messages + starts + cancellations).toBe(0)
      expect((await run(h)).reason).toBe('blocked')
    } finally {
      await h.session.close()
    }
    const side = await atReview()
    const sideCtx = await createLoopContext(side.session)
    try {
      await expect(
        sideCtx.sideCall!.prepare({
          target: { route: 'default', model: 'm' },
          label: 'review',
          system: 'extra work',
          messages: [],
        }),
      ).rejects.toMatchObject({ code: 'COMPLETION_REVIEW_UNAVAILABLE' })
      const anchor = await ran(side)
      expect(await side.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 10 })).toEqual([])
    } finally {
      await side.session.close()
    }
  })

  it.each(['cancel', 'interrupt'] as const)(
    'preserves explicit user %s when it races the review deadline',
    async (how) => {
      let now = 1_757_203_200_000
      const h = await atReview({ clock: () => now })
      try {
        now += 60_000
        if (how === 'cancel') await h.session.abort()
        else {
          await h.session.enqueue('next-step', { actor, content: [{ type: 'text', text: 'new direction' }] })
          const item = (await h.session.controls.state()).pending[0]!
          await h.session.controls.apply('interrupt', actor, 'user-interrupt', item.itemId)
        }
        if (how === 'cancel') expect((await run(h)).reason).toBe('aborted')
        const [end] = await h.log.scan({ type: 'turn/end', limit: 10 })
        expect(end?.data).toMatchObject({ reason: how === 'cancel' ? 'aborted' : 'interrupted' })
        expect(end?.data).not.toHaveProperty('error.code', 'COMPLETION_REVIEW_TIME_LIMIT')
        expect(h.session.pendingEffects()).toEqual([])
      } finally {
        await h.session.close()
      }
    },
  )

  it.each(['before', 'preparation', 'provider'] as const)(
    'enforces its deadline at %s without user cancellation or another inference retry',
    async (where) => {
      let now = 1_757_203_200_000
      const scripted = fakeProvider([toolTurn('write_note', {}), textTurn('candidate'), textTurn('late')])
      const provider: Provider = {
        models: scripted.models,
        async *infer(request, options) {
          if (where === 'provider' && scripted.requests.length === 2) {
            scripted.requests.push(request)
            yield sentFor(request)
            now += 60_000
            yield { type: 'text_delta', delta: 'late' }
            return
          }
          yield* scripted.infer(request, options)
        },
      }
      const h = await atReview({ provider, clock: () => now })
      try {
        if (where === 'before') now += 60_000
        if (where === 'preparation') {
          h.session.hooks = {
            ...h.session.hooks,
            beforeStep: async () => {
              now += 60_000
              return {}
            },
          }
        }
        expect((await run(h)).reason).toBe('blocked')
        expect(scripted.requests).toHaveLength(where === 'provider' ? 3 : 2)
        expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
          error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
        })
        expect(h.session.ac.signal.aborted).toBe(false)
        expect(h.session.pendingEffects()).toEqual([])
        expect(h.session.state.openStep.size).toBe(0)
      } finally {
        await h.session.close()
      }
    },
  )

  it('shares atomic admissions with the low-level inference port and counts an abandoned stream', async () => {
    const h = await atReview()
    const ctx = await createLoopContext(h.session)
    try {
      const first = ctx.model.stream(await ctx.prepareRequest(), signal())[Symbol.asyncIterator]()
      expect((await first.next()).done).toBe(false)
      await first.return?.()
      for (let i = 0; i < 2; i++) await ctx.model.complete(await ctx.prepareRequest(), signal())
      await expect(ctx.prepareRequest()).rejects.toMatchObject({ code: 'COMPLETION_REVIEW_REQUEST_LIMIT' })
      expect((await run(h)).reason).toBe('blocked')
      const anchor = await ran(h)
      expect(
        (await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 50 })).filter(
          (row) => (row.data as { kind: string }).kind === 'inference',
        ),
      ).toHaveLength(3)
      expect(h.provider.requests).toHaveLength(5)
      expect(h.session.pendingEffects()).toEqual([])
    } finally {
      await h.session.close()
    }
  })

  it('bounds competing low-level requests by the last remaining admission', async () => {
    const h = await atReview()
    const ctx = await createLoopContext(h.session)
    try {
      for (let i = 0; i < 2; i++) await ctx.model.complete(await ctx.prepareRequest(), signal())
      const requests = await Promise.all([
        ctx.prepareRequest({ invocationId: 'last-a' }),
        ctx.prepareRequest({ invocationId: 'last-b' }),
      ])
      const outcomes = await Promise.allSettled(
        requests.map((request) => ctx.model.complete(request, signal())),
      )
      expect(outcomes.some((outcome) => outcome.status === 'rejected')).toBe(true)
      const anchor = await ran(h)
      const intents = await h.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 100 })
      expect(intents.filter((row) => (row.data as { kind: string }).kind === 'inference')).toHaveLength(3)
      expect(h.provider.requests.length).toBeLessThanOrEqual(5)
      expect((await run(h)).reason).toBe('blocked')
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_REQUEST_LIMIT' },
      })
      expect(h.session.pendingEffects()).toEqual([])
    } finally {
      await h.session.close()
    }
  })

  it.each([
    ['reserve', 'ask'],
    ['reserve', 'allow'],
    ['model', 'ask'],
    ['model', 'allow'],
  ] as const)(
    'refuses guardian %s before dispatch even if the policy falls back to %s',
    async (port, fallback) => {
      const h = await atReview()
      const policies = new ToolPolicyRegistry()
      policies.register('test', {
        id: 'reviewer',
        version: '1',
        async decide(_input, _signal, ports) {
          try {
            if (port === 'reserve') await ports!.reserve(5)
            else await ports!.model({ slot: 'fast', prompt: 'extra review' }, signal())
          } catch {
            /* Deliberately hostile fallback. */
          }
          return { effect: fallback, reason: 'fallback' }
        },
      })
      h.session.d.toolPolicySettings = async () => ({ policy: 'reviewer' })
      // Reopen with the fitted policy rather than changing the session's private registry.
      const reopened = await reopen(h, {
        toolPolicies: policies,
        toolPolicySettings: async () => ({ policy: 'reviewer' }),
        provider: fakeProvider([toolTurn('read', {}), textTurn('must not dispatch')]),
      })
      try {
        expect((await run(reopened)).reason).toBe('blocked')
        expect(
          (await reopened.log.scan({ type: 'cost/ledger', limit: 50 })).some(
            (row) => (row.data as { purpose: string }).purpose === 'approval-guardian',
          ),
        ).toBe(false)
        expect(await reopened.log.scan({ type: 'x/approval/reservation', limit: 10 })).toEqual([])
        expect(await reopened.session.decisions.list()).toEqual([])
        const anchor = await ran(reopened)
        expect(
          (await reopened.log.scan({ type: 'effect/intent', fromSeq: anchor.seq, limit: 50 })).filter(
            (row) => (row.data as { kind: string }).kind === 'tool',
          ),
        ).toEqual([])
      } finally {
        await reopened.session.close()
      }
    },
  )

  it.each(['preparation', 'provider'] as const)(
    'bounds silent %s with its own deadline signal',
    async (where) => {
      vi.useFakeTimers()
      let release: () => void = () => undefined
      let entered: () => void = () => undefined
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const scripted = fakeProvider([
        toolTurn('write_note', {}),
        textTurn('candidate'),
        textTurn('next task'),
      ])
      let active = false
      let requestSignal: AbortSignal | undefined
      const provider: Provider = {
        models: scripted.models,
        async *infer(request, options) {
          if (active && where === 'provider') {
            requestSignal = options?.signal
            yield sentFor(request)
            entered()
            await waiting
            return
          }
          yield* scripted.infer(request, options)
        },
      }
      const h = await atReview({
        provider,
        clock: () => Date.now(),
        timers: {
          setTimeout: (fn, ms) => setTimeout(fn, ms),
          clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        },
      })
      active = true
      if (where === 'preparation')
        h.session.hooks = {
          ...h.session.hooks,
          beforeStep: async () => {
            entered()
            await waiting
            return {}
          },
        }
      try {
        const running = run(h)
        await ready
        await vi.advanceTimersByTimeAsync(60_000)
        release()
        expect((await running).reason).toBe('blocked')
        expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
          error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
        })
        if (where === 'provider') expect(requestSignal?.aborted).toBe(true)
        expect(h.session.ac.signal.aborted).toBe(false)
        expect(h.session.pendingEffects()).toEqual([])
        expect(h.session.state.openStep.size).toBe(0)
        active = false
        h.session.hooks = { ...h.session.hooks, beforeStep: async () => ({}) }
        await h.session.enqueue('next-turn', input)
        expect((await run(h)).reason).toBe('completed')
      } finally {
        release()
        await h.session.close()
        vi.useRealTimers()
      }
    },
  )

  it.each(['entry', 'queue'] as const)('rechecks the nested workspace deadline at %s', async (where) => {
    let now = 1_757_203_200_000
    let writes = 0
    const registry = new ToolRegistry()
    registry.add(
      writeTool(async () => {
        writes++
        return { content: [] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    registry.add(
      readTool(async (_args, ctx) => {
        if (where === 'entry') now += 59_001
        return ctx.tools.invoke('write_note', {})
      }),
      { source: 'test', trust: 'builtin' },
    )
    const runtimes = new ToolRuntimeRegistry()
    runtimes.register('test', {
      id: 'nested-queue',
      version: '1',
      create: () => ({
        async execute(call, port, localSignal) {
          if (call.name === 'write_note') now += 60_000
          return port.dispatch(call, localSignal)
        },
        async batch(calls, port, localSignal) {
          return Promise.all(calls.map((call) => port.dispatch(call, localSignal)))
        },
        cancel() {},
        dispose() {},
      }),
    })
    const h = await atReview({
      registry,
      clock: () => now,
      toolRuntimes: runtimes,
      provider: fakeProvider([toolTurn('write_note', {}), textTurn('candidate'), toolTurn('read', {})]),
    })
    if (where === 'queue') h.session.preset.tools.runtime = 'nested-queue'
    try {
      expect((await run(h)).reason).toBe('blocked')
      expect(writes).toBe(1)
      expect(h.session.pendingEffects()).toEqual([])
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
      })
      expect(await h.session.decisions.list()).toEqual([])
    } finally {
      await h.session.close()
    }
  })

  it.each([999, 0])('refuses queued workspace dispatch with only %s ms remaining', async (remaining) => {
    let now = 1_757_203_200_000
    let dispatched = 0
    const registry = new ToolRegistry()
    registry.add(writeTool(), { source: 'test', trust: 'builtin' })
    registry.add(
      readTool(async () => {
        dispatched++
        return { content: [] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const runtimes = new ToolRuntimeRegistry()
    runtimes.register('test', {
      id: 'queued',
      version: '1',
      create: () => ({
        async execute(call, port, signal) {
          now += 60_000 - remaining
          return port.dispatch(call, signal)
        },
        async batch(calls, port, signal) {
          return Promise.all(calls.map((call) => port.dispatch(call, signal)))
        },
        cancel() {},
        dispose() {},
      }),
    })
    const h = await atReview({
      registry,
      clock: () => now,
      toolRuntimes: runtimes,
      provider: fakeProvider([toolTurn('write_note', {}), textTurn('candidate'), toolTurn('read', {})]),
    })
    h.session.preset.tools.runtime = 'queued'
    try {
      expect((await run(h)).reason).toBe('blocked')
      expect(dispatched).toBe(0)
      expect(h.session.pendingEffects()).toEqual([])
      expect((await h.log.scan({ type: 'turn/end', limit: 10 }))[0]?.data).toMatchObject({
        error: { code: 'COMPLETION_REVIEW_TIME_LIMIT' },
      })
    } finally {
      await h.session.close()
    }
  })
})
