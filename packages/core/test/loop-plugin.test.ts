import {
  type LoopContext,
  type LoopDriver,
  type LoopFactory,
  loopCheckpointCodec,
} from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { describe, expect, it } from 'vitest'
import { ToolRuntimeRegistry } from '../src/effects/tool-providers.js'
import { defaultIds } from '../src/ids.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { DEFAULT_LOOP } from '../src/loop/default-driver.js'
import { LoopEventRegistry } from '../src/loop/events.js'
import { LoopRegistry, registerLoopPlugin } from '../src/loop/registry.js'
import { openTracked } from '../src/reduce/tracker.js'
import { presetDefaults } from '../src/step/preset.js'
import { noopHooks } from '../src/step/session.js'
import { fakeProvider, textTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import { actor, noTimers, readTool, testFsOps, testWorkspaceInvocation } from './helpers/open-session.js'

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
      const request: RequestBody = {
        kind: 'inference',
        sessionKey: ctx.sessionKey,
        slot: 'primary',
        route: 'default',
        model: 'm',
        contractId: null,
        derivedHash: 'a'.repeat(64),
        system: '',
        tools: [],
        messages: [{ role: 'user', content: [...input.content] }],
      }
      const response = await ctx.model.complete(request, signal)
      const text = response.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : [])).join('')
      await ctx.events.emit('assistant/message', {
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
      })
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
  create: echoDriver,
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
  loops = new LoopRegistry(),
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
    ...extra,
  })
}

describe('loop plugins', () => {
  it('uses an independent runtime and the same request/tool event waterfall from custom-loop ports', async () => {
    const loops = new LoopRegistry()
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
    session.hooks = { ...noopHooks, requestPatch: async () => ({ patch: { maxTokens: 12 } }) }
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
  it('registers through a plugin lifecycle and exposes an immutable catalog', () => {
    const loops = new LoopRegistry()
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
    const loops = new LoopRegistry()
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
      content,
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
    const loops = new LoopRegistry()
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
      const loops = new LoopRegistry()
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
    const loops = new LoopRegistry()
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
  const loops = new LoopRegistry()
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
  const loops = new LoopRegistry()
  let started!: () => void
  const active = new Promise<void>((resolve) => { started = resolve })
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

it.each(['turn-end', 'idle'] as const)('uses explicit custom outcomes with two inputs until %s', async (until) => {
  const loops = new LoopRegistry()
  const custom: LoopFactory = {
    ...echo, id: 'test.outcomes',
    create(ctx) {
      return {
        checkpoint: () => codec.encode('ready'), cancel() {}, dispose() {},
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
  } finally { await k.close() }
})
