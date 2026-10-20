import { defaultIds } from '@agnes/core-common/ids'
import type { LoopRegistry } from '@agnes/core-common/loop/registry'
import { presetDefaults } from '@agnes/core-common/step/preset'
import { ToolRuntimeRegistry } from '@agnes/core-effects/effects/tool-providers'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import { openTracked } from '@agnes/core-ledger/reduce/tracker'
import {
  DEFAULT_LOOP,
  type LoopContext,
  type LoopDriver,
  type LoopFactory,
  loopCheckpointCodec,
  type ToolDef,
  type ToolRuntime,
} from '@agnes/extension-api'
import { defineWorkflowLoop } from '@agnes/plugin-runtime'
import { validateMethod } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createDagLoop } from '../../../examples/loops/dag-loop/index.mjs'
import { createDecisionLoop } from '../../../examples/loops/decision-loop/index.mjs'
import { createReactLoop } from '../../../examples/loops/react-loop/index.mjs'
import { Kernel } from '../src/kernel.js'
import { LoopEventRegistry } from '../src/loop/events.js'
import { createLoopContext, disposeLoopContext } from '../src/loop/ports.js'
import { applyBeforeRequestPatches } from '../src/request/transforms.js'
import { noopHooks } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, sentFor, textTurn, usage } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  openSession,
  readTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const codec = loopCheckpointCodec(1, (state) => {
  if (state !== 'ready' && state !== 'done') throw new Error('invalid echo checkpoint')
  return state
})
/** Uses only extension-api ports. It never invokes any default phase operation. */
function echoDriver(ctx: LoopContext, initial: 'ready' | 'done' = 'ready'): LoopDriver {
  let state = initial
  return {
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode(state),
    async step(signal) {
      const input = await ctx.input.accept()
      if (!input) return { outcome: 'idle', phase: 'idle' }
      const result = await ctx.tools.execute({ name: 'read', args: {} }, signal)
      const batch = await ctx.tools.batch([{ name: 'read', args: {} }], signal)
      const request = await ctx.prepareRequest({
        tools: [],
        messages: [{ role: 'user', content: [...input.content] }],
      })
      const response = await ctx.model.complete(request, signal)
      const text = response.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
      await ctx.events.assistant(
        {
          content: [{ type: 'text', text }],
          stopReason: 'end_turn',
        },
        codec.encode('done'),
      )
      await ctx.events.emit('result', {
        single: result.content,
        batch: batch.map((item) => item.content),
      })
      state = 'done'
      await ctx.checkpoints.write(codec.encode(state))
      await ctx.events.finish('completed')
      return { outcome: 'turn-ended', phase: 'terminal', reason: 'completed' }
    },
  }
}
const echo: LoopFactory = {
  id: 'test.echo',
  version: '1.0.0',
  capabilities: ['model', 'tools'],
  codec,
  create: (ctx) => echoDriver(ctx),
  resume: (ctx, checkpoint) => echoDriver(ctx, codec.decode(checkpoint)),
}
const options = {
  actor,
  resolvedProfileHash: null,
  cwd: '/w',
  writerRunId: 'test-writer',
  workspaceInvocation: testWorkspaceInvocation(),
}
const model = {
  id: 'm',
  route: 'default',
  name: 'fake',
  api: 'openai-completions' as const,
  baseUrl: 'https://test.invalid',
  input: ['text', 'image'] as ('text' | 'image')[],
  reasoning: false,
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'] as 'native'[],
  thinkingReplay: 'native' as const,
  contract_id: null,
}
function kernel(
  storage = new MemoryStorage(),
  loops = defaultLoops(),
  extra: Partial<import('../src/kernel.js').KernelOptions> = {},
) {
  const provider = fakeProvider([textTurn('independent answer')])
  provider.models = () => [model]
  return Kernel.create({
    storage,
    loops,
    seams: fakeSeams(),
    provider,
    contract: { contract_id: null, parser_version: '1' },
    preset: presetDefaults(),
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    imageInputTokenFallback: async ({ imageCount }) => ({ tokens: 100, imageCount }),
    ...extra,
  })
}

describe('loop plugins', () => {
  it.each([false, true])(
    'uses the controlled custom-loop ports with deferLoading=%s',
    async (deferLoading) => {
      const loops = defaultLoops()
      loops.register('@test/echo', echo)
      const toolRuntimes = new ToolRuntimeRegistry(false)
      toolRuntimes.register('@test/serial', {
        id: 'serial',
        version: '1.0.0',
        create: () => ({
          async execute(call, port, signal) {
            const result = await port.dispatch(call, signal)
            return { ...result, content: [{ type: 'text', text: 'independent runtime' }] }
          },
          async batch(calls, port, signal) {
            const results = []
            for (const call of calls) results.push(await port.dispatch(call, signal))
            return results
          },
          cancel() {},
          dispose() {},
        }),
      })
      const loopEvents = new LoopEventRegistry()
      const responses: unknown[] = []
      loopEvents.on('after_model_response', (payload) => {
        responses.push(payload.content)
      })
      loopEvents.on('before_model_request', (payload) => {
        expect(payload.request.maxTokens).toBe(12)
        return { patch: { maxTokens: 14 } }
      })
      const preset = presetDefaults()
      preset.tools.runtime = 'serial'
      const k = kernel(new MemoryStorage(), loops, { toolRuntimes, loopEvents, preset })
      const tool = readTool() as ToolDef
      k.tools.add({ ...tool, meta: { ...tool.meta, deferLoading } }, { source: 'test', trust: 'builtin' })
      const session = await k.session('independent-runtime', { ...options, loop: echo })
      session.hooks = {
        ...noopHooks,
        beforeRequest: async (output) =>
          applyBeforeRequestPatches(output, [{ ext: 'test', patch: { maxTokens: 12 } }]),
      }
      try {
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        const rows = await session.scan({ fromSeq: 1, limit: 200 })
        expect(rows.filter((row) => row.type === 'tool/result').map((row) => row.data)).toEqual([
          expect.objectContaining({ content: [{ type: 'text', text: 'independent runtime' }] }),
          expect.objectContaining({ content: [{ type: 'text', text: 'independent runtime' }] }),
        ])
        expect(responses).toEqual([[{ type: 'text', text: 'independent answer' }]])
        expect(rows.filter((row) => row.type === 'x/core/tool-disclosed')).toEqual([])
        expect((k.o.provider as ReturnType<typeof fakeProvider>).requests[0]?.tools).toEqual([])
        expect((k.o.provider as ReturnType<typeof fakeProvider>).requests[0]?.sampling?.maxTokens).toBe(14)
      } finally {
        await k.close()
      }
    },
  )

  /** A driver whose one step does `work` between accepting the input and completing the turn. */
  const working = (id: string, work: (ctx: LoopContext, signal: AbortSignal) => Promise<unknown>) => {
    const create = (ctx: LoopContext): LoopDriver => ({
      ...echoDriver(ctx),
      async step(signal) {
        if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
        await work(ctx, signal)
        await ctx.events.finish('completed')
        return { outcome: 'turn-ended', phase: 'terminal', reason: 'completed' }
      },
    })
    return { ...echo, id, create, resume: create } satisfies LoopFactory
  }
  const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))
  const never = () => new Promise<never>(() => undefined)
  const modelCall = async (ctx: LoopContext, signal: AbortSignal) =>
    ctx.model.complete(await ctx.prepareRequest({ tools: [], messages: [] }), signal)
  /** A model stream that starts and then neither produces an event nor honours its signal. */
  const deafProvider = () => {
    const provider = fakeProvider([])
    provider.models = () => [model]
    provider.infer = async function* (request) {
      provider.calls++
      yield sentFor(request)
      await never()
    }
    return provider
  }
  const quickPreset = () => {
    const preset = presetDefaults()
    preset.model.timeoutMs = 5
    return preset
  }

  it.each([
    [
      'an invalid assistant row',
      async (ctx: LoopContext) => {
        await ctx.events.assistant(
          { content: 'private-row-canary' as never, stopReason: 'end_turn' },
          codec.encode('done'),
        )
      },
      {},
    ],
    ['a step that never settles', never, {}],
    ['a model call that goes silent and ignores cancellation', modelCall, { provider: deafProvider() }],
  ] as const)(
    'ends the turn as an error and releases close when the driver is stuck in %s',
    async (_name, work, extra) => {
      const stuck = working('test.stuck', work)
      const loops = defaultLoops()
      loops.register('@test/stuck', stuck)
      const k = kernel(new MemoryStorage(), loops, { loopStepTimeoutMs: 30, preset: quickPreset(), ...extra })
      const session = await k.session('stuck-driver', { ...options, loop: stuck })
      try {
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(outcome.reason).toBe('error')
        if (_name !== 'an invalid assistant row') expect(outcome.error?.message).toContain('test.stuck@1.0.0')
        const rows = await session.scan({ fromSeq: 1, limit: 200 })
        expect(JSON.stringify(rows.map((row) => row.data))).toContain('step-threw')
        if (_name === 'an invalid assistant row') {
          expect(outcome.error?.code).toBe('E_STEP_FAILED')
          expect(outcome.error?.message).toContain('assistant/message /data/content')
          const invariant = rows.find(
            (row) => row.type === 'x/core/invariant' && (row.data as { kind?: string }).kind === 'step-threw',
          )
          expect(invariant?.data).toMatchObject({
            message: expect.stringContaining('assistant/message /data/content'),
          })
          expect(outcome.error?.message).not.toMatch(/private-row-canary/)
          expect(JSON.stringify(invariant?.data)).not.toContain('private-row-canary')
        }
      } finally {
        await k.close()
      }
    },
  )

  it('refuses every old driver write after timeout and a replacement turn', async () => {
    let old!: LoopContext
    let release!: () => void
    let finished!: () => void
    const resumed = new Promise<void>((resolve) => {
      finished = resolve
    })
    const failures: unknown[] = []
    let nextStarted!: () => void
    let finishNext!: () => void
    const nextReady = new Promise<void>((resolve) => {
      nextStarted = resolve
    })
    let first = true
    const stuck = working('test.stale', async (ctx) => {
      if (!first) {
        nextStarted()
        await new Promise<void>((resolve) => {
          finishNext = resolve
        })
        return
      }
      first = false
      old = ctx
      await new Promise<void>((resolve) => {
        release = resolve
      })
      const signal = new AbortController().signal
      for (const write of [
        () =>
          old.events.assistant(
            { content: [{ type: 'text', text: 'late' }], stopReason: 'end_turn' },
            codec.encode('done'),
          ),
        () => old.checkpoints.write(codec.encode('done')),
        () => modelCall(old, signal),
        () => old.tools.execute({ name: 'read', args: {} }, signal),
        () => old.events.emit('late', {}),
        () => old.input.accept(),
        () => old.wait.wake(),
        () => old.events.finish('completed'),
      ]) {
        try {
          await write()
          failures.push('accepted')
        } catch (error) {
          failures.push(error)
        }
      }
      finished()
    })
    const loops = defaultLoops()
    loops.register('@test/stale', stuck)
    const k = kernel(new MemoryStorage(), loops, { loopStepTimeoutMs: 30, preset: quickPreset() })
    const session = await k.session('stale-driver', { ...options, loop: stuck })
    try {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'error',
      )
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
      const next = session.run({ until: 'turn-end', signal: new AbortController().signal })
      await nextReady
      const before = await session.scan({ fromSeq: 1, limit: 200 })
      const projection = await session.projectUI()
      release()
      await resumed
      expect(failures).toHaveLength(8)
      for (const error of failures) expect(error).toMatchObject({ code: 'E_CLOSED' })
      expect(await session.scan({ fromSeq: 1, limit: 200 })).toEqual(before)
      expect(await session.projectUI()).toEqual(projection)
      finishNext()
      expect((await next).reason).toBe('completed')
    } finally {
      await k.close()
    }
  })

  it.each(['checkpoint', 'assistant', 'input', 'wake'] as const)(
    'rechecks a queued %s write at final commit admission',
    async (kind) => {
      const f = await openSession({ provider: fakeProvider([]), loopFactory: echo })
      const ctx = await createLoopContext(f.session)
      const append = f.log.append.bind(f.log)
      try {
        await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        if (kind !== 'input') await ctx.input.accept()
        const before = await f.session.scan({ fromSeq: 1, limit: 200 })
        const gate = vi.spyOn(f.log, 'append').mockImplementation((events, options) =>
          append(events, {
            ...options,
            beforeCommit: async () => {
              await options?.beforeCommit?.()
              f.session.loopScope.revoke()
            },
          }),
        )
        const write =
          kind === 'checkpoint'
            ? () => ctx.checkpoints.write(codec.encode('done'))
            : kind === 'assistant'
              ? () =>
                  ctx.events.assistant(
                    { content: [{ type: 'text', text: 'late' }], stopReason: 'end_turn' },
                    codec.encode('done'),
                  )
              : kind === 'input'
                ? () => ctx.input.accept()
                : () => ctx.wait.wake()
        await expect(write()).rejects.toMatchObject({ code: 'E_CLOSED' })
        gate.mockRestore()
        expect(await f.session.scan({ fromSeq: 1, limit: 200 })).toEqual(before)
      } finally {
        disposeLoopContext(ctx)
        await f.session.close()
      }
    },
  )

  it('recovers a late real tool receipt on its original invocation after replacement and cold restore', async () => {
    let release!: () => void
    let settled!: () => void
    const finished = new Promise<void>((resolve) => {
      settled = resolve
    })
    let first = true
    let latest!: LoopContext
    const loop = working('test.late-receipt', async (ctx, signal) => {
      latest = ctx
      if (!first) return
      first = false
      await ctx.checkpoints.write(codec.encode('ready'))
      try {
        await ctx.tools.execute({ name: 'read', args: {}, invocationId: 'original' }, signal)
      } catch (error) {
        expect(error).toMatchObject({ code: 'E_CLOSED' })
      } finally {
        settled()
      }
    })
    const events = new LoopEventRegistry()
    events.on('after_tool_result', async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {}
    })
    const loops = defaultLoops()
    loops.register('@test/late-receipt', loop)
    const storage = new MemoryStorage()
    const k = kernel(storage, loops, { loopEvents: events, loopStepTimeoutMs: 30, preset: quickPreset() })
    k.tools.add(readTool() as ToolDef, { source: 'test', trust: 'builtin' })
    try {
      const session = await k.session('late-receipt', { ...options, loop })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'error',
      )
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'next' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      const projection = await session.projectUI()
      release()
      await finished
      expect(await latest.effects.status('original')).toMatchObject({
        status: 'responded',
        result: { content: [{ type: 'text', text: 'read:{}' }] },
      })
      expect(session.op()).toBeNull()
      expect((await session.projectUI()).turns).toEqual(projection.turns)
    } finally {
      await k.close()
    }
    const restored = kernel(storage, loops)
    try {
      const session = await restored.session('late-receipt', options)
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'restore' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(await latest.effects.status('original')).toMatchObject({
        status: 'responded',
        result: { content: [{ type: 'text', text: 'read:{}' }] },
      })
    } finally {
      await restored.close()
    }
  })

  it('does not let a queued old child start borrow the replacement scope', async () => {
    let starts = 0
    const f = await openSession({
      provider: fakeProvider([]),
      loopFactory: echo,
      bindLoopChildren: () => ({
        start: async () => {
          starts++
          throw new Error('must not start')
        },
        list: async () => [],
        sendMessage: async () => ({ messageId: 'm' }),
        interrupt: async () => ({ accepted: true }),
        result: async () => ({ status: 'completed', text: '' }),
        events: async function* () {},
        dispose: async () => {},
      }),
    })
    const ctx = await createLoopContext(f.session)
    const append = f.log.append.bind(f.log)
    try {
      await ctx.checkpoints.write(codec.encode('ready'))
      const gate = vi.spyOn(f.log, 'append').mockImplementation(async (events, options) => {
        const result = await append(events, options)
        if (events.some((row) => row.type === 'x/core/loop-child-start')) await f.session.restartLoopDriver()
        return result
      })
      await expect(ctx.children!.start('old child')).rejects.toMatchObject({ code: 'E_CLOSED' })
      gate.mockRestore()
      expect(starts).toBe(0)
      const fresh = await createLoopContext(f.session)
      try {
        expect(await fresh.children!.list()).toEqual([])
      } finally {
        disposeLoopContext(fresh)
      }
    } finally {
      disposeLoopContext(ctx)
      await f.session.close()
    }
  })

  it('closes within its drain window while a port call ignores cancellation', async () => {
    const stuck = working('test.deaf', modelCall)
    const loops = defaultLoops()
    loops.register('@test/deaf', stuck)
    const provider = deafProvider()
    const k = kernel(new MemoryStorage(), loops, { closeDrainMs: 30, provider })
    const session = await k.session('deaf-port', { ...options, loop: stuck })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
    void session.run({ until: 'turn-end', signal: new AbortController().signal }).catch(() => undefined)
    await vi.waitFor(() => expect(provider.calls).toBe(1))
    await expect(k.close()).resolves.toBeUndefined()
  })

  it('ends a cancelled deaf driver before its idle deadline and can run the next turn', async () => {
    vi.useFakeTimers()
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let first = true
    const stuck = working('test.cancel-bound', async () => {
      if (!first) return
      first = false
      entered()
      await never()
    })
    const loops = defaultLoops()
    loops.register('@test/cancel-bound', stuck)
    const k = kernel(new MemoryStorage(), loops)
    try {
      const session = await k.session('cancel-bound', { ...options, loop: stuck })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
      await started
      const cancelled = new Promise<void>((resolve) =>
        session.ac.signal.addEventListener('abort', () => resolve(), { once: true }),
      )
      const stopping = session.controls.apply('cancel', actor, 'cancel-deaf')
      await cancelled
      await vi.advanceTimersByTimeAsync(5000)
      await stopping
      expect((await running).reason).toBe('aborted')
      expect(session.op()).toBeNull()
      expect((await session.scan({ type: 'turn/end', order: 'desc', limit: 1 }))[0]?.data).toMatchObject({
        reason: 'aborted',
      })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
    } finally {
      await k.close()
      vi.useRealTimers()
    }
  })

  it.each([
    [
      'a tool inside its own timeout',
      (ctx: LoopContext, signal: AbortSignal) => ctx.tools.execute({ name: 'read', args: {} }, signal),
    ],
    [
      'a running child agent',
      async (ctx: LoopContext) => {
        const child = await ctx.children!.start('work')
        for await (const _event of child.events());
        await child.result()
      },
    ],
    ['a model response that keeps streaming', modelCall],
  ] as const)('does not count %s as a silent driver', async (_name, work) => {
    const busy = working('test.busy', work)
    const loops = defaultLoops()
    loops.register('@test/busy', busy)
    const provider = fakeProvider([])
    provider.models = () => [model]
    provider.infer = async function* (request) {
      yield sentFor(request)
      for (let i = 0; i < 12; i++) yield await later(12, { type: 'text_delta' as const, delta: '.' })
      yield usage()
      yield { type: 'done', reason: 'stop' }
    }
    const child = {
      id: 'child-1',
      providerId: 'test',
      capabilities: {} as never,
      sendMessage: async () => ({ messageId: 'm1' }),
      interrupt: async () => ({ accepted: true }),
      events: async function* () {
        for (let i = 0; i < 2; i++) yield await later(60, { type: 'text' as const, text: 'working' })
      },
      result: () => later(60, { status: 'completed' as const, text: 'done' }),
      dispose: async () => {},
    }
    const k = kernel(new MemoryStorage(), loops, {
      loopStepTimeoutMs: 30,
      preset: quickPreset(),
      provider,
      loopChildren: () => ({
        start: async () => child,
        list: async () => [],
        sendMessage: child.sendMessage,
        interrupt: child.interrupt,
        result: child.result,
        events: child.events,
        dispose: child.dispose,
      }),
    })
    k.tools.add(readTool(async () => later(150, { content: [{ type: 'text', text: 'slow' }] })) as ToolDef, {
      source: 'test',
      trust: 'builtin',
    })
    const session = await k.session('busy-driver', { ...options, loop: busy })
    try {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome).toMatchObject({ reason: 'completed' })
    } finally {
      await k.close()
    }
  })

  it.each(['loop', 'tool-runtime'] as const)(
    'aborts and drains a late %s constructor before closing Kernel storage',
    async (kind) => {
      const loops = defaultLoops()
      const toolRuntimes = new ToolRuntimeRegistry()
      let finish!: (driver: LoopDriver | ToolRuntime) => void
      let ready!: () => void
      const admitted = new Promise<void>((resolve) => {
        ready = resolve
      })
      let signal!: AbortSignal
      let disposed = false
      const construct = (joined?: AbortSignal) => {
        if (!joined) throw new Error('Missing construction signal')
        signal = joined
        ready()
        return new Promise<LoopDriver | ToolRuntime>((resolve) => {
          finish = resolve
        })
      }
      if (kind === 'loop')
        loops.register('@test/async', {
          ...echo,
          id: 'test.async',
          create: (_ctx, joined) => construct(joined) as Promise<LoopDriver>,
        })
      else {
        toolRuntimes.register('@test/async', {
          id: 'test.async',
          version: '1.0.0',
          create: (_options, joined) => construct(joined) as Promise<ToolRuntime>,
        })
      }
      const storage = new MemoryStorage()
      const closed = vi.spyOn(storage, 'close')
      const preset = presetDefaults()
      if (kind === 'tool-runtime') preset.tools.runtime = 'test.async'
      const k = kernel(storage, loops, { toolRuntimes, preset })
      const creating = k.session('constructing', {
        ...options,
        ...(kind === 'loop' ? { loop: { id: 'test.async', version: echo.version } } : {}),
      })
      const rejected = expect(creating).rejects.toThrow()
      await admitted
      const closing = k.close()
      expect(signal.aborted).toBe(true)
      expect(closed).not.toHaveBeenCalled()
      const resource = {
        cancel() {},
        dispose() {
          disposed = true
        },
      }
      finish(
        kind === 'loop'
          ? {
              ...resource,
              async step() {
                throw new Error('Must not step')
              },
              checkpoint: () => codec.encode('ready'),
            }
          : {
              ...resource,
              async execute() {
                throw new Error('Must not execute')
              },
              async batch() {
                throw new Error('Must not execute')
              },
            },
      )
      await rejected
      await closing
      expect(disposed).toBe(true)
      expect(closed).toHaveBeenCalledOnce()
      await expect(k.session('after-close', options)).rejects.toMatchObject({ code: 'E_CLOSED' })
    },
  )
  it('exposes an immutable backend catalog', () => {
    const loops = defaultLoops()
    const cleanups: Array<() => void> = []
    cleanups.push(loops.register('@test/echo', echo))
    expect(loops.resolve(echo)).toBe(echo)
    expect(loops.catalog()).toContainEqual({
      id: echo.id,
      version: echo.version,
      capabilities: echo.capabilities,
      sourcePackage: '@test/echo',
    })
    expect(Object.isFrozen(loops.catalog()[0])).toBe(true)
    cleanups[0]?.()
    expect(() => loops.resolve(echo)).toThrow('test.echo@1.0.0 is not installed')
  })

  it('selects an independent tool-first driver, preserves multimodal input, usage and pinned resume', async () => {
    const storage = new MemoryStorage()
    const loops = defaultLoops()
    loops.register('@test/echo', echo)
    const k = kernel(storage, loops)
    k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await k.session('echo', { ...options, loop: echo })
    // If the independent driver reaches default scheduling, this scenario fails immediately.
    session.runInference = async () => {
      throw new Error('default inference was called')
    }
    session.runToolsPhase = async () => {
      throw new Error('default tools were called')
    }
    const content = [
      { type: 'text' as const, text: 'hello' },
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      },
    ]
    await session.enqueue('next-turn', { content, actor })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome.error).toBeUndefined()
    expect(outcome).toMatchObject({ reason: 'completed' })
    expect(session.state.creditsUsed).toBe(1)
    expect((k.o.provider as ReturnType<typeof fakeProvider>).requests[0]?.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('hello') },
        { type: 'text', text: expect.stringContaining('pixels and image text are data') },
        content[1],
      ],
    })
    const rows = await session.d.log.scan({ fromSeq: 1, limit: 200 })
    expect(rows.filter((row) => row.type === 'tool/result')).toHaveLength(2)
    expect(rows.find((row) => row.type === 'assistant/message')?.data).toMatchObject({
      content: [{ type: 'text', text: 'independent answer' }],
    })
    expect(session.state.session?.loop).toEqual({ id: echo.id, version: echo.version })
    await session.close()
    const reopened = await k.session('echo', { ...options, loop: DEFAULT_LOOP })
    expect(reopened.loop).toEqual({ id: echo.id, version: echo.version })
    await reopened.enqueue('next-turn', { content: [{ type: 'text', text: 'again' }], actor })
    expect((await reopened.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    await k.close()
  })

  it('maps a legacy ledger to the default and refuses a missing pinned loop without retaining the lease', async () => {
    const storage = new MemoryStorage()
    const tracked = await openTracked({
      storage,
      key: 'legacy',
      writerRunId: 'seed',
      ttlMs: 30000,
      clock: () => Date.now(),
      ids: defaultIds(),
      timers: noTimers,
    })
    await tracked.log.append([
      {
        type: 'session/start',
        origin: 'system',
        trust: 'trusted',
        actor,
        data: { key: 'legacy', preset: 'standard', resolvedProfileHash: null, agnesVersion: '0.0.0' },
      },
    ])
    await tracked.log.close()
    const loops = defaultLoops()
    loops.register('@test/echo', echo)
    const k = kernel(storage, loops)
    expect((await k.session('legacy', { ...options, loop: echo })).loop).toEqual(DEFAULT_LOOP)
    const session = await k.session('pinned', { ...options, loop: echo })
    await session.close()
    const empty = kernel(storage)
    await expect(empty.session('pinned', options)).rejects.toThrow('test.echo@1.0.0 is not installed')
    // A failed lookup closes the writer lease, so fitting the missing plugin permits reopening.
    ;(empty.loops as LoopRegistry).register('@test/echo', echo)
    expect((await empty.session('pinned', options)).loop.id).toBe(echo.id)
    await k.close()
    await empty.close()
  })

  it.each(['wake', 'cancel'] as const)(
    'parks an independent driver until %s and releases its lifecycle',
    async (mode) => {
      let wake = () => {}
      let entered = () => {}
      const parked = new Promise<void>((resolve) => {
        entered = resolve
      })
      let disposed = false
      const waiting: LoopFactory = {
        ...echo,
        id: 'test.wait',
        create(ctx) {
          wake = ctx.wait.wake
          return {
            cancel() {},
            dispose() {
              disposed = true
            },
            checkpoint: () => codec.encode('ready'),
            async step(signal) {
              if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
              entered()
              await ctx.wait.park(signal)
              const reason = signal.aborted ? 'aborted' : 'completed'
              await ctx.events.finish(reason)
              return { outcome: 'turn-ended', phase: 'terminal', reason }
            },
          }
        },
      }
      const loops = defaultLoops()
      loops.register('@test/wait', waiting)
      const k = kernel(new MemoryStorage(), loops)
      const session = await k.session('wait', { ...options, loop: waiting })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'wait' }], actor })
      const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
      await parked
      if (mode === 'cancel') await session.abort()
      else wake()
      expect((await running).reason).toBe(mode === 'cancel' ? 'aborted' : 'completed')
      expect(session.op()).toBeNull()
      await k.close()
      expect(disposed).toBe(true)
    },
  )

  it('selects a profile loop and refuses checkpoint codec mismatch before resumed work', async () => {
    const loops = defaultLoops()
    loops.register('@test/echo', echo)
    const k = kernel(new MemoryStorage(), loops)
    const session = await k.session('codec', {
      ...options,
      preset: { ...presetDefaults(), loop: { id: echo.id, version: echo.version } },
    })
    expect(session.loop.id).toBe(echo.id)
    await session.d.log.append([
      session.ev(
        'x/core/loop-checkpoint',
        {
          loop: { id: echo.id, version: echo.version },
          checkpoint: { codecVersion: 2, state: 'ready' },
        },
        { ignorable: true },
      ),
    ])
    await session.close()
    await expect(k.session('codec', options)).rejects.toThrow('codec version 2 is unsupported; expected 1')
    expect(() => codec.decode({ codecVersion: 2, state: 'ready' })).toThrow('expected 1')
    await k.close()
  })
})

it('overlaps independent safe tools in a custom batch and preserves requested result order', async () => {
  const loops = defaultLoops()
  let release!: () => void
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve
  })
  let started = 0
  const batchLoop: LoopFactory = {
    ...echo,
    id: 'test.parallel',
    create(ctx) {
      return {
        cancel() {},
        dispose() {},
        checkpoint: () => codec.encode('ready'),
        async step(signal) {
          if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
          const results = await ctx.tools.batch(
            [
              { name: 'left', args: {} },
              { name: 'right', args: {} },
            ],
            signal,
          )
          await ctx.events.emit('results', { results: results.map((result) => result.content) })
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
        },
      }
    },
  }
  loops.register('@test/parallel', batchLoop)
  const k = kernel(new MemoryStorage(), loops)
  for (const name of ['left', 'right']) {
    const tool = readTool(async () => {
      if (++started === 2) release()
      await bothStarted
      return { content: [{ type: 'text', text: name }] }
    }) as unknown as import('@agnes/extension-api').ToolDef
    k.tools.add({ ...tool, name }, { source: 'test', trust: 'builtin' })
  }

  try {
    const session = await k.session('parallel', { ...options, loop: batchLoop })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'parallel' }], actor })
    expect(await session.run({ until: 'turn-end', signal: new AbortController().signal })).toMatchObject({
      reason: 'completed',
    })
    expect((await session.scan({ type: 'x/test/parallel/results', limit: 1 }))[0]?.data).toEqual({
      results: [[{ type: 'text', text: 'left' }], [{ type: 'text', text: 'right' }]],
    })
  } finally {
    release()
    await k.close()
  }
})

it('drains a cancelled step and driver final writes before closing the log, once', async () => {
  const loops = defaultLoops()
  let started!: () => void
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposed = 0
  const closingLoop: LoopFactory = {
    ...echo,
    id: 'test.close',
    create(ctx) {
      return {
        checkpoint: () => codec.encode('ready'),
        cancel() {},
        async dispose() {
          disposed++
          await ctx.checkpoints.write(codec.encode('done'))
        },
        async step(signal) {
          await ctx.input.accept()
          started()
          await ctx.wait.park(signal)
          await ctx.events.emit('drained', {})
          await ctx.events.finish('aborted')
          return { outcome: 'turn-ended', phase: 'custom-final', reason: 'aborted' }
        },
      }
    },
  }
  loops.register('@test/close', closingLoop)
  const k = kernel(new MemoryStorage(), loops)
  const session = await k.session('close', { ...options, loop: closingLoop })
  await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
  const running = session.run({ until: 'turn-end', signal: new AbortController().signal })
  await active
  const close = session.close()
  expect(session.close()).toBe(close)
  await expect(session.step()).rejects.toMatchObject({ code: 'E_CLOSED' })
  await close
  expect((await running).reason).toBe('aborted')
  expect(disposed).toBe(1)
  expect(session.d.log.isClosed).toBe(true)
  const rows = await k.o.storage.scan(session.key, { fromSeq: 1, limit: 200 })
  expect(rows.some((row) => row.type === 'x/test/close/drained')).toBe(true)
  expect(rows.at(-1)?.data).toMatchObject({ checkpoint: { state: 'done' } })
  await k.close()
})

it.each(['turn-end', 'idle'] as const)(
  'uses explicit custom outcomes with two inputs until %s',
  async (until) => {
    const loops = defaultLoops()
    const custom: LoopFactory = {
      ...echo,
      id: 'test.outcomes',
      create(ctx) {
        return {
          checkpoint: () => codec.encode('ready'),
          cancel() {},
          dispose() {},
          async step() {
            const input = await ctx.input.accept()
            if (!input) return { outcome: 'idle', phase: 'arbitrary' }
            await ctx.events.emit('input', { id: input.id ?? '' })
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', phase: 'arbitrary', reason: 'completed' }
          },
        }
      },
    }
    loops.register('@test/outcomes', custom)
    const k = kernel(new MemoryStorage(), loops)
    try {
      const session = await k.session('outcomes', { ...options, loop: custom })
      for (const text of ['first', 'second'])
        await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      expect((await session.run({ until, signal: new AbortController().signal })).reason).toBe('completed')
      expect(await session.scan({ type: 'turn/end', limit: 10 })).toHaveLength(until === 'idle' ? 2 : 1)
    } finally {
      await k.close()
    }
  },
)

it.each([
  ['max_steps', 0, null, 'deny'],
  ['completed', 1, null, 'deny'],
  ['budget', null, 0, 'deny'],
  ['budget', null, 0, 'quote'],
] as const)(
  'enforces %s admission for both default and independent loops',
  async (reason, maxSteps, cap, disposition) => {
    const modelOnly: LoopFactory = {
      ...echo,
      id: 'test.one-model',
      create(ctx) {
        return {
          checkpoint: () => codec.encode('ready'),
          cancel() {},
          dispose() {},
          async step(signal) {
            await ctx.input.claim('next-turn')
            await ctx.model.complete(await ctx.prepareRequest({ tools: [] }), signal)
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', reason: 'completed' }
          },
        }
      },
    }
    for (const loop of [DEFAULT_LOOP, reason === 'completed' ? modelOnly : echo]) {
      const loops = defaultLoops()
      loops.register('@test/echo', echo)
      loops.register('@test/model-only', modelOnly)
      const preset = presetDefaults()
      preset.budget = { ...preset.budget, maxSteps, perRequestCap: cap, onExceed: disposition }
      const seams = fakeSeams({
        billing: { projected: async () => ({ credits: 1, creditSource: 'estimated' }) },
        approval: { ask: async () => ({ verdict: 'rejected', reason: 'user-rejected' }) },
      })
      const k = kernel(new MemoryStorage(), loops, { preset, seams })
      k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
      try {
        const session = await k.session('admission', {
          ...options,
          loop,
          workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams),
        })
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          reason,
        )
        const sent = (k.o.provider as ReturnType<typeof fakeProvider>).requests
        if (reason === 'completed') {
          expect(sent).toHaveLength(1)
          expect(await session.scan({ type: 'step/start', limit: 20 })).toHaveLength(1)
        } else {
          expect(sent).toEqual([])
          expect(await session.scan({ type: 'effect/intent', limit: 20 })).toEqual([])
        }
        expect(await session.scan({ type: 'tool/result', limit: 20 })).toEqual([])
      } finally {
        await k.close()
      }
    }
  },
)

it('exposes trusted input claims, frozen tool schemas and post-compaction history without private state', async () => {
  const loops = defaultLoops()
  let captured: LoopContext | undefined
  const viewLoop: LoopFactory = {
    ...echo,
    controls: { steer: true },
    id: 'test.view',
    create(ctx) {
      captured = ctx
      return {
        checkpoint: () => codec.encode('ready'),
        cancel() {},
        dispose() {},
        async step() {
          const first = await ctx.input.claim('next-turn')
          expect(first).toMatchObject({
            origin: 'system',
            system: { source: 'agnes/child-agent', type: 'completed', data: { childId: 'child-1' } },
          })
          expect(await ctx.input.claim('next-turn')).toEqual(first)
          const steer = await ctx.input.claim('next-step')
          expect(steer).toMatchObject({
            turnId: first?.turnId,
            trust: 'untrusted',
            kind: 'steer',
            origin: 'system',
            system: { data: { invocationId: 'invocation-1' } },
          })
          const view = await ctx.turn.view()
          expect(view?.history.at(-1)?.trust).toBe('untrusted')
          expect(view?.tools[0]).toMatchObject({ name: 'read', parameters: { type: 'object' } })
          expect(Object.isFrozen(view?.tools[0]?.parameters)).toBe(true)
          expect(view?.model).toMatchObject({ id: 'm', capabilities: { input: ['text', 'image'] } })
          expect(view?.budget.stepsUsed).toBe(0)
          const request = await ctx.prepareRequest({ tools: [] })
          await expect(
            ctx.model.complete(structuredClone(request), new AbortController().signal),
          ).rejects.toMatchObject({ code: 'E_REQUEST_FROZEN' })
          expect(await ctx.effects.status('never-sent')).toMatchObject({ status: 'not-sent' })
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', phase: 'custom', reason: 'completed' }
        },
      }
    },
  }
  loops.register('@test/view', viewLoop)
  const k = kernel(new MemoryStorage(), loops)
  k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
  try {
    const session = await k.session('view', { ...options, loop: viewLoop })
    await session.enqueue('next-turn', {
      content: [{ type: 'text', text: 'first' }],
      actor,
      origin: 'system',
      system: {
        source: 'agnes/child-agent',
        type: 'completed',
        summary: 'Child completed',
        data: { childId: 'child-1' },
      },
    })
    await session.enqueue('next-step', {
      content: [{ type: 'text', text: 'steer' }],
      actor,
      trust: 'untrusted',
      origin: 'system',
      system: {
        source: 'agnes/deferred-invocations',
        type: 'invocation-queued',
        summary: 'Queued',
        data: { invocationId: 'invocation-1' },
      },
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(await captured?.turn.view()).toBeNull()
  } finally {
    await k.close()
  }
})

it('hands a next-step input claimed after the last checkpoint back once on cold resume', async () => {
  const claims: Array<Awaited<ReturnType<LoopContext['input']['claim']>>> = []
  let crash = true
  const claimLoop: LoopFactory = {
    ...echo,
    controls: { steer: true },
    id: 'test.claim-replay',
    create(ctx) {
      return {
        checkpoint: () => codec.encode('ready'),
        cancel() {},
        dispose() {},
        async step() {
          await ctx.input.claim('next-turn')
          await ctx.checkpoints.write(codec.encode('ready'))
          claims.push(await ctx.input.claim('next-step'))
          if (crash) throw new Error('process died before the checkpoint')
          await ctx.checkpoints.write(codec.encode('done'))
          await ctx.events.finish('completed')
          return { outcome: 'turn-ended', phase: 'custom', reason: 'completed' }
        },
      }
    },
    resume(ctx, saved) {
      codec.decode(saved)
      return this.create(ctx)
    },
  }
  const loops = defaultLoops()
  loops.register('@test/claim-replay', claimLoop)
  const storage = new MemoryStorage()
  const first = kernel(storage, loops)
  const steer = {
    content: [{ type: 'text' as const, text: 'approved' }],
    actor,
    trust: 'untrusted' as const,
    origin: 'system' as const,
    system: {
      source: 'agnes/action-result',
      type: 'result',
      summary: 'Approved',
      data: { actionId: 'a1' },
    },
  }
  try {
    const session = await first.session('claim-replay', { ...options, loop: claimLoop })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'start' }], actor })
    await session.enqueue('next-step', steer)
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'error',
    )
    await session.close()
  } finally {
    await first.close()
  }
  crash = false
  for (const reopen of [0, 1]) {
    const next = kernel(storage, loops)
    try {
      const session = await next.session('claim-replay', options)
      await session.enqueue('next-turn', { content: [{ type: 'text', text: `again ${reopen}` }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      await session.close()
    } finally {
      await next.close()
    }
  }
  const received = claims.filter((claim) => claim !== null)
  expect(received).toMatchObject([
    { kind: 'steer', system: { data: { actionId: 'a1' } } },
    { kind: 'steer', system: { data: { actionId: 'a1' } } },
  ])
  expect(received[1]?.id).toBe(received[0]?.id)
  expect(claims.at(-1)).toBeNull()
})

it.each(['none', 'after-result', 'before-call'] as const)(
  'recovers stable invocation receipts after %s interruption and associates checkpoints',
  async (interruption) => {
    const loops = defaultLoops()
    let executions = 0
    const effectLoop: LoopFactory = {
      ...echo,
      id: 'test.receipts',
      create(ctx) {
        return {
          checkpoint: () => codec.encode('ready'),
          cancel() {},
          dispose() {},
          async step(signal) {
            await ctx.input.claim('next-turn')
            const id = 'stable-read'
            const before = await ctx.effects.status(id)
            const call = { invocationId: id, name: 'read', args: {} }
            const a = await ctx.tools.execute(call, signal)
            expect(await ctx.tools.execute(call, signal)).toEqual(a)
            expect(await ctx.effects.status(id)).toMatchObject({ status: 'responded', result: a })
            if (before.status === 'not-sent') expect(executions).toBe(1)
            await ctx.checkpoints.write(codec.encode('done'), { invocationIds: [id] })
            await ctx.events.finish('completed')
            return { outcome: 'turn-ended', reason: 'completed' }
          },
        }
      },
      resume(ctx, saved) {
        codec.decode(saved)
        return this.create(ctx)
      },
    }
    loops.register('@test/receipts', effectLoop)
    const k = kernel(new MemoryStorage(), loops)
    k.tools.add(
      readTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'receipt' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    try {
      let session = await k.session('receipts', { ...options, loop: effectLoop })
      if (interruption !== 'none') {
        const append = session.d.log.append.bind(session.d.log)
        let interrupted = false
        vi.spyOn(session.d.log, 'append').mockImplementation((events, options) => {
          const atBoundary = events.some((event) =>
            interruption === 'after-result'
              ? event.type === 'x/core/loop-invocation' &&
                (event.data as { status?: string }).status === 'responded'
              : event.type === 'tool/call',
          )
          if (!interrupted && atBoundary) {
            interrupted = true
            return Promise.reject(new Error('synthetic receipt interruption'))
          }
          return append(events, options)
        })
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'interrupt' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'error',
        )
        await session.close()
        session = await k.session('receipts', options)
      }
      if (interruption === 'before-call') {
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'uncertain' }], actor })
        const result = await session.run({ until: 'turn-end', signal: new AbortController().signal })
        expect(result).toMatchObject({
          reason: 'error',
          error: { message: expect.stringContaining('may have been sent') },
        })
        expect(executions).toBe(0)
        return
      }
      for (let i = 0; i < 2; i++) {
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
        expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
          'completed',
        )
        await session.close()
        session = await k.session('receipts', options)
      }
      expect(executions).toBe(1)
      expect(
        (await session.scan({ type: 'x/core/loop-checkpoint', order: 'desc', limit: 1 }))[0]?.data,
      ).toMatchObject({ invocationIds: ['stable-read'] })
    } finally {
      await k.close()
    }
  },
)

it.each(['responded', 'may-have-sent', 'different-request'] as const)(
  'deduplicates model invocations when admission races with %s',
  async (race) => {
    const barrier = () => {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      return { promise, resolve }
    }
    const counting = [barrier(), barrier()] as const
    const admitted = [barrier(), barrier()] as const
    const sending = barrier()
    const respond = barrier()
    const provider = fakeProvider([textTurn('one response')])
    provider.models = () => [model]
    let counts = 0
    provider.count = async (request) => {
      const index = counts++
      counting[index]?.resolve()
      await admitted[index]?.promise
      return { tokens: 10, source: 'provider', boundHash: request.derivedHash }
    }
    const infer = provider.infer.bind(provider)
    provider.infer = async function* (request, options) {
      for await (const event of infer(request, options)) {
        yield event
        if (event.type === 'sent') {
          sending.resolve()
          await respond.promise
        }
      }
    }
    const loops = defaultLoops()
    const loop: LoopFactory = {
      ...echo,
      id: 'test.model-receipts',
      create(ctx) {
        return {
          ...echoDriver(ctx),
          async step(signal) {
            await ctx.input.accept()
            const invocationId = 'stable-model'
            const request = await ctx.prepareRequest({ invocationId, tools: [], messages: [] })
            const changed = await ctx.prepareRequest({
              invocationId,
              tools: [],
              messages: [],
              system: 'different request',
            })
            const first = ctx.model.complete(request, signal)
            await counting[0].promise
            const second = ctx.model.complete(race === 'different-request' ? changed : request, signal)
            // Both streams passed not-sent and are held at the public provider count boundary.
            await counting[1].promise
            admitted[0].resolve()
            await sending.promise
            if (race === 'may-have-sent') {
              expect(await ctx.effects.status(invocationId)).toMatchObject({ status: 'may-have-sent' })
              const refused = expect(second).rejects.toMatchObject({
                code: 'E_RELATION',
                message: expect.stringContaining('reconcile'),
              })
              admitted[1].resolve()
              await refused
            }
            respond.resolve()
            const result = await first
            expect(result).toEqual(
              textTurn('one response').map((event) =>
                event.type === 'sent' ? sentFor(request, event) : event,
              ),
            )
            if (race !== 'may-have-sent') {
              const replay =
                race === 'responded'
                  ? expect(second).resolves.toEqual(result)
                  : expect(second).rejects.toMatchObject({
                      code: 'E_RELATION',
                      message: expect.stringContaining('different operation'),
                    })
              admitted[1].resolve()
              await replay
            }
            expect(await ctx.model.complete(request, signal)).toEqual(result)
            await expect(ctx.model.complete(changed, signal)).rejects.toMatchObject({ code: 'E_RELATION' })
            expect(await ctx.effects.status(invocationId)).toMatchObject({ status: 'responded', result })
            return ctx.events.finish('completed')
          },
        }
      },
    }
    loops.register('@test/model-receipts', loop)
    const preset = presetDefaults()
    // Isolate invocation dispatch from the session-scoped tree reservation mechanism.
    preset.treeBudgetCredits = null
    preset.budget.preflight = 'count'
    const k = kernel(new MemoryStorage(), loops, { provider, preset })
    try {
      const session = await k.session('model-receipts', { ...options, loop })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ reason: 'completed' })
      expect(provider.requests).toHaveLength(1)
      const rows = await session.scan({ fromSeq: 1, limit: 200 })
      expect(rows.filter((row) => row.type === 'x/core/loop-invocation').map((row) => row.data)).toEqual([
        expect.objectContaining({ invocationId: 'stable-model', status: 'may-have-sent' }),
        expect.objectContaining({ invocationId: 'stable-model', status: 'responded' }),
      ])
      expect(rows.filter((row) => row.type === 'x/core/loop-effect')).toHaveLength(1)
      expect(rows.filter((row) => row.type === 'effect/intent')).toHaveLength(1)
      expect(rows.filter((row) => row.type === 'effect/settled')).toHaveLength(1)
    } finally {
      for (const gate of admitted) gate.resolve()
      respond.resolve()
      await k.close()
    }
  },
)

it.each(['deny', 'quote'] as const)(
  'admits the prepared custom request against its actual content with %s disposition',
  async (onExceed) => {
    const loops = defaultLoops()
    const large: LoopFactory = {
      ...echo,
      id: 'test.large-wire',
      create(ctx) {
        return {
          checkpoint: () => codec.encode('ready'),
          cancel() {},
          dispose() {},
          async step(signal) {
            await ctx.input.claim('next-turn')
            const request = await ctx.prepareRequest({ tools: [], system: 'a'.repeat(4000) })
            await ctx.model.complete(request, signal)
            throw new Error('oversized request was sent')
          },
        }
      },
    }
    loops.register('@test/large-wire', large)
    const preset = presetDefaults()
    preset.budget = { ...preset.budget, perRequestCap: 100, onExceed }
    const seams = fakeSeams({
      billing: {
        projected: async ({ tokensEstimate }) => ({ credits: tokensEstimate, creditSource: 'estimated' }),
      },
      approval: { ask: async () => 'rejected' },
    })
    const k = kernel(new MemoryStorage(), loops, { preset, seams })
    try {
      const session = await k.session('large-wire', {
        ...options,
        loop: large,
        workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams),
      })
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'tiny' }], actor })
      const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
      expect(outcome.reason, JSON.stringify(outcome)).toBe('budget')
      expect((k.o.provider as ReturnType<typeof fakeProvider>).requests).toEqual([])
      expect(await session.scan({ type: 'effect/intent', limit: 20 })).toEqual([])
      expect(
        (await session.decisions.list()).filter((value) => value.request.spec.purpose === 'budget'),
      ).toHaveLength(onExceed === 'quote' ? 1 : 0)
    } finally {
      await k.close()
    }
  },
)

it('keeps custom Loop events untrusted and inside the namespace of the loop’s own package', async () => {
  const f = await openSession({ provider: fakeProvider([]) })
  const ctx = await createLoopContext(f.session)
  const owner = f.session.loop.id
  try {
    // A name is relative: nothing a loop passes can spell a platform type or another owner's.
    for (const name of [
      'x/core/loop-invocation',
      'tool/result',
      'turn/end',
      `x/${owner}/progress`,
      'x/other-plugin/progress',
      '../other-plugin/progress',
      'progress ready',
      'Progress',
      '',
    ])
      await expect(ctx.events.emit(name, {})).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    for (const name of ['progress', 'report.ready']) {
      await ctx.events.emit(name, { progress: 1 })
      const rows = await f.log.scan({ type: `x/${owner}/${name}`, limit: 10 })
      expect(rows).toEqual([
        expect.objectContaining({ origin: `ext:${owner}`, trust: 'untrusted', ignorable: true }),
      ])
      expect(
        validateMethod('_agnes/v1/session.event', 'params', { sessionId: f.session.key, event: rows[0] }).ok,
      ).toBe(true)
    }
  } finally {
    disposeLoopContext(ctx)
    await f.session.close()
  }
})
it('does not recover invocation receipts from an extension source', async () => {
  const f = await openSession({ provider: fakeProvider([]) })
  const ctx = await createLoopContext(f.session)
  try {
    await f.log.append([
      f.session.ev(
        'x/core/loop-invocation',
        {
          invocationId: 'foreign',
          fingerprint: 'foreign',
          status: 'responded',
          checkpoint: null,
          loop: f.session.loop,
          result: { content: [] },
        },
        { ignorable: true, origin: 'ext:example', trust: 'untrusted' },
      ),
    ])
    expect(await ctx.effects.status('foreign')).toEqual({ invocationId: 'foreign', status: 'not-sent' })
  } finally {
    disposeLoopContext(ctx)
    await f.session.close()
  }
})

it('refuses a trusted invocation receipt bound to another loop', async () => {
  const f = await openSession({ provider: fakeProvider([]) })
  const ctx = await createLoopContext(f.session)
  try {
    await f.log.append([
      f.session.ev(
        'x/core/loop-invocation',
        {
          invocationId: 'wrong-loop',
          fingerprint: 'fixture',
          status: 'responded',
          checkpoint: null,
          loop: { id: 'other', version: '1.0.0' },
          result: { content: [] },
        },
        { ignorable: true },
      ),
    ])
    await expect(ctx.effects.status('wrong-loop')).rejects.toMatchObject({ code: 'E_RELATION' })
  } finally {
    disposeLoopContext(ctx)
    await f.session.close()
  }
})

it('recovers exact author tool content and metadata if the subsequent receipt append fails', async () => {
  const f = await openSession({ provider: fakeProvider([]) })
  const result = {
    content: [
      { type: 'text' as const, text: 'ok' },
      {
        type: 'ref' as const,
        ref: { sha256: 'a'.repeat(64), size: 3, mime: 'text/plain' },
        mime: 'text/plain',
      },
    ],
    isError: false,
    structured: { approved: true },
    details: { source: 'fixture' },
    terminate: false,
  }
  let executions = 0
  f.session.d.registry.add(
    readTool(async () => {
      executions++
      return result
    }),
    { source: 'test', trust: 'builtin' },
  )
  const ctx = await createLoopContext(f.session)
  try {
    await f.session.enqueue('next-turn', { content: [{ type: 'text', text: 'go' }], actor })
    await ctx.input.accept()
    const append = f.log.append.bind(f.log)
    const fault = vi.spyOn(f.log, 'append').mockImplementation(async (events, ...args) => {
      if (
        events.some(
          (e) =>
            e.type === 'x/core/loop-invocation' && (e.data as { status?: string }).status === 'responded',
        )
      )
        throw new Error('receipt fault')
      return append(events, ...args)
    })
    try {
      await expect(
        ctx.tools.execute({ name: 'read', args: {}, invocationId: 'response' }, new AbortController().signal),
      ).rejects.toThrow('receipt fault')
      expect(await ctx.effects.status('response')).toMatchObject({ status: 'responded', result })
      fault.mockRestore()
      expect(
        await ctx.tools.execute(
          { name: 'read', args: {}, invocationId: 'response' },
          new AbortController().signal,
        ),
      ).toEqual(result)
      expect(executions).toBe(1)
    } finally {
      fault.mockRestore()
    }
  } finally {
    disposeLoopContext(ctx)
    await f.session.close()
  }
})

it.each([true, false])('bounds DAG plan repair and returns Core errors (repaired: %s)', async (repaired) => {
  const loops = defaultLoops()
  const dag = createDagLoop()
  loops.register('@test/dag', dag)
  const provider = fakeProvider([
    textTurn('prefix instead of a plan'),
    textTurn(repaired ? '[{"id":"read","tool":"read","args":{},"after":[]}]' : 'still invalid'),
    ...(repaired ? [] : [textTurn('[{"id":"read","tool":"read","args":{},"after":[]}]')]),
    textTurn('finished'),
  ])
  provider.models = () => [model]
  const k = kernel(new MemoryStorage(), loops, { provider })
  k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
  try {
    const session = await k.session('dag-repair', { ...options, loop: dag })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'read' }], actor })
    const outcome = await session.run({ until: 'turn-end', signal: new AbortController().signal })
    expect(outcome).toMatchObject(
      repaired ? { reason: 'completed' } : { reason: 'error', error: { code: 'E_STEP_FAILED' } },
    )
    const rows = await session.scan({ fromSeq: 1, limit: 200 })
    expect(rows.filter((row) => row.type === 'tool/result')).toHaveLength(repaired ? 1 : 0)
    const attempts = rows.filter((row) => row.type === 'x/test/dag/planner')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.data).toMatchObject({ reply: 'prefix instead of a plan', attempt: 1 })
    if (repaired) expect(rows.find((row) => row.type === 'tool/call')!.seq).toBeGreaterThan(attempts[1]!.seq)
    expect(provider.requests).toHaveLength(repaired ? 3 : 2)
    expect(provider.requests[1]?.system).toContain('DAG model plan must begin with a JSON array')
    if (!repaired) {
      await session.enqueue('next-turn', { content: [{ type: 'text', text: 'try a new task' }], actor })
      expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
        'completed',
      )
      expect(await session.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
    }
  } finally {
    await k.close()
  }
})

describe('platform policy edges on the generic ports', () => {
  const state = loopCheckpointCodec(1, (value) => {
    if (typeof value !== 'number') throw new Error('invalid round checkpoint')
    return value
  })
  /** One model round per step, then asks Core to complete. Uses no default-loop convenience edge. */
  function roundLoop(id: string, rounds: { model: boolean }): LoopFactory {
    const driver = (ctx: LoopContext, saved = 0): LoopDriver => {
      let round = saved
      return {
        cancel() {},
        dispose() {},
        checkpoint: () => state.encode(round),
        async step(signal) {
          if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
          if (rounds.model) {
            const request = await ctx.prepareRequest({ tools: [] })
            const response = await ctx.model.complete(request, signal)
            const text = response.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : []))
            round++
            await ctx.events.assistant(
              { content: [{ type: 'text', text: text.join('') }], stopReason: 'end_turn' },
              state.encode(round),
            )
          } else await ctx.tools.execute({ name: 'read', args: {}, invocationId: `${id}:read` }, signal)
          return ctx.events.finish('completed')
        },
      }
    }
    return {
      id,
      version: '1.0.0',
      capabilities: ['model', 'tools'],
      codec: state,
      create: (ctx) => driver(ctx),
      resume: (ctx, checkpoint) => driver(ctx, state.decode(checkpoint)),
    }
  }
  async function open(loop: LoopFactory, extra: Partial<import('../src/kernel.js').KernelOptions> = {}) {
    const loops = defaultLoops()
    loops.register('@test/policy-edges', loop)
    const provider = fakeProvider([textTurn('first answer'), textTurn('second answer')])
    provider.models = () => [model]
    const k = kernel(new MemoryStorage(), loops, { provider, ...extra })
    k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await k.session(loop.id, { ...options, loop })
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
    const run = () => session.run({ until: 'turn-end', signal: new AbortController().signal })
    return { k, session, provider, run }
  }

  it('passes a completion through the stop gate, and continues when a turn_stopping hook says so', async () => {
    const { k, session, provider, run } = await open(roundLoop('test.gated', { model: true }))
    const asked: number[] = []
    session.hooks = {
      ...noopHooks,
      turnStopping: async ({ step }) => {
        asked.push(step)
        return asked.length === 1 ? { action: 'continue', note: 'cite the source first' } : { action: 'stop' }
      },
    }
    try {
      expect((await run()).reason).toBe('completed')
      expect(asked).toHaveLength(2)
      expect(provider.requests).toHaveLength(2)
      expect(JSON.stringify(provider.requests[1]?.messages)).toContain('cite the source first')
      const rows = await session.scan({ fromSeq: 1, limit: 200 })
      expect(rows.filter((row) => row.type === 'turn/end').map((row) => row.data)).toEqual([
        expect.objectContaining({ reason: 'completed' }),
      ])
      // The verifier seam ran at the completion that ended the turn.
      expect(rows.filter((row) => row.type === 'verifier/signal')).toHaveLength(1)
    } finally {
      await k.close()
    }
  })

  it('runs the verifier and repair seams before a generic loop may complete', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ verdict: 'fail', reasons: ['no evidence'] })
      .mockResolvedValue({ verdict: 'pass', reasons: [] })
    const { k, session, provider, run } = await open(roundLoop('test.verified', { model: true }), {
      seams: fakeSeams({ verifier: { verify }, repair: { decide: async () => 'repair' } }),
    })
    try {
      expect((await run()).reason).toBe('completed')
      expect(verify).toHaveBeenCalledTimes(2)
      expect(provider.requests).toHaveLength(2)
      expect((await session.scan({ type: 'repair/decision', limit: 10 })).map((row) => row.data)).toEqual([
        expect.objectContaining({ round: 1, decision: 'repair' }),
      ])
    } finally {
      await k.close()
    }
  })

  /** Real loops built on the author ports, each with the side effects its one turn must not repeat. */
  type Session = Awaited<ReturnType<Kernel['session']>>
  type ParkingLoop = {
    loop: LoopFactory
    scripts: Parameters<typeof fakeProvider>[0]
    effects?: () => number
    before?: (session: Session) => Promise<void>
  }
  const parkingLoops: Record<string, () => ParkingLoop> = {
    'a generic loop': () => ({ loop: roundLoop('test.parks', { model: false }), scripts: [] }),
    'the workflow helper': () => {
      const stage = vi.fn(async () => ({ drafted: true }))
      const loop = defineWorkflowLoop({
        id: 'test.workflow',
        version: '1.0.0',
        name: 'workflow',
        stages: [{ name: 'draft', run: stage }],
      }).factory
      return { loop, scripts: [], effects: () => stage.mock.calls.length }
    },
    'the DAG example': () => ({
      loop: createDagLoop() as LoopFactory,
      scripts: [textTurn('[{"id":"read","tool":"read","args":{},"after":[]}]'), textTurn('finished')],
    }),
    'the ReAct example': () => ({ loop: createReactLoop() as LoopFactory, scripts: [textTurn('answer')] }),
    'the decision example, which opens no step': () => ({
      loop: createDecisionLoop() as LoopFactory,
      scripts: [],
      // This loop first asks its own business question; the stop gate comes after that answer.
      before: (session) => answer(session, 'business.confirm', 'continue'),
    }),
  }
  async function answer(session: Session, purpose: string, option: string) {
    const asked = (await session.decisions.list()).find(
      (value) => value.request.spec.purpose === purpose && !value.result,
    )
    if (!asked) throw new Error(`no ${purpose} decision is waiting`)
    await session.decideApproval({
      command: {
        handle: asked.handle,
        revision: asked.revision,
        commandId: `answer:${asked.handle.id}`,
        response: { option, value: null },
      },
      context: { actor: { ...actor, id: 'reviewer' }, category: 'human', authorize() {} },
    })
  }

  it.each(Object.keys(parkingLoops))(
    'keeps %s verifier failures out of approvals and does not resume business work on reopen',
    async (name) => {
      const { loop, scripts, before } = parkingLoops[name]!()
      const verify = vi.fn(async (scope: string) =>
        scope === 'turn'
          ? { verdict: 'fail' as const, reasons: ['schema_invalid'] }
          : { verdict: 'pass' as const, reasons: [] },
      )
      const seams = fakeSeams({ verifier: { verify }, repair: { decide: async () => 'park' } })
      const loops = defaultLoops()
      loops.register('@test/parks', loop)
      const provider = fakeProvider(scripts)
      provider.models = () => [model]
      const storage = new MemoryStorage()
      const start = async () => {
        const k = kernel(storage, loops, { provider, seams })
        k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
        const workspaceInvocation = testWorkspaceInvocation(testFsOps(), seams)
        return { k, session: await k.session('parks', { ...options, workspaceInvocation, loop }) }
      }
      let { k, session } = await start()
      const run = () => session.run({ until: 'turn-end', signal: new AbortController().signal })
      try {
        await session.enqueue('next-turn', { content: [{ type: 'text', text: 'run' }], actor })
        if (before) {
          expect((await run()).reason).toBe('parked')
          await before(session)
        }
        expect((await run()).reason).toBe('blocked')
        expect((await session.decisions.list()).filter((d) => d.request.spec.purpose === 'gate')).toEqual([])
        const seq = session.lastSeq,
          calls = provider.calls
        await k.close()
        ;({ k, session } = await start())
        await run()
        expect(session.lastSeq).toBe(seq)
        expect(provider.calls).toBe(calls)
        expect(
          (await session.projectUI()).nodes.some((n) => n.kind === 'approval' && n.state === 'pending'),
        ).toBe(false)
      } finally {
        await k.close()
      }
    },
  )

  it('ends the turn as blocked when the gate keeps it open and the loop takes no further step', async () => {
    const { k, session, run } = await open(roundLoop('test.held', { model: false }))
    session.hooks = {
      ...noopHooks,
      turnStopping: async () => ({ action: 'continue', note: 'not done' }),
    }
    try {
      expect(await run()).toMatchObject({ reason: 'blocked', error: { code: 'STOP_GATE_HELD' } })
      expect(await session.scan({ type: 'tool/result', limit: 10 })).toHaveLength(1)
    } finally {
      await k.close()
    }
  })

  it.each([
    ['block', { block: true, reason: 'quota' }, { reason: 'blocked', error: { code: 'HOOK_BLOCKED' } }],
    ['park', { park: true }, { reason: 'parked' }],
  ] as const)(
    'fires before_step where a generic loop opens a step, and honours %s',
    async (_n, verdict, end) => {
      const { k, session, provider, run } = await open(roundLoop('test.stepped', { model: true }))
      const steps: number[] = []
      session.hooks = {
        ...noopHooks,
        beforeStep: async ({ step }) => {
          steps.push(step)
          return verdict
        },
      }
      try {
        expect(await run()).toMatchObject(end)
        expect(steps).toEqual([1])
        expect(provider.requests).toHaveLength(0)
        expect(await session.scan({ type: 'step/start', limit: 10 })).toHaveLength(0)
      } finally {
        await k.close()
      }
    },
  )

  it('fires before_step once for each step a generic loop opens', async () => {
    const { k, session, run } = await open(roundLoop('test.steps', { model: true }))
    const steps: number[] = []
    let stops = 0
    session.hooks = {
      ...noopHooks,
      beforeStep: async ({ step }) => {
        steps.push(step)
        return {}
      },
      turnStopping: async () => (stops++ ? { action: 'stop' } : { action: 'continue', note: 'again' }),
    }
    try {
      expect((await run()).reason).toBe('completed')
      expect(steps).toEqual([1, 2])
    } finally {
      await k.close()
    }
  })

  it('keeps running a driver that reports completion while the stop gate holds the turn open', async () => {
    const loop = roundLoop('test.ignores', { model: false })
    const create = loop.create
    const ignoring: LoopFactory = {
      ...loop,
      create(ctx) {
        const driver = create(ctx) as LoopDriver
        return {
          ...driver,
          async step(signal) {
            await driver.step(signal)
            return { outcome: 'turn-ended', phase: 'done', reason: 'completed' }
          },
        }
      },
    }
    const { k, session, run } = await open(ignoring)
    session.hooks = { ...noopHooks, turnStopping: async () => ({ action: 'continue', note: 'not done' }) }
    try {
      await run()
      // The run did not return on the first, held completion: the turn is closed, and as blocked.
      expect(session.op()).toBeNull()
      expect((await session.scan({ type: 'turn/end', limit: 10 })).map((row) => row.data)).toEqual([
        expect.objectContaining({
          reason: 'blocked',
          error: expect.objectContaining({ code: 'STOP_GATE_HELD' }),
        }),
      ])
    } finally {
      await k.close()
    }
  })
})
