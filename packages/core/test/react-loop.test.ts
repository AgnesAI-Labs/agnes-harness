import type { ChildAgentService, LoopContext, LoopFactory } from '@agnes/extension-api'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactLoop, type ReactConfig } from '../../../examples/loops/react-loop/index.mjs'
import { bindChildAgentSession, inProcessChildAgentProvider } from '../src/index.js'
import { Kernel } from '../src/kernel.js'
import { MemoryStorage } from '../src/log/memory-storage.js'
import { CompactionRunner } from '../src/step/compaction.js'
import { presetDefaults } from '../src/step/preset.js'
import { defaultLoops } from '../testkit/loops.js'
import { fakeProvider, type Script, sent, sentFor, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  readTool,
  shellTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const kernels: Kernel[] = []
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.close()
})
const signal = () => new AbortController().signal
const options = {
  actor,
  cwd: '/w',
  resolvedProfileHash: null,
  writerRunId: 'react',
  workspaceInvocation: testWorkspaceInvocation(),
}

function setup(
  scripts: Script[],
  config: ReactConfig = {},
  extra: Partial<import('../src/kernel.js').KernelOptions> = {},
) {
  const provider = fakeProvider(scripts)
  provider.models = () => [
    {
      id: 'm',
      route: 'default',
      name: 'scripted',
      api: 'openai-completions',
      baseUrl: 'https://test.invalid',
      input: ['text'],
      reasoning: false,
      contextWindow: 100000,
      maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      toolCallFormats: ['native'],
      thinkingReplay: 'native',
      contract_id: null,
    },
  ]
  const contexts: LoopContext[] = []
  const factory = createReactLoop(config)
  const forbidden = () => {
    throw new Error('ReAct called a coarse scheduling edge')
  }
  const context = (ctx: LoopContext): LoopContext => {
    const wrapped = {
      ...ctx,
      turn: {
        ...ctx.turn,
        checkpoint: forbidden,
        continuation: forbidden,
        finishCancelled: forbidden,
        finishFailure: forbidden,
      },
      model: { ...ctx.model, respond: forbidden },
      tools: { ...ctx.tools, drain: forbidden },
      wait: { ...ctx.wait, poll: forbidden },
    }
    contexts.push(wrapped)
    return wrapped
  }
  const loop: LoopFactory = {
    ...factory,
    create: (ctx) => factory.create(context(ctx)),
    resume: (ctx, saved) => factory.resume(context(ctx), saved),
  }
  const loops = defaultLoops()
  loops.register('@agnes-example/react-loop', loop)
  const k = Kernel.create({
    storage: new MemoryStorage(),
    loops,
    provider,
    preset: presetDefaults(),
    seams: fakeSeams(),
    contract: { contract_id: null, parser_version: '1' },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    ...extra,
  })
  kernels.push(k)
  return { k, loop, provider, contexts }
}
async function enqueue(session: Awaited<ReturnType<Kernel['session']>>, text = 'go') {
  await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
}
const run = (session: Awaited<ReturnType<Kernel['session']>>) =>
  session.run({ until: 'turn-end', signal: signal() })

it.each([1, 2])(
  'runs a %i-tool model loop, overlapping safe siblings and preserving result history',
  async (count) => {
    const tools = [
      sent(),
      ...Array.from({ length: count }, (_, ordinal) => ({
        type: 'toolcall_end' as const,
        via: 'native' as const,
        call: { toolUseId: '', ordinal, name: 'read', args: {} },
      })),
      { type: 'done' as const, reason: 'toolUse' as const },
    ]
    const f = setup([tools, textTurn('finished')])
    let started = 0
    let release!: () => void
    const overlap = new Promise<void>((resolve) => {
      release = resolve
    })
    f.k.tools.add(
      readTool(async () => {
        const index = ++started
        if (started === count) release()
        await overlap
        return { content: [{ type: 'text', text: 'result-' + index }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const session = await f.k.session('tools', { ...options, loop: f.loop })
    await enqueue(session)
    try {
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(started).toBe(count)
      expect(JSON.stringify(f.provider.requests[1]?.messages)).toContain('result-1')
      expect(
        f.provider.requests[1]?.messages.filter((message) => message.role === 'tool_result'),
      ).toHaveLength(count)
      const calls = await session.scan({ type: 'tool/call', limit: 10 })
      expect(calls).toHaveLength(count)
      expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(2)
      expect((await session.scan({ type: 'x/react/budget', limit: 1 }))[0]?.data).toMatchObject({
        tools: ['read'],
        model: 'm',
        stepsUsed: 0,
      })
      for (let i = 0; i < count; i++)
        expect(await f.contexts[0]?.effects.status(`react:1:tool:0:${i}`)).toMatchObject({
          status: 'responded',
        })
    } finally {
      release()
    }
  },
)

it.each([
  ['allowed-once', 1],
  ['rejected', 1],
  ['allowed-once', 2],
  ['rejected', 2],
] as const)(
  'cold-resumes %s approval for %i calls without replacing their identities',
  async (verdict, count) => {
    const receipts = new Map<string, { requestId: string; bindingHash: string; expiresAt: string }>()
    let asks = 0,
      executions = 0
    const seams = fakeSeams({
      approval: {
        ask: async (request) => {
          const ticket = 'ticket-' + ++asks,
            expiresAt = new Date(Date.now() + 60000).toISOString()
          receipts.set(ticket, { requestId: request.requestId, bindingHash: request.bindingHash, expiresAt })
          return { ticket, expiresAt }
        },
        resume: async (ticket) => receipts.get(ticket) ?? null,
      },
    })
    const planned = toolTurn('shell', {})
    if (count === 2)
      planned.splice(2, 0, {
        type: 'toolcall_end',
        call: { toolUseId: '', name: 'shell', args: {}, ordinal: 1 },
        via: 'native',
      })
    const f = setup([planned, textTurn('after approval')], {}, { seams })
    let parkedRows: Awaited<ReturnType<MemoryStorage['scan']>> | undefined
    const commit = f.k.o.storage.commit.bind(f.k.o.storage)
    vi.spyOn(f.k.o.storage, 'commit').mockImplementation(async (key, tx) => {
      const result = await commit(key, tx)
      if (
        tx.events.some(
          (row) => row.type === 'turn/end' && (row.data as { reason: string }).reason === 'parked',
        )
      )
        parkedRows = await f.k.o.storage.scan(key, { fromSeq: 1, limit: 10000 })
      return result
    })
    f.k.tools.add(
      shellTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'approved result' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const approvalOptions = { ...options, workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams) }
    let session = await f.k.session('approval', { ...approvalOptions, loop: f.loop })
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'parked' })
    expect(await run(session)).toMatchObject({ reason: 'parked' })
    expect(executions).toBe(0)
    // New Kernel and writer: neither the driver nor its public effect cache survives in memory.
    await session.close()
    expect(parkedRows).toBeTruthy()
    // Cut immediately at Core's park transaction, before the driver sees PARKED or saves again.
    const reopened = setup(
      [textTurn('after approval')],
      {},
      { seams, storage: MemoryStorage.fromEvents('approval', parkedRows!) },
    )
    reopened.k.tools.add(
      shellTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'approved result' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    session = await reopened.k.session('approval', approvalOptions)
    for (let i = 1; i <= count; i++)
      await session.resumeApproval(`ticket-${i}`, verdict, { ...actor, id: 'approver' })
    if (count === 2) expect(await run(session)).toMatchObject({ reason: 'parked' })
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(asks).toBe(count)
    expect(executions).toBe(verdict === 'allowed-once' ? count : 0)
    expect(await session.scan({ type: 'tool/call', limit: 10 })).toHaveLength(count)
    expect(JSON.stringify(reopened.provider.requests[0]?.messages)).toContain(
      verdict === 'allowed-once' ? 'approved result' : 'approval rejected',
    )
  },
)

it.each(['uncertain-model', 'uncertain-tool', 'model-receipt', 'assistant-commit', 'tool-receipt'] as const)(
  'cold-resumes mid-turn at %s without repeating effects or assistant messages',
  async (boundary) => {
    let executions = 0
    const f = setup([toolTurn('read', {}), textTurn('final')])
    const tool = readTool(async () => {
      executions++
      return { content: [{ type: 'text', text: 'read once' }] }
    })
    f.k.tools.add(tool, { source: 'test', trust: 'builtin' })
    const session = await f.k.session('cold', { ...options, loop: f.loop })
    await enqueue(session)
    let snapshot: Awaited<ReturnType<typeof session.scan>> | undefined
    let opCells: import('../src/log/storage.js').RegisterRow[] = []
    const commit = (f.k.o.storage as MemoryStorage).commit.bind(f.k.o.storage)
    vi.spyOn(f.k.o.storage, 'commit').mockImplementation(async (key, tx) => {
      const result = await commit(key, tx)
      const match = tx.events.some((row) => {
        if (boundary === 'assistant-commit') return row.type === 'assistant/message'
        const data = row.data as { status?: string; invocationId?: string }
        return (
          row.type === 'x/core/loop-invocation' &&
          data.status === (boundary.startsWith('uncertain') ? 'may-have-sent' : 'responded') &&
          data.invocationId?.includes(
            boundary === 'tool-receipt' || boundary === 'uncertain-tool' ? ':tool:0:0' : ':model:0',
          )
        )
      })
      if (!snapshot && match) {
        snapshot = await f.k.o.storage.scan(key, { fromSeq: 1, limit: 10000 })
        opCells = (await f.k.o.storage.registers(key)).filter((row) => row.register === 'op.state')
      }
      return result
    })
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(snapshot).toBeTruthy()
    const reopened = setup(
      [textTurn('cold final')],
      {},
      { storage: MemoryStorage.fromEvents('cold', snapshot!, { opCells }) },
    )
    reopened.k.tools.add(tool, { source: 'test', trust: 'builtin' })
    const cold = await reopened.k.session('cold', options)
    await cold.resume()
    if (boundary.startsWith('uncertain')) {
      expect(await run(cold)).toMatchObject({
        reason: 'error',
        error: {
          message: expect.stringContaining(
            boundary === 'uncertain-model' ? 'uncertain model invocation' : 'uncertain tool invocation',
          ),
        },
      })
      expect(reopened.provider.calls).toBe(0)
      expect(await cold.scan({ type: 'tool/call', limit: 10 })).toEqual([])
      return
    }
    expect(await run(cold)).toMatchObject({ reason: 'completed' })
    expect(reopened.provider.calls).toBe(1)
    expect(await cold.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(2)
    expect(await cold.scan({ type: 'tool/call', limit: 10 })).toHaveLength(1)
    expect(executions).toBe(boundary === 'tool-receipt' ? 1 : 2)
  },
)

it.each(['wake', 'cancel'] as const)('uses park/%s and starts a clean later turn', async (mode) => {
  const f = setup([textTurn('awake'), textTurn('later')], { waitForWake: true })
  const session = await f.k.session('wait', { ...options, loop: f.loop })
  await enqueue(session)
  await session.step() // claim and save the plugin's wait stage
  let parked = false
  const ctx = f.contexts[0]!
  const park = ctx.wait.park
  ctx.wait.park = async (signal) => {
    parked = true
    await park(signal)
  }
  const active = run(session)
  await expect.poll(() => parked).toBe(true)
  if (mode === 'wake') {
    await session.enqueue('next-step', {
      actor,
      trust: 'untrusted',
      content: [{ type: 'text', text: 'steer' }],
    })
    ctx.wait.wake()
  } else await session.abort()
  expect(await active).toMatchObject({ reason: mode === 'wake' ? 'completed' : 'aborted' })
  if (mode === 'wake') expect(JSON.stringify(f.provider.requests[0]?.messages)).toContain('steer')
  await enqueue(session, 'later')
  await session.step()
  const later = run(session)
  await expect.poll(() => ctx.turn.cancelled()).toBe(false)
  // Wait registration is synchronous once the driver's read view settles.
  await expect.poll(async () => (await ctx.turn.view())?.turnId).toBe(2)
  await session.enqueue('next-step', { actor, content: [{ type: 'text', text: 'continue' }] })
  expect(await later).toMatchObject({ reason: 'completed' })
})

it('cancels an active model stream and settles its effect', async () => {
  const f = setup([])
  let started!: () => void
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  f.provider.infer = async function* (req, options) {
    yield sentFor(req)
    started()
    await new Promise<void>((resolve) => {
      options.signal.addEventListener('abort', () => resolve(), { once: true })
    })
    throw new Error('cancelled stream')
  }
  const session = await f.k.session('cancel', { ...options, loop: f.loop })
  await enqueue(session)
  const running = run(session)
  await active
  await session.abort()
  expect(await running).toMatchObject({ reason: 'aborted' })
  expect(session.pendingEffects()).toEqual([])
})

it('compacts at a low-level step boundary and uses the resulting visible history', async () => {
  const f = setup([textTurn('old answer'), toolTurn('read', {}), textTurn('new answer')], {
    compactAfterTools: true,
  })
  f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
  const session = await f.k.session('compact', { ...options, loop: f.loop })
  session.compaction = new CompactionRunner({
    engine: {
      shouldCompact: () => false,
      async compact(input) {
        return {
          kind: 'replacement',
          mode: 'elision',
          range: [input.conversation[0]!.seq, input.conversation[1]!.seq],
          text: 'SAVED SUMMARY',
        }
      },
    },
    onCompact: async () => {},
  })
  await enqueue(session, 'old user')
  expect(await run(session)).toMatchObject({ reason: 'completed' })
  await enqueue(session, 'new user')
  expect(await run(session)).toMatchObject({ reason: 'completed' })
  const messages = JSON.stringify(f.provider.requests.at(-1)?.messages)
  expect(messages).toContain('SAVED SUMMARY')
  expect(messages).not.toContain('old answer')
  expect(messages).toContain('read:{}')
})

it('starts and joins a real in-process child through the parent-bound public service', async () => {
  const child = inProcessChildAgentProvider()
  const service: ChildAgentService = {
    register: () => async () => {},
    catalog: () => [],
    setSessionAllowlist() {},
    allowlist: () => undefined,
    forSession: (parent) => bindChildAgentSession(service, parent),
    start: (_id, task, options) => child.start(task, options),
    list: async (key) => (await child.list?.(key)) ?? [],
  }
  const f = setup(
    [textTurn('child answer'), textTurn('follow-up answer'), textTurn('parent answer')],
    { childTask: 'research', childMessage: 'check again' },
    { loopChildren: (parent) => service.forSession(parent) },
  )
  const session = await f.k.session('parent', { ...options, loop: f.loop })
  await enqueue(session)
  expect(await run(session)).toMatchObject({ reason: 'completed' })
  expect((await session.scan({ type: 'x/react/child', limit: 1 }))[0]?.data).toMatchObject({
    result: { status: 'idle', text: 'follow-up answer' },
  })
  expect(f.provider.calls).toBe(3)
  expect(f.provider.requests[1]?.sessionKey).toBe(f.provider.requests[0]?.sessionKey)
  expect(f.provider.requests[0]?.sessionKey).not.toBe(session.key)
})

it.each(['steps', 'credits'] as const)('enforces Core %s admission for the low-level loop', async (limit) => {
  const preset = presetDefaults()
  preset.budget = {
    ...preset.budget,
    ...(limit === 'steps' ? { maxSteps: 0 } : { perRequestCap: 0, onExceed: 'deny' }),
  }
  const f = setup(
    [textTurn('must not be sent')],
    {},
    {
      preset,
      seams: fakeSeams({ ledger: { projected: async () => ({ credits: 1, creditSource: 'estimated' }) } }),
    },
  )
  const session = await f.k.session('budget', { ...options, loop: f.loop })
  await enqueue(session)
  expect(await run(session)).toMatchObject({ reason: limit === 'steps' ? 'max_steps' : 'budget' })
  expect(f.provider.calls).toBe(0)
  expect(await session.scan({ type: 'effect/intent', limit: 10 })).toEqual([])
})
