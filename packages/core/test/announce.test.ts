import { canonicalJson, sha256Hex } from '@agnes/core-common/request/hash'
import { presetDefaults } from '@agnes/core-common/step/preset'
import type { IdMinter } from '@agnes/core-common/types'
import { MemoryStorage } from '@agnes/core-ledger/log/memory-storage'
import type { CommitReceipt, CommitTx, RegisterRow } from '@agnes/core-ledger/log/storage'
import {
  type LoopContext,
  type LoopFactory,
  type LoopStepOutcome,
  loopCheckpointCodec,
  type ToolResult,
} from '@agnes/extension-api'
import type { RequestBody } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Kernel } from '../src/kernel.js'
import type { SessionImpl } from '../src/step/session.js'
import { defaultLoops } from '../testkit/loops.js'
import { answerToolDecision } from './helpers/decision.js'
import { fakeProvider, type Script, textTurn, toolTurn } from './helpers/fake-provider.js'
import { fakeSeams } from './helpers/fake-seams.js'
import {
  actor,
  noTimers,
  readTool,
  shellTool,
  testFsOps,
  testWorkspaceInvocation,
} from './helpers/open-session.js'

const codec = loopCheckpointCodec(1, (state) => {
  if (typeof state !== 'string') throw new Error('invalid checkpoint')
  return state
})
const model = {
  id: 'm',
  route: 'default',
  name: 'fake',
  api: 'openai-completions' as const,
  baseUrl: 'https://test.invalid',
  input: ['text'] as 'text'[],
  reasoning: false,
  contextWindow: 100000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  toolCallFormats: ['native'] as 'native'[],
  thinkingReplay: 'native' as const,
  contract_id: null,
}
const signal = () => new AbortController().signal

type Step = (ctx: LoopContext, signal: AbortSignal) => Promise<LoopStepOutcome>
type Seams = ReturnType<typeof fakeSeams>

function loopOf(step: Step): LoopFactory {
  const create = (ctx: LoopContext) => ({
    cancel() {},
    dispose() {},
    checkpoint: () => codec.encode('ready'),
    step: (stepSignal: AbortSignal) => step(ctx, stepSignal),
  })
  return {
    id: 'test.announce',
    version: '1.0.0',
    capabilities: ['model', 'tools'],
    codec,
    create,
    resume: create,
  }
}

/** One step per turn: accept the input, do the work, then ask to complete the turn. */
const perTurn =
  (work: (ctx: LoopContext, signal: AbortSignal, turn: number) => Promise<void>): Step =>
  async (ctx, stepSignal) => {
    const input = await ctx.input.accept()
    if (!input) return { outcome: 'idle', phase: 'idle' }
    await work(ctx, stepSignal, input.turnId)
    return ctx.events.finish('completed')
  }

const kernels: Kernel[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const k of kernels.splice(0)) await k.close()
})

function setup(
  step: Step,
  o: {
    scripts?: Script[]
    storage?: MemoryStorage
    seams?: Seams
    ids?: IdMinter
    clock?: () => number
  } = {},
) {
  const provider = fakeProvider(o.scripts ?? [textTurn('answer')])
  provider.models = () => [model]
  const loops = defaultLoops()
  const loop = loopOf(step)
  loops.register('@test/announce', loop)
  const storage = o.storage ?? new MemoryStorage()
  const seams = o.seams ?? fakeSeams()
  const k = Kernel.create({
    storage,
    loops,
    provider,
    preset: presetDefaults(),
    seams,
    contract: { contract_id: null, parser_version: '1' },
    fsOps: testFsOps(),
    netFetch: async () => new Response(''),
    timers: noTimers,
    ...(o.ids ? { ids: o.ids } : {}),
    ...(o.clock ? { clock: o.clock } : {}),
  })
  kernels.push(k)
  const options = {
    actor,
    cwd: '/w',
    resolvedProfileHash: null,
    writerRunId: 'announce',
    workspaceInvocation: testWorkspaceInvocation(testFsOps(), seams),
  }
  const open = (key: string) => k.session(key, { ...options, loop }) as Promise<SessionImpl>
  const reopen = (key: string) => k.session(key, options) as Promise<SessionImpl>
  return { k, loop, provider, storage, open, reopen }
}

async function enqueue(session: SessionImpl, text = 'go') {
  await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
}
const run = (session: SessionImpl) => session.run({ until: 'turn-end', signal: signal() })

/** Every commit the storage accepts, with the seqs it gave the rows. */
function commits(storage: MemoryStorage) {
  const seen: Array<{ tx: CommitTx; receipt: CommitReceipt }> = []
  const commit = storage.commit.bind(storage)
  vi.spyOn(storage, 'commit').mockImplementation(async (key, tx) => {
    const receipt = await commit(key, tx)
    seen.push({ tx: structuredClone(tx), receipt })
    return receipt
  })
  return seen
}
const types = (tx: CommitTx) => tx.events.map((row) => row.type)
const dataOf = (row: { data: unknown }) => row.data as Record<string, unknown>
/** The result text of an announced call that never started. */
const NOT_STARTED = (name: string) => `${name} was announced but did not run`

function countingRead(counter: { n: number }, text = 'read once') {
  return readTool(async () => {
    counter.n++
    return { content: [{ type: 'text', text }] }
  })
}

describe('announced tool calls', () => {
  it('commits the assistant message and the call in one transaction before running it', async () => {
    let result: ToolResult | undefined
    let before: RequestBody | undefined
    const f = setup(
      perTurn(async (ctx, s) => {
        before = await ctx.prepareRequest()
        result = await ctx.tools.execute({ name: 'read', args: {}, invocationId: 'pass' }, s, {
          announce: true,
        })
        await ctx.model.complete(await ctx.prepareRequest(), s)
      }),
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const seen = commits(f.storage)
    const session = await f.open('atomic')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'read:{}' }] })

    const announced = seen.filter(({ tx }) => types(tx).includes('assistant/message'))
    expect(announced).toHaveLength(1)
    const { tx, receipt } = announced[0]!
    expect(types(tx)).toEqual(['assistant/message', 'tool/call', 'x/core/loop-effect'])
    const [assistant, call, link] = tx.events
    expect(assistant).toMatchObject({ origin: 'model', data: { content: [], stopReason: 'tool_use' } })
    expect(dataOf(assistant!)).not.toHaveProperty('requestSeq')
    expect(call).toMatchObject({ origin: 'model', data: { name: 'read', args: {}, ordinal: 0, depth: 0 } })
    const toolUseId = dataOf(call!).toolUseId as string
    expect(link?.data).toEqual({ invocationId: 'pass', toolUseId })
    const assistantSeq = receipt.firstSeq
    expect(receipt.seqs).toEqual([assistantSeq, assistantSeq + 1, assistantSeq + 2])
    expect(tx.opState?.data).toMatchObject({
      latestAssistantSeq: assistantSeq,
      phase: {
        kind: 'tools',
        batch: { assistantSeq, calls: [{ toolUseId, argsSeq: assistantSeq + 1, status: 'planned' }] },
      },
    })
    // Nothing ran inside the planning transaction: the intent follows it, bound to the call row.
    const intents = (await session.scan({ type: 'effect/intent', limit: 20 })).filter(
      (row) => dataOf(row).kind === 'tool',
    )
    expect(intents).toHaveLength(1)
    expect(intents[0]!.seq).toBeGreaterThan(assistantSeq + 2)
    expect(intents[0]!.data).toMatchObject({ argsSeq: assistantSeq + 1, tool: { toolUseId, name: 'read' } })
    expect(await session.scan({ type: 'tool/result', limit: 20 })).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ toolUseId }) }),
    ])
    expect(await session.op()).toBeNull()
    expect((await f.storage.registers(session.key)).filter((row) => row.register === 'op.state')).toEqual([])

    // The next request only appends: the earlier messages are untouched, and the pair closes it.
    const messages = f.provider.requests[0]!.messages
    expect(messages.slice(0, before!.messages.length)).toEqual(before!.messages)
    expect(messages.slice(before!.messages.length)).toEqual([
      { role: 'assistant', content: [], toolCalls: [{ toolUseId, name: 'read', args: {}, ordinal: 0 }] },
      {
        role: 'tool_result',
        toolUseId,
        content: [expect.objectContaining({ type: 'text', text: expect.stringContaining('read:{}') })],
        isError: false,
      },
    ])
  })

  it('does not attach a call made in a later turn to the previous answer', async () => {
    const requests = async (announce: boolean) => {
      const f = setup(
        perTurn(async (ctx, s, turn) => {
          if (turn === 1) {
            const response = await ctx.model.complete(await ctx.prepareRequest(), s)
            const text = response.flatMap((e) => (e.type === 'text_delta' ? [e.delta] : [])).join('')
            await ctx.events.assistant(
              { content: [{ type: 'text', text }], stopReason: 'end_turn' },
              codec.encode('ready'),
            )
            return
          }
          await ctx.tools.execute({ name: 'read', args: {} }, s, announce ? { announce: true } : undefined)
          await ctx.model.complete(await ctx.prepareRequest(), s)
        }),
        { scripts: [textTurn('first answer'), textTurn('second answer')] },
      )
      f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
      const session = await f.open(`later-${announce}`)
      await enqueue(session, 'first question')
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      await enqueue(session, 'second question')
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      return f.provider.requests.map((request) => request.messages)
    }
    const text = (message: RequestBody['messages'][number]) => JSON.stringify(message.content)

    const [first, second] = await requests(true)
    const answer = second!.findIndex((m) => m.role === 'assistant' && text(m).includes('first answer'))
    const question = second!.findIndex((m) => m.role === 'user' && text(m).includes('second question'))
    expect(answer).toBeGreaterThan(-1)
    expect(second![answer]).not.toHaveProperty('toolCalls')
    expect(question).toBe(answer + 1)
    expect(second!.slice(0, first!.length)).toEqual(first)
    expect(second!.slice(-2)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [],
        toolCalls: [expect.objectContaining({ name: 'read' })],
      }),
      expect.objectContaining({ role: 'tool_result' }),
    ])

    // Without announce the call is attributed afterwards to the newest assistant message, which here
    // is the previous turn's answer, and its result is moved in front of the new question.
    const [, control] = await requests(false)
    const attached = control!.find((m) => m.role === 'assistant' && text(m).includes('first answer'))
    expect(attached).toHaveProperty('toolCalls', [expect.objectContaining({ name: 'read' })])
    const result = control!.findIndex((m) => m.role === 'tool_result')
    const asked = control!.findIndex((m) => m.role === 'user' && text(m).includes('second question'))
    expect(result).toBeLessThan(asked)
  })

  it('writes one assistant message for an announced batch, with argsSeq skipping each link row', async () => {
    let results: readonly ToolResult[] = []
    const f = setup(
      perTurn(async (ctx, s) => {
        results = await ctx.tools.batch(
          [
            { name: 'a', args: {} },
            { name: 'b', args: {} },
            { name: 'c', args: {} },
          ],
          s,
          { announce: true },
        )
        await ctx.model.complete(await ctx.prepareRequest(), s)
      }),
    )
    for (const name of ['a', 'b', 'c'])
      f.k.tools.add(
        {
          ...(readTool(async () => ({ content: [{ type: 'text', text: `from ${name}` }] })) as object),
          name,
        } as never,
        { source: 'test', trust: 'builtin' },
      )
    const seen = commits(f.storage)
    const session = await f.open('batch')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(results.map((r) => r.content)).toEqual([
      [{ type: 'text', text: 'from a' }],
      [{ type: 'text', text: 'from b' }],
      [{ type: 'text', text: 'from c' }],
    ])
    const announced = seen.filter(({ tx }) => types(tx).includes('assistant/message'))
    expect(announced).toHaveLength(1)
    const { tx, receipt } = announced[0]!
    expect(types(tx)).toEqual([
      'assistant/message',
      'tool/call',
      'x/core/loop-effect',
      'tool/call',
      'x/core/loop-effect',
      'tool/call',
      'x/core/loop-effect',
    ])
    const assistantSeq = receipt.firstSeq
    const calls = (await session.scan({ type: 'tool/call', limit: 20 })).map((row) => ({
      seq: row.seq,
      toolUseId: dataOf(row).toolUseId as string,
      ordinal: dataOf(row).ordinal,
    }))
    expect(calls.map((call) => call.seq)).toEqual([0, 1, 2].map((i) => assistantSeq + 1 + 2 * i))
    expect(calls.map((call) => call.ordinal)).toEqual([0, 1, 2])
    const op = tx.opState?.data as
      | { phase: { batch: { assistantSeq: number; calls: unknown[] } } }
      | undefined
    const planned = op?.phase.batch ?? { assistantSeq: 0, calls: [] }
    expect(planned.assistantSeq).toBe(assistantSeq)
    expect(planned.calls).toEqual(
      calls.map((call) =>
        expect.objectContaining({ toolUseId: call.toolUseId, argsSeq: call.seq, status: 'planned' }),
      ),
    )
    const intents = (await session.scan({ type: 'effect/intent', limit: 20 })).filter(
      (row) => dataOf(row).kind === 'tool',
    )
    expect(
      intents.map((row) => [(dataOf(row).tool as { toolUseId: string }).toolUseId, dataOf(row).argsSeq]),
    ).toEqual(expect.arrayContaining(calls.map((call) => [call.toolUseId, call.seq])))
    expect(intents).toHaveLength(3)

    const messages = f.provider.requests[0]!.messages
    const owners = messages.filter((m) => m.role === 'assistant')
    expect(owners).toEqual([
      {
        role: 'assistant',
        content: [],
        toolCalls: calls.map((call, i) => ({
          toolUseId: call.toolUseId,
          name: ['a', 'b', 'c'][i],
          args: {},
          ordinal: i,
        })),
      },
    ])
    expect(messages.slice(-3).map((m) => (m.role === 'tool_result' ? m.toolUseId : m.role))).toEqual(
      calls.map((call) => call.toolUseId),
    )
  })

  it('keeps the model text of a call it dispatches and links the request that produced it', async () => {
    const f = setup(
      perTurn(async (ctx, s) => {
        const response = await ctx.model.complete(await ctx.prepareRequest(), s)
        const call = response.flatMap((e) => (e.type === 'toolcall_end' ? [e.call] : []))[0]!
        await ctx.tools.execute({ name: call.name, args: call.args }, s, {
          announce: { content: [{ type: 'text', text: 'reading first' }] },
        })
        await ctx.model.complete(await ctx.prepareRequest(), s)
      }),
      { scripts: [toolTurn('read', {}), textTurn('done')] },
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await f.open('authored')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    const [header] = await session.scan({ type: 'request/header', limit: 1 })
    const assistants = await session.scan({ type: 'assistant/message', limit: 10 })
    expect(assistants).toHaveLength(1)
    expect(assistants[0]!.data).toEqual({
      content: [{ type: 'text', text: 'reading first' }],
      stopReason: 'tool_use',
      requestSeq: header!.seq,
    })
    const [, next] = f.provider.requests
    expect(next!.messages.find((m) => m.role === 'assistant')).toMatchObject({
      content: [{ type: 'text', text: 'reading first' }],
      toolCalls: [expect.objectContaining({ name: 'read' })],
    })
  })

  it.each([
    ['an unknown tool', { name: 'missing', args: {} }, 'TOOL_NOT_FOUND'],
    ['invalid arguments', { name: 'read', args: 5 }, 'TOOL_ARGS_INVALID'],
  ] as const)('dispatches nothing when an announced batch holds %s', async (_name, bad, code) => {
    let refused: unknown
    let written: number[] = []
    const f = setup(
      perTurn(async (ctx, s) => {
        written = [session.lastSeq]
        refused = await ctx.tools
          .batch([{ name: 'read', args: {} }, bad as never], s, { announce: true })
          .catch((error: unknown) => error)
        written.push(session.lastSeq)
      }),
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await f.open(`invalid-${code}`)
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(refused).toMatchObject({ code })
    expect(written[1]! - written[0]!).toBe(code === 'TOOL_ARGS_INVALID' ? 1 : 0)
    if (code === 'TOOL_ARGS_INVALID')
      expect(
        (await session.scan({ type: 'x/core/tool-argument-recovery', limit: 1 }))[0]?.data,
      ).toMatchObject({ name: 'read', failures: 1, disabled: false })
    expect(await session.scan({ type: 'tool/call', limit: 10 })).toEqual([])
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toEqual([])
    expect(await session.scan({ type: 'x/core/loop-invocation', limit: 10 })).toEqual([])
  })

  it('refuses a batch that names one invocationId twice before writing anything', async () => {
    let refused: unknown
    let status: unknown
    let fresh: readonly ToolResult[] = []
    const written: number[] = []
    const f = setup(
      perTurn(async (ctx, s) => {
        written.push(session.lastSeq)
        refused = await ctx.tools
          .batch(
            [
              { name: 'read', args: {}, invocationId: 'twice' },
              { name: 'read', args: { n: 2 }, invocationId: 'twice' },
            ],
            s,
            { announce: true },
          )
          .catch((error: unknown) => error)
        written.push(session.lastSeq)
        status = await ctx.effects.status('twice')
        fresh = await ctx.tools.batch([{ name: 'read', args: {}, invocationId: 'once' }], s, {
          announce: true,
        })
      }),
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await f.open('duplicate-ids')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(refused).toMatchObject({ code: 'E_RELATION', message: expect.stringContaining('more than once') })
    expect(written[1]).toBe(written[0])
    expect(status).toEqual({ status: 'not-sent', invocationId: 'twice' })
    expect(fresh).toEqual([{ content: [{ type: 'text', text: 'read:{}' }] }])
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1)
    expect(await session.scan({ type: 'tool/call', limit: 10 })).toHaveLength(1)
  })

  it('refuses announced content other than text and thinking before writing anything', async () => {
    let refused: unknown
    const f = setup(
      perTurn(async (ctx, s) => {
        refused = await ctx.tools
          .execute({ name: 'read', args: {} }, s, {
            announce: { content: [{ type: 'tool_use', text: 'x' }] } as never,
          })
          .catch((error: unknown) => error)
      }),
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await f.open('bad-content')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(refused).toMatchObject({ code: 'E_ENVELOPE' })
    expect(await session.scan({ type: 'x/core/loop-invocation', limit: 10 })).toEqual([])
    expect(await session.scan({ type: 'tool/call', limit: 10 })).toEqual([])
  })

  it('refuses to announce while an earlier call is still running', async () => {
    let release!: () => void
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let refused: unknown
    const f = setup(
      perTurn(async (ctx, s) => {
        const slow = ctx.tools.execute({ name: 'slow', args: {} }, s)
        await running
        refused = await ctx.tools
          .execute({ name: 'read', args: {} }, s, { announce: true })
          .catch((error: unknown) => error)
        release()
        await slow
      }),
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    f.k.tools.add(
      {
        ...(readTool(async () => {
          started()
          await gate
          return { content: [{ type: 'text', text: 'slow' }] }
        }) as object),
        name: 'slow',
      } as never,
      { source: 'test', trust: 'builtin' },
    )
    const session = await f.open('unsettled')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(refused).toMatchObject({ code: 'E_RELATION' })
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toEqual([])
    expect((await session.scan({ type: 'tool/call', limit: 10 })).map((row) => dataOf(row).name)).toEqual([
      'slow',
    ])
  })

  it('still asks for approval and applies a refusal to an announced call', async () => {
    let executions = 0
    let asked = 0
    const seams = fakeSeams({
      approval: {
        ask: async () => {
          asked++
          return { verdict: 'rejected', answeredBy: actor }
        },
      },
    })
    let result: ToolResult | undefined
    const f = setup(
      perTurn(async (ctx, s) => {
        result = await ctx.tools.execute({ name: 'shell', args: {} }, s, { announce: true })
      }),
      { seams },
    )
    f.k.tools.add(
      shellTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'ran' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const session = await f.open('approval-refused')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(asked).toBe(1)
    expect(executions).toBe(0)
    expect(result).toMatchObject({ isError: true })
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1)
  })

  it('keeps the pair across an approval park and resume', async () => {
    const seams = fakeSeams({
      approval: {
        ask: async () => ({ ticket: 'ticket-1', expiresAt: new Date(Date.now() + 60000).toISOString() }),
      },
    })
    let stage: 'start' | 'parked' = 'start'
    let result: ToolResult | undefined
    let executions = 0
    const f = setup(
      async (ctx, s) => {
        if (stage === 'parked') {
          if ((await ctx.input.resumeParked()) !== 'opened') return { outcome: 'parked', reason: 'parked' }
          result = await ctx.tools.resume('needs-approval', s)
          await ctx.model.complete(await ctx.prepareRequest(), s)
          return ctx.events.finish('completed')
        }
        if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
        try {
          await ctx.tools.execute({ name: 'shell', args: {}, invocationId: 'needs-approval' }, s, {
            announce: true,
          })
        } catch (error) {
          if ((error as { code?: string }).code !== 'PARKED') throw error
          stage = 'parked'
          return { outcome: 'parked', reason: 'parked' }
        }
        throw new Error('the call should have parked')
      },
      { seams },
    )
    f.k.tools.add(
      shellTool(async () => {
        executions++
        return { content: [{ type: 'text', text: 'approved result' }] }
      }),
      { source: 'test', trust: 'builtin' },
    )
    const session = await f.open('park')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'parked' })
    expect(executions).toBe(0)
    await answerToolDecision(session, 1, 'allowed-once', { ...actor, id: 'approver' })
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(executions).toBe(1)
    expect(result).toEqual({ content: [{ type: 'text', text: 'approved result' }] })
    const [call] = await session.scan({ type: 'tool/call', limit: 10 })
    const toolUseId = dataOf(call!).toolUseId
    const messages = f.provider.requests[0]!.messages
    expect(messages.slice(-2)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: [],
        toolCalls: [expect.objectContaining({ toolUseId })],
      }),
      expect.objectContaining({ role: 'tool_result', toolUseId, isError: false }),
    ])
  })
})

describe('replay after a crash', () => {
  /** Runs one turn and keeps the ledger as it stood right after the first commit `cut` matches. */
  async function crashAt(
    key: string,
    work: (ctx: LoopContext, signal: AbortSignal) => Promise<void>,
    cut: (tx: CommitTx) => boolean,
    tools: unknown[] = [readTool()],
  ) {
    const f = setup(perTurn(work))
    for (const tool of tools) f.k.tools.add(tool as never, { source: 'test', trust: 'builtin' })
    let snapshot: Awaited<ReturnType<MemoryStorage['scan']>> | undefined
    let opCells: RegisterRow[] = []
    const commit = f.storage.commit.bind(f.storage)
    vi.spyOn(f.storage, 'commit').mockImplementation(async (k, tx) => {
      const receipt = await commit(k, tx)
      if (!snapshot && cut(tx)) {
        snapshot = await f.storage.scan(k, { fromSeq: 1, limit: 10000 })
        opCells = (await f.storage.registers(k)).filter((row) => row.register === 'op.state')
      }
      return receipt
    })
    const session = await f.open(key)
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(snapshot).toBeTruthy()
    return MemoryStorage.fromEvents(key, snapshot!, { opCells })
  }
  const planned = (tx: CommitTx) => types(tx).includes('tool/call')

  it('continues an announced call that was planned but never dispatched, once', async () => {
    const pass = (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.execute({ name: 'read', args: {}, invocationId: 'pass:1' }, s, { announce: true })
    const storage = await crashAt('resume-announced', async (ctx, s) => void (await pass(ctx, s)), planned)
    const counter = { n: 0 }
    let result: ToolResult | undefined
    let again: ToolResult | undefined
    const reopened = setup(
      perTurn(async (ctx, s) => {
        result = await pass(ctx, s)
        again = await pass(ctx, s)
      }),
      { storage },
    )
    reopened.k.tools.add(countingRead(counter), { source: 'test', trust: 'builtin' })
    const session = await reopened.reopen('resume-announced')
    await session.resume()
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(counter.n).toBe(1)
    expect(result).toEqual({ content: [{ type: 'text', text: 'read once' }] })
    expect(again).toEqual(result)
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1)
    const calls = await session.scan({ type: 'tool/call', limit: 10 })
    expect(calls).toHaveLength(1)
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(results.map((row) => dataOf(row).toolUseId)).toEqual([dataOf(calls[0]!).toolUseId])
    const intents = (await session.scan({ type: 'effect/intent', limit: 10 })).filter(
      (row) => dataOf(row).kind === 'tool',
    )
    expect(intents.map((row) => dataOf(row).argsSeq)).toEqual([calls[0]!.seq])
  })

  it('replays a batch call by call: a responded call returns its result, a planned one runs', async () => {
    /** Not concurrency-safe, so the batch runs the calls one after the other. */
    const serial = (name: string, counter: { n: number }) =>
      ({
        ...(readTool(async () => {
          counter.n++
          return { content: [{ type: 'text', text: `from ${name}` }] }
        }) as { meta: object }),
        name,
        meta: { ...(readTool() as { meta: object }).meta, isConcurrencySafe: false },
      }) as never
    const batch = (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.batch(
        [
          { name: 'first', args: {}, invocationId: 'pair:1' },
          { name: 'second', args: {}, invocationId: 'pair:2' },
        ],
        s,
        { announce: true },
      )
    const before = { first: { n: 0 }, second: { n: 0 } }
    const storage = await crashAt(
      'resume-batch',
      async (ctx, s) => void (await batch(ctx, s)),
      (tx) =>
        tx.events.some(
          (row) =>
            row.type === 'x/core/loop-invocation' &&
            (row.data as { invocationId?: string; status?: string }).invocationId === 'pair:1' &&
            (row.data as { status?: string }).status === 'responded',
        ),
      [serial('first', before.first), serial('second', before.second)],
    )
    const after = { first: { n: 0 }, second: { n: 0 } }
    let results: readonly ToolResult[] = []
    const reopened = setup(
      perTurn(async (ctx, s) => {
        results = await batch(ctx, s)
      }),
      { storage },
    )
    reopened.k.tools.add(serial('first', after.first), { source: 'test', trust: 'builtin' })
    reopened.k.tools.add(serial('second', after.second), { source: 'test', trust: 'builtin' })
    const session = await reopened.reopen('resume-batch')
    await session.resume()
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect([after.first.n, after.second.n]).toEqual([0, 1])
    expect(results.map((result) => result.content)).toEqual([
      [{ type: 'text', text: 'from first' }],
      [{ type: 'text', text: 'from second' }],
    ])
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1)
    expect(await session.scan({ type: 'tool/call', limit: 10 })).toHaveLength(2)
    expect(await session.scan({ type: 'tool/result', limit: 10 })).toHaveLength(2)
  })

  it('closes the planned call once a later step has opened, and a replay then returns that result', async () => {
    const pass = (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.execute({ name: 'read', args: {}, invocationId: 'pass:3' }, s, { announce: true })
    const storage = await crashAt('resume-late', async (ctx, s) => void (await pass(ctx, s)), planned)
    const counter = { n: 0 }
    let replayed: unknown
    const reopened = setup(
      async (ctx, s) => {
        if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
        // A tool port call in a new driver step opens a new step first.
        await ctx.tools.execute({ name: 'other', args: {} }, s)
        replayed = await pass(ctx, s).catch((error: unknown) => error)
        return ctx.events.finish('aborted')
      },
      { storage },
    )
    reopened.k.tools.add(countingRead(counter), { source: 'test', trust: 'builtin' })
    reopened.k.tools.add({ ...(readTool() as object), name: 'other' } as never, {
      source: 'test',
      trust: 'builtin',
    })
    const session = await reopened.reopen('resume-late')
    await session.resume()
    await run(session)
    expect(counter.n).toBe(0)
    expect(replayed).toEqual({ content: [{ type: 'text', text: NOT_STARTED('read') }], isError: true })
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toHaveLength(1)
    const [stranded] = await session.scan({ type: 'tool/call', limit: 1 })
    const results = await session.scan({ type: 'tool/result', limit: 10 })
    expect(
      results.filter((row) => dataOf(row).toolUseId === dataOf(stranded!).toolUseId).map((row) => row.data),
    ).toEqual([expect.objectContaining({ code: 'TOOL_NOT_STARTED', isError: true })])
  })

  it('keeps refusing to replay an unannounced call that may have been sent', async () => {
    const plain = (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.execute({ name: 'read', args: {}, invocationId: 'plain:1' }, s)
    const storage = await crashAt('resume-plain', async (ctx, s) => void (await plain(ctx, s)), planned)
    const counter = { n: 0 }
    const refusals: unknown[] = []
    const reopened = setup(
      perTurn(async (ctx, s) => {
        refusals.push(await plain(ctx, s).catch((error: unknown) => error))
        refusals.push(
          await ctx.tools
            .execute({ name: 'read', args: {}, invocationId: 'plain:1' }, s, { announce: true })
            .catch((error: unknown) => error),
        )
      }),
      { storage },
    )
    reopened.k.tools.add(countingRead(counter), { source: 'test', trust: 'builtin' })
    const session = await reopened.reopen('resume-plain')
    await session.resume()
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(counter.n).toBe(0)
    expect(refusals).toEqual([
      expect.objectContaining({ code: 'E_RELATION', message: expect.stringContaining('reconcile') }),
      expect.objectContaining({
        code: 'E_RELATION',
        message: expect.stringContaining('different operation'),
      }),
    ])
    expect(await session.scan({ type: 'assistant/message', limit: 10 })).toEqual([])
  })

  it('does not replay an announced call as an unannounced one', async () => {
    const storage = await crashAt(
      'resume-mismatch',
      async (ctx, s) =>
        void (await ctx.tools.execute({ name: 'read', args: {}, invocationId: 'pass:2' }, s, {
          announce: true,
        })),
      planned,
    )
    const counter = { n: 0 }
    let refused: unknown
    const reopened = setup(
      perTurn(async (ctx, s) => {
        refused = await ctx.tools
          .execute({ name: 'read', args: {}, invocationId: 'pass:2' }, s)
          .catch((error: unknown) => error)
      }),
      { storage },
    )
    reopened.k.tools.add(countingRead(counter), { source: 'test', trust: 'builtin' })
    const session = await reopened.reopen('resume-mismatch')
    await session.resume()
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    expect(counter.n).toBe(0)
    expect(refused).toMatchObject({
      code: 'E_RELATION',
      message: expect.stringContaining('different operation'),
    })
  })

  describe('an announced call that never started', () => {
    const pass = (id: string) => (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.execute({ name: 'read', args: {}, invocationId: id }, s, { announce: true })
    /** Reopens `storage` on a loop running `work` once per turn, with a counting `read`. */
    async function reopenWith(
      key: string,
      storage: MemoryStorage,
      work: (ctx: LoopContext, signal: AbortSignal) => Promise<unknown>,
      tools: unknown[] = [],
      seams?: Seams,
    ) {
      const counter = { n: 0 }
      const f = setup(
        perTurn(async (ctx, s) => void (await work(ctx, s))),
        { storage, ...(seams ? { seams } : {}) },
      )
      f.k.tools.add(countingRead(counter), { source: 'test', trust: 'builtin' })
      for (const tool of tools) f.k.tools.add(tool as never, { source: 'test', trust: 'builtin' })
      const seen = commits(storage)
      const session = await f.reopen(key)
      await session.resume()
      return { f, counter, seen, session }
    }
    const closers = (seen: ReturnType<typeof commits>) =>
      seen.filter(({ tx }) =>
        tx.events.some((row) => row.type === 'tool/result' && dataOf(row).code === 'TOOL_NOT_STARTED'),
      )
    const pairOf = (toolUseId: string, name: string) => [
      { role: 'assistant', content: [], toolCalls: [{ toolUseId, name, args: {}, ordinal: 0 }] },
      {
        role: 'tool_result',
        toolUseId,
        content: [
          expect.objectContaining({ type: 'text', text: expect.stringContaining(NOT_STARTED(name)) }),
        ],
        isError: true,
      },
    ]

    it('still runs it once when the loop replays it first, and writes no not-started result', async () => {
      const storage = await crashAt('first', async (ctx, s) => void (await pass('first:1')(ctx, s)), planned)
      let result: ToolResult | undefined
      const { counter, seen, session, f } = await reopenWith('first', storage, async (ctx, s) => {
        result = await pass('first:1')(ctx, s)
        await ctx.model.complete(await ctx.prepareRequest(), s)
      })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(counter.n).toBe(1)
      expect(result).toEqual({ content: [{ type: 'text', text: 'read once' }] })
      expect(closers(seen)).toEqual([])
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => dataOf(row).isError)).toEqual([false])
      const [call] = await session.scan({ type: 'tool/call', limit: 1 })
      const messages = f.provider.requests[0]!.messages
      expect(messages.slice(-2)).toEqual([
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [expect.objectContaining({ name: 'read' })],
        }),
        expect.objectContaining({ role: 'tool_result', toolUseId: dataOf(call!).toolUseId, isError: false }),
      ])
    })

    it('closes it with a not-started result before the model is asked, so the request is paired', async () => {
      const storage = await crashAt('model', async (ctx, s) => void (await pass('model:1')(ctx, s)), planned)
      let replayed: ToolResult | undefined
      const { counter, session, f } = await reopenWith('model', storage, async (ctx, s) => {
        await ctx.model.complete(await ctx.prepareRequest(), s)
        replayed = await pass('model:1')(ctx, s)
      })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(counter.n).toBe(0)
      const [call] = await session.scan({ type: 'tool/call', limit: 1 })
      const toolUseId = dataOf(call!).toolUseId as string
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results).toEqual([
        expect.objectContaining({
          sourceEventSeqs: [call!.seq],
          data: expect.objectContaining({
            toolUseId,
            content: [{ type: 'text', text: NOT_STARTED('read') }],
            isError: true,
            code: 'TOOL_NOT_STARTED',
          }),
        }),
      ])
      // The first request after the reopen is derived with the result already in place.
      const messages = f.provider.requests[0]!.messages
      const at = messages.findIndex((m) => m.role === 'assistant')
      expect(messages.slice(at)).toEqual(pairOf(toolUseId, 'read'))
      // Replaying it now does not run it: it returns the result the history holds.
      expect(replayed).toEqual({ content: [{ type: 'text', text: NOT_STARTED('read') }], isError: true })
    })

    it('closes it in the step-closing commit when the loop announces another call first', async () => {
      const storage = await crashAt('tool', async (ctx, s) => void (await pass('tool:1')(ctx, s)), planned)
      let fresh: ToolResult | undefined
      const { counter, seen, session, f } = await reopenWith('tool', storage, async (ctx, s) => {
        fresh = await pass('tool:2')(ctx, s)
        await ctx.model.complete(await ctx.prepareRequest(), s)
      })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(counter.n).toBe(1)
      expect(fresh).toEqual({ content: [{ type: 'text', text: 'read once' }] })
      const calls = await session.scan({ type: 'tool/call', limit: 10 })
      expect(calls).toHaveLength(2)
      const [stranded, next] = calls.map((row) => dataOf(row).toolUseId as string)
      const [closing, ...more] = closers(seen)
      expect(more).toEqual([])
      expect(types(closing!.tx)).toEqual(['tool/result', 'step/end'])
      expect(closing!.tx.events[0]).toMatchObject({ data: { toolUseId: stranded, code: 'TOOL_NOT_STARTED' } })
      expect(closing!.tx.opState?.data).toMatchObject({
        phase: { kind: 'tools', batch: { calls: [{ toolUseId: stranded, status: 'completed' }] } },
      })
      const messages = f.provider.requests[0]!.messages
      const at = messages.findIndex((m) => m.role === 'assistant')
      expect(messages.slice(at)).toEqual([
        ...pairOf(stranded!, 'read'),
        expect.objectContaining({
          role: 'assistant',
          toolCalls: [expect.objectContaining({ toolUseId: next })],
        }),
        expect.objectContaining({ role: 'tool_result', toolUseId: next, isError: false }),
      ])
    })

    it('leaves a call that was dispatched to recovery', async () => {
      const dispatched = (tx: CommitTx) =>
        tx.events.some((row) => row.type === 'effect/intent' && dataOf(row).kind === 'tool')
      const storage = await crashAt('sent', async (ctx, s) => void (await pass('sent:1')(ctx, s)), dispatched)
      let pending: unknown
      const { counter, seen, session } = await reopenWith('sent', storage, async (ctx, s) => {
        // Recovery keeps a safe read for a second attempt: dispatched, with no result yet.
        pending = structuredClone(session.op())
        await ctx.prepareRequest()
        await ctx.tools.drain(s)
      })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(pending).toMatchObject({
        phase: { batch: { calls: [{ status: 'dispatch_pending', dispatchAttempt: 2 }] } },
      })
      expect(counter.n).toBe(1)
      expect(closers(seen)).toEqual([])
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => [dataOf(row).code, dataOf(row).isError])).toEqual([[undefined, false]])
    })

    it('closes every call of an announced batch in the one commit that ends the step', async () => {
      const names = ['a', 'b', 'c']
      const tool = (name: string, counter: { n: number }) =>
        ({
          ...(readTool(async () => {
            counter.n++
            return { content: [{ type: 'text', text: `from ${name}` }] }
          }) as object),
          name,
        }) as never
      const batch = (ctx: LoopContext, s: AbortSignal) =>
        ctx.tools.batch(
          names.map((name) => ({ name, args: {}, invocationId: `batch:${name}` })),
          s,
          { announce: true },
        )
      const storage = await crashAt(
        'batch',
        async (ctx, s) => void (await batch(ctx, s)),
        planned,
        names.map((name) => tool(name, { n: 0 })),
      )
      const counters = names.map(() => ({ n: 0 }))
      const { seen, session, f } = await reopenWith(
        'batch',
        storage,
        async (ctx, s) => {
          await ctx.turn.endStep()
          await ctx.model.complete(await ctx.prepareRequest(), s)
        },
        names.map((name, i) => tool(name, counters[i]!)),
      )
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(counters.map((counter) => counter.n)).toEqual([0, 0, 0])
      const calls = await session.scan({ type: 'tool/call', limit: 10 })
      const ids = calls.map((row) => dataOf(row).toolUseId as string)
      const [closing, ...more] = closers(seen)
      expect(more).toEqual([])
      expect(types(closing!.tx)).toEqual(['tool/result', 'tool/result', 'tool/result', 'step/end'])
      expect(closing!.tx.events.slice(0, 3)).toEqual(
        calls.map((row, i) =>
          expect.objectContaining({
            sourceEventSeqs: [row.seq],
            data: expect.objectContaining({
              toolUseId: ids[i],
              content: [{ type: 'text', text: NOT_STARTED(names[i]!) }],
              code: 'TOOL_NOT_STARTED',
            }),
          }),
        ),
      )
      expect(closing!.tx.opState?.data).toMatchObject({
        phase: { batch: { calls: ids.map((toolUseId) => ({ toolUseId, status: 'completed' })) } },
      })
      const messages = f.provider.requests[0]!.messages
      const at = messages.findIndex((m) => m.role === 'assistant')
      expect(messages.slice(at)).toEqual([
        {
          role: 'assistant',
          content: [],
          toolCalls: ids.map((toolUseId, i) => ({ toolUseId, name: names[i], args: {}, ordinal: i })),
        },
        ...ids.map((toolUseId, i) => pairOf(toolUseId, names[i]!)[1]),
      ])
    })

    it.each(['completed', 'error'] as const)(
      'closes it when the loop finishes the turn as %s without another call',
      async (reason) => {
        const key = `finish-${reason}`
        const storage = await crashAt(key, async (ctx, s) => void (await pass(`${key}:1`)(ctx, s)), planned)
        const f = setup(
          async (ctx) => {
            if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
            return ctx.events.finish(reason)
          },
          { storage },
        )
        f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
        const seen = commits(storage)
        const session = await f.reopen(key)
        await session.resume()
        expect(await run(session)).toMatchObject({ reason })
        const [closing, ...more] = closers(seen)
        expect(more).toEqual([])
        expect(types(closing!.tx).slice(0, 2)).toEqual(['tool/result', 'step/end'])
      },
    )

    it('leaves an unannounced call that never started as it was', async () => {
      const plain = (ctx: LoopContext, s: AbortSignal) =>
        ctx.tools.execute({ name: 'read', args: {}, invocationId: 'plain:2' }, s)
      const storage = await crashAt('plain', async (ctx, s) => void (await plain(ctx, s)), planned)
      const { counter, seen, session } = await reopenWith('plain', storage, async (ctx, s) => {
        await ctx.model.complete(await ctx.prepareRequest(), s)
      })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(counter.n).toBe(0)
      expect(closers(seen)).toEqual([])
      expect(await session.scan({ type: 'tool/result', limit: 10 })).toEqual([])
    })

    /** An approval that waits for `allow`, and a `shell` that counts its runs. */
    function heldApproval() {
      const held = { asked: () => {}, allow: () => {}, ran: 0 }
      const asking = new Promise<void>((resolve) => {
        held.asked = resolve
      })
      const answer = new Promise<void>((resolve) => {
        held.allow = resolve
      })
      const seams = fakeSeams({
        approval: {
          ask: async () => {
            held.asked()
            await answer
            return { verdict: 'allowed-once' as const, answeredBy: actor }
          },
        },
      })
      const shell = shellTool(async () => {
        held.ran++
        return { content: [{ type: 'text', text: 'ran' }] }
      })
      return { held, asking, seams, shell }
    }
    const shell = (id: string) => (ctx: LoopContext, s: AbortSignal) =>
      ctx.tools.execute({ name: 'shell', args: {}, invocationId: id }, s, { announce: true })
    /**
     * Runs `call` and prepares a model request while the call waits for its approval, noting in
     * `written` how many rows that preparation added to the ledger.
     */
    const preparedWhileAsking =
      (
        call: (ctx: LoopContext, s: AbortSignal) => Promise<unknown>,
        h: ReturnType<typeof heldApproval>,
        ledger: () => SessionImpl,
        written: number[],
      ) =>
      async (ctx: LoopContext, s: AbortSignal) => {
        const running = call(ctx, s)
        await h.asking
        const before = ledger().lastSeq
        await ctx.prepareRequest()
        written.push(ledger().lastSeq - before)
        h.held.allow()
        return running
      }

    it('does not answer a call this process is still running, and writes nothing for it', async () => {
      const h = heldApproval()
      let result: unknown
      const written: number[] = []
      const f = setup(
        perTurn(async (ctx, s) => {
          result = await preparedWhileAsking(shell('live:1'), h, () => session, written)(ctx, s)
        }),
        { seams: h.seams },
      )
      f.k.tools.add(h.shell, { source: 'test', trust: 'builtin' })
      const seen = commits(f.storage)
      const session = await f.open('in-flight')
      await enqueue(session)
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] })
      expect(h.held.ran).toBe(1)
      expect(written).toEqual([0])
      expect(closers(seen)).toEqual([])
      expect((await session.scan({ type: 'tool/result', limit: 10 })).map((row) => row.data)).toEqual([
        expect.not.objectContaining({ code: expect.anything() }),
      ])
    })

    it('does not answer a call a tool phase is driving, and runs it once', async () => {
      const storage = await crashAt(
        'driven',
        async (ctx, s) => void (await shell('driven:1')(ctx, s)),
        planned,
        [shellTool()],
      )
      const h = heldApproval()
      const written: number[] = []
      const { seen, session } = await reopenWith(
        'driven',
        storage,
        preparedWhileAsking(
          (ctx, s) => ctx.tools.drain(s),
          h,
          () => session,
          written,
        ),
        [h.shell],
        h.seams,
      )
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(h.held.ran).toBe(1)
      expect(written).toEqual([0])
      expect(closers(seen)).toEqual([])
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => [dataOf(row).code, dataOf(row).isError])).toEqual([[undefined, false]])
    })

    it('never dispatches a call that was closed while its approval was pending', async () => {
      const storage = await crashAt(
        'closed',
        async (ctx, s) => void (await shell('closed:1')(ctx, s)),
        planned,
        [shellTool()],
      )
      const h = heldApproval()
      const written: number[] = []
      let refused: unknown
      const { seen, session } = await reopenWith(
        'closed',
        storage,
        // The tools phase run directly, not through the loop port, so nothing marks the call as
        // driven and the request preparation closes it while its approval is pending.
        preparedWhileAsking(
          async () => {
            refused = await session.runToolsPhase().catch((error: unknown) => error)
          },
          h,
          () => session,
          written,
        ),
        [h.shell],
        h.seams,
      )
      await run(session)
      expect(written).toEqual([1])
      expect(closers(seen)).toHaveLength(1)
      expect(refused).toMatchObject({
        code: 'E_RELATION',
        message: expect.stringContaining('no longer planned'),
      })
      expect(h.held.ran).toBe(0)
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => dataOf(row).code)).toEqual(['TOOL_NOT_STARTED'])
    })

    it.each(['rejected', 'allowed-once'] as const)(
      'gives a stranded call to the closer or to a tools phase, never to both, at every interleaving (%s)',
      async (verdict) => {
        const key = `sweep-${verdict}`
        const base = await crashAt(key, async (ctx, s) => void (await shell('sweep:1')(ctx, s)), planned, [
          shellTool(),
        ])
        const rows = await base.scan(key, { fromSeq: 1, limit: 10000 })
        const opCells = (await base.registers(key)).filter((row) => row.register === 'op.state')
        const winners = new Set<string>()
        const wrong: string[] = []
        // A model request is prepared first and the tools phase starts `delay` microtasks later, so
        // the two meet at every point of the request's commit, including while it is queued.
        for (let delay = 0; delay <= 40; delay++) {
          let asked = 0
          const ran = { n: 0 }
          let drained = 'not run'
          const seams = fakeSeams({
            approval: {
              ask: async () => {
                asked++
                return { verdict, answeredBy: actor }
              },
            },
          })
          const f = setup(
            perTurn(async (ctx, s) => {
              const preparing = ctx.prepareRequest()
              for (let i = 0; i < delay; i++) await Promise.resolve()
              const draining = ctx.tools.drain(s).then(
                () => 'ok',
                (error: { code?: string }) => `threw ${error.code}`,
              )
              await preparing
              drained = await draining
            }),
            { storage: MemoryStorage.fromEvents(key, rows, { opCells }), seams },
          )
          f.k.tools.add(
            shellTool(async () => {
              ran.n++
              return { content: [{ type: 'text', text: 'ran' }] }
            }),
            { source: 'test', trust: 'builtin' },
          )
          const session = await f.reopen(key)
          await session.resume()
          const out = await run(session)
          const codes = (await session.scan({ type: 'tool/result', limit: 10 })).map(
            (row) => dataOf(row).code ?? 'ok',
          )
          // The closer won: nobody is asked and nothing runs. The tools phase won: it asks once and
          // the answer decides. Either way the call holds exactly one result.
          const closed = codes[0] === 'TOOL_NOT_STARTED'
          winners.add(closed ? 'closer' : 'tools phase')
          const allowed = verdict === 'allowed-once'
          const expected = closed
            ? { asked: 0, ran: 0, codes: ['TOOL_NOT_STARTED'] }
            : { asked: 1, ran: allowed ? 1 : 0, codes: [allowed ? 'ok' : 'APPROVAL_REJECTED'] }
          const actual = JSON.stringify({ delay, out: out.reason, drained, asked, ran: ran.n, codes })
          if (actual !== JSON.stringify({ delay, out: 'completed', drained: 'ok', ...expected }))
            wrong.push(actual)
          for (const kernel of kernels.splice(0)) await kernel.close()
        }
        expect(wrong).toEqual([])
        expect(winners).toEqual(new Set(['closer', 'tools phase']))
      },
    )

    it('keeps a call marked while any tools phase still drives it', async () => {
      const storage = await crashAt(
        'twice',
        async (ctx, s) => void (await shell('twice:1')(ctx, s)),
        planned,
        [shellTool()],
      )
      const ran = { n: 0 }
      const seams = fakeSeams({
        approval: { ask: async () => ({ verdict: 'allowed-once' as const, answeredBy: actor }) },
      })
      const release: Array<() => void> = []
      const gates = [0, 1].map(() => new Promise<void>((resolve) => release.push(resolve)))
      let bothStarted!: () => void
      const started = new Promise<void>((resolve) => {
        bothStarted = resolve
      })
      let first: unknown
      const { seen, session } = await reopenWith(
        'twice',
        storage,
        async (ctx, s) => {
          const phase = session.runToolsPhase.bind(session)
          let entered = 0
          // Two tools phases at once; the first stops early, before it drives anything.
          vi.spyOn(session, 'runToolsPhase').mockImplementation(async () => {
            const mine = entered++
            if (entered === 2) bothStarted()
            await gates[mine]
            if (mine === 0) throw new Error('the first tools phase stopped early')
            return phase()
          })
          const firstDrain = ctx.tools.drain(s).catch((error: unknown) => error)
          const secondDrain = ctx.tools.drain(s)
          await started
          release[0]!()
          first = await firstDrain
          // The second phase still drives the call, so this request must leave it alone.
          await ctx.prepareRequest()
          release[1]!()
          await secondDrain
        },
        [
          shellTool(async () => {
            ran.n++
            return { content: [{ type: 'text', text: 'ran' }] }
          }),
        ],
        seams,
      )
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(first).toMatchObject({ message: expect.stringContaining('stopped early') })
      expect(closers(seen)).toEqual([])
      expect(ran.n).toBe(1)
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => [dataOf(row).code, dataOf(row).isError])).toEqual([[undefined, false]])
    })

    it('does not answer a call a replay is still running', async () => {
      const storage = await crashAt(
        'replaying',
        async (ctx, s) => void (await shell('again:1')(ctx, s)),
        planned,
        [shellTool()],
      )
      const h = heldApproval()
      let result: unknown
      const written: number[] = []
      const { seen, session } = await reopenWith(
        'replaying',
        storage,
        async (ctx, s) => {
          result = await preparedWhileAsking(shell('again:1'), h, () => session, written)(ctx, s)
        },
        [h.shell],
        h.seams,
      )
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] })
      expect(h.held.ran).toBe(1)
      expect(written).toEqual([0])
      expect(closers(seen)).toEqual([])
    })

    it('leaves a parked call to its approval continuation in the turn that resumes it', async () => {
      const seams = fakeSeams({
        approval: {
          ask: async () => ({ ticket: 'ticket-2', expiresAt: new Date(Date.now() + 60000).toISOString() }),
        },
      })
      let parked = false
      let result: ToolResult | undefined
      const ran = { n: 0 }
      const f = setup(
        async (ctx, s) => {
          if (parked) {
            if ((await ctx.input.resumeParked()) !== 'opened') return { outcome: 'parked', reason: 'parked' }
            await ctx.prepareRequest()
            result = await ctx.tools.resume('parked:1', s)
            return ctx.events.finish('completed')
          }
          if (!(await ctx.input.accept())) return { outcome: 'idle', phase: 'idle' }
          await shell('parked:1')(ctx, s).catch((error: { code?: string }) => {
            if (error.code !== 'PARKED') throw error
            parked = true
          })
          return { outcome: 'parked', reason: 'parked' }
        },
        { seams },
      )
      f.k.tools.add(
        shellTool(async () => {
          ran.n++
          return { content: [{ type: 'text', text: 'approved' }] }
        }),
        { source: 'test', trust: 'builtin' },
      )
      const seen = commits(f.storage)
      const session = await f.open('parked')
      await enqueue(session)
      expect(await run(session)).toMatchObject({ reason: 'parked' })
      await answerToolDecision(session, 1, 'allowed-once', { ...actor, id: 'approver' })
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(ran.n).toBe(1)
      expect(result).toEqual({ content: [{ type: 'text', text: 'approved' }] })
      expect(closers(seen)).toEqual([])
    })

    it('closes a call whose approval was asked but not answered before the process died', async () => {
      const asked = (tx: CommitTx) => types(tx).includes('decision/state')
      const storage = await crashAt('asked', async (ctx, s) => void (await shell('asked:1')(ctx, s)), asked, [
        shellTool(),
      ])
      const h = heldApproval()
      let turns = 0
      const { seen, session, f } = await reopenWith(
        'asked',
        storage,
        async (ctx, s) => {
          if (turns++ === 0) await ctx.model.complete(await ctx.prepareRequest(), s)
        },
        [h.shell],
        h.seams,
      )
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(h.held.ran).toBe(0)
      expect(closers(seen)).toHaveLength(1)
      const [call] = await session.scan({ type: 'tool/call', limit: 1 })
      const toolUseId = dataOf(call!).toolUseId as string
      const messages = f.provider.requests[0]!.messages
      const at = messages.findIndex((m) => m.role === 'assistant')
      expect(messages.slice(at)).toEqual(pairOf(toolUseId, 'shell'))
      // The question asked before the crash stays open; answering it later runs nothing.
      const gates = (await session.decisions.list()).filter((d) => d.request.owner === 'core/tool-permission')
      expect(gates).toEqual([
        expect.objectContaining({ request: expect.objectContaining({ operationId: toolUseId }) }),
      ])
      expect(gates[0]?.result ?? null).toBeNull()
      await answerToolDecision(session, 1, 'allowed-once', { ...actor, id: 'approver' })
      await enqueue(session, 'next')
      expect(await run(session)).toMatchObject({ reason: 'completed' })
      expect(h.held.ran).toBe(0)
      const results = await session.scan({ type: 'tool/result', limit: 10 })
      expect(results.map((row) => [dataOf(row).toolUseId, dataOf(row).code])).toEqual([
        [toolUseId, 'TOOL_NOT_STARTED'],
      ])
    })
  })
})

describe('without announce', () => {
  /** Stable ids and a fixed clock, so the same work writes the same bytes. */
  const stableIds = (): IdMinter => {
    let n = 0
    const next = () => String(++n).padStart(32, '0')
    return {
      ulid: () => next().slice(-26),
      effectId: () => `e-${next()}`,
      toolUseId: (ordinal) => `t${ordinal}-${next()}`,
      requestId: () => `r-${next()}`,
      nonce: () => next(),
    }
  }
  const withoutDurations = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutDurations)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== 'durationMs')
          .map(([key, inner]) => [key, withoutDurations(inner)]),
      )
    return value
  }
  async function ledger(options: Parameters<LoopContext['tools']['execute']>[2] | 'omitted') {
    const f = setup(
      perTurn(async (ctx, s) => {
        if (options === 'omitted') {
          await ctx.tools.execute({ name: 'read', args: { n: 1 } }, s)
          await ctx.tools.batch(
            [
              { name: 'read', args: { n: 2 } },
              { name: 'read', args: { n: 3 } },
            ],
            s,
          )
          return
        }
        await ctx.tools.execute({ name: 'read', args: { n: 1 } }, s, options)
        await ctx.tools.batch(
          [
            { name: 'read', args: { n: 2 } },
            { name: 'read', args: { n: 3 } },
          ],
          s,
          options,
        )
      }),
      { ids: stableIds(), clock: () => 1_757_203_200_000 },
    )
    f.k.tools.add(readTool(), { source: 'test', trust: 'builtin' })
    const session = await f.open('bytes')
    await enqueue(session)
    expect(await run(session)).toMatchObject({ reason: 'completed' })
    const rows = await session.scan({ fromSeq: 1, limit: 10000 })
    const cells = (await f.storage.registers(session.key)).filter((row) => row.register === 'op.state')
    return withoutDurations({ rows, cells })
  }

  it('writes the same ledger as before the option existed', async () => {
    const omitted = await ledger('omitted')
    // Recorded from the implementation before tools.execute and tools.batch took a third argument.
    expect(sha256Hex(canonicalJson(omitted as never))).toBe(
      'd017318d877e97479929865147de03287c5e4a59ed7e288d03fe58f29ae1ffca',
    )
    expect(await ledger(undefined)).toEqual(omitted)
    expect(await ledger({})).toEqual(omitted)
    // As a script would pass them: an absent or false `announce` is no announce.
    expect(await ledger({ announce: undefined } as never)).toEqual(omitted)
    expect(await ledger({ announce: false } as never)).toEqual(omitted)
  })
})
