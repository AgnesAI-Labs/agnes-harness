import { defaultIds } from '@agnes/core-common/ids'
import { registerLoopPlugin } from '@agnes/core-common/loop/registry'
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
  type ToolRuntime,
} from '@agnes/extension-api'
import { describe, expect, it, vi } from 'vitest'
import { createDagLoop } from '../../../examples/loops/dag-loop/index.mjs'
import { Kernel } from '../src/kernel.js'
import { LoopEventRegistry } from '../src/loop/events.js'
import { createLoopContext, disposeLoopContext } from '../src/loop/ports.js'
import { applyBeforeRequestPatches } from '../src/request/transforms.js'
import { noopHooks } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
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
      await ctx.events.emit('x/echo/result', {
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
  it('uses an independent runtime and the same request/tool event waterfall from custom-loop ports', async () => {
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
    k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
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
      expect((k.o.provider as ReturnType<typeof fakeProvider>).requests[0]?.sampling?.maxTokens).toBe(14)
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
  it('registers through a plugin lifecycle and exposes an immutable catalog', () => {
    const loops = defaultLoops()
    const cleanups: Array<() => void> = []
    registerLoopPlugin({ loops, effect: (callback) => cleanups.push(callback()) }, '@test/echo', echo)
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
    empty.loops.register('@test/echo', echo)
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
    const session = await k.session('codec', { ...options, preset: { ...presetDefaults(), loop: echo } })
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
          await ctx.events.emit('x/parallel/results', { results: results.map((result) => result.content) })
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
    expect((await session.scan({ type: 'x/parallel/results', limit: 1 }))[0]?.data).toEqual({
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
          await ctx.events.emit('x/close/drained', {})
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
  expect(rows.some((row) => row.type === 'x/close/drained')).toBe(true)
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
            await ctx.events.emit('x/outcome/input', { id: input.id ?? '' })
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
        ledger: { projected: async () => ({ credits: 1, creditSource: 'estimated' }) },
        approval: { ask: async () => ({ verdict: 'rejected', reason: 'user_rejected' }) },
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
    id: 'test.view',
    create(ctx) {
      captured = ctx
      return {
        checkpoint: () => codec.encode('ready'),
        cancel() {},
        dispose() {},
        async step() {
          const first = await ctx.input.claim('next-turn')
          expect(await ctx.input.claim('next-turn')).toEqual(first)
          const steer = await ctx.input.claim('next-step')
          expect(steer).toMatchObject({ turnId: first?.turnId, trust: 'untrusted', kind: 'steer' })
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
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'first' }], actor })
    await session.enqueue('next-step', {
      content: [{ type: 'text', text: 'steer' }],
      actor,
      trust: 'untrusted',
    })
    expect((await session.run({ until: 'turn-end', signal: new AbortController().signal })).reason).toBe(
      'completed',
    )
    expect(await captured?.turn.view()).toBeNull()
  } finally {
    await k.close()
  }
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
      ledger: {
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
      expect(await session.scan({ type: 'approval/asked', limit: 20 })).toHaveLength(
        onExceed === 'quote' ? 1 : 0,
      )
    } finally {
      await k.close()
    }
  },
)

it('keeps custom Loop events untrusted and refuses reserved event types', async () => {
  const f = await openSession({ provider: fakeProvider([]) })
  const ctx = await createLoopContext(f.session)
  try {
    for (const type of [
      'x/core/loop-invocation',
      'x/core/loop-checkpoint',
      'tool/result',
      'approval/decided',
      'assistant/message',
      'turn/end',
    ])
      await expect(ctx.events.emit(type, {})).rejects.toMatchObject({ code: 'E_ENVELOPE' })
    await ctx.events.emit('x/example/progress', { progress: 1 })
    expect(await f.log.scan({ type: 'x/example/progress', limit: 10 })).toEqual([
      expect.objectContaining({ origin: `ext:${f.session.loop.id}`, trust: 'untrusted', ignorable: true }),
    ])
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
    const attempts = rows.filter((row) => row.type === 'x/dag/planner')
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
