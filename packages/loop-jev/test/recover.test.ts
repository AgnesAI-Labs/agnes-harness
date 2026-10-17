import type { LoopContext, LoopFactory, LoopRequestOptions } from '@agnes/extension-api'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { describe, expect, it } from 'vitest'
import { createJevLoopFactory } from '../src/index.js'
import { encodeState, initialState } from '../src/state.js'
import type { JevState, JsonObject, PendingCall } from '../src/types.js'
import { emptyWorkspace, newTurn } from '../src/workspace.js'
import { fakeJev, PICK_LS, PICK_RESPOND } from './helpers/fake-jev.js'
import { turnView } from './helpers/view.js'

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const textReply = (text: string) => [
  { type: 'text_delta', delta: text },
  { type: 'done', reason: 'stop' },
]
const decision = {
  phase: 'ACT',
  op: 'write',
  target: 'LLM_PARAMETERS',
  bindingMode: 'llm_parameters',
  args: {},
  confidence: 0.9,
  operationPathConfidence: 0.9,
  targetConfidence: null,
  ambiguity: null,
  progress: null,
  phaseTop: [['ACT', 0.9]],
  actionTop: [['write', 0.9]],
  consumed: [],
}
function saved(over: Partial<JevState>): JevState {
  const s = initialState()
  s.workspace = emptyWorkspace()
  newTurn(s.workspace, 'write a file')
  s.idTurn = 1
  s.coreTurn = 1
  s.step = 0
  s.toolNames = ['edit', 'find', 'grep', 'ls', 'read', 'shell', 'tool_describe', 'tool_search', 'write']
  s.cur = {
    jevAttempts: ['jev:1:0:d0'],
    level: 0,
    decision: decision as never,
    route: { kind: 'parameters', reason: null },
  }
  return Object.assign(s, over)
}
const call: PendingCall = {
  invocationId: 'jev:1:0:t0',
  name: 'write',
  args: { path: 'a.txt', content: 'x' },
  announce: 'content',
  content: [],
}
async function resume(
  state: JevState,
  o: {
    effects?: Record<string, unknown>
    replies?: unknown[][]
    tools?: Record<string, () => unknown>
    resumeParked?: 'opened' | 'waiting' | 'blocked' | false
    jev?: ReturnType<typeof fakeJev>
    turnId?: number
    noView?: boolean
    view?: Parameters<typeof turnView>[0]
    cancelled?: boolean
    resumeTool?: () => unknown
    /** Ports the test kit does not offer, added on top of its context. */
    ports?: (ctx: LoopContext) => Record<string, unknown>
  } = {},
) {
  const executed: string[] = []
  const resumed: string[] = []
  const prepared: LoopRequestOptions[] = []
  const resumeTool = o.resumeTool
  const jev = o.jev ?? fakeJev(() => ({ pick: PICK_RESPOND }))
  const result = await driveLoop(spied(createJevLoopFactory(), prepared, o.ports), {
    checkpoint: encodeState(state),
    turnOpen: true,
    sideCall: jev,
    ...(o.noView
      ? {}
      : { turnView: turnView({ turnId: o.turnId ?? 1, cancelled: o.cancelled ?? false, ...o.view }) }),
    effects: (o.effects ?? {}) as never,
    replies: (o.replies ?? [textReply('Done.')]) as never,
    ...(o.resumeParked !== undefined ? { resumeParked: o.resumeParked } : {}),
    tools: {
      execute: async (c: { name: string }) => {
        executed.push(c.name)
        return (o.tools?.[c.name] ?? (() => ok('ok')))()
      },
      batch: async () => [],
      ...(resumeTool
        ? {
            resume: async (id: string) => {
              resumed.push(id)
              return resumeTool()
            },
          }
        : {}),
    } as never,
  })
  return {
    ...result,
    outcomes: result.steps,
    executed,
    resumed,
    prepared,
    jev,
    metrics: result.events.filter((e) => e.type === 'jev.metrics').map((e) => e.data as JsonObject),
    steps: result.events.filter((e) => e.type === 'jev.step').map((e) => e.data as JsonObject),
  }
}
/** The factory with its model request options recorded and `ports` laid over the context. */
function spied(
  factory: LoopFactory,
  prepared: LoopRequestOptions[],
  ports?: (ctx: LoopContext) => Record<string, unknown>,
): LoopFactory {
  const wrap = (ctx: LoopContext): LoopContext => {
    const extra = Object.entries(ports?.(ctx) ?? {}).map(([key, value]) => [key, { value, enumerable: true }])
    return Object.create(ctx, {
      prepareRequest: {
        value: (options: LoopRequestOptions = {}) => {
          prepared.push(structuredClone(options))
          return ctx.prepareRequest(options)
        },
        enumerable: true,
      },
      ...Object.fromEntries(extra),
    }) as LoopContext
  }
  return {
    ...factory,
    create: (ctx, stop) => factory.create(wrap(ctx), stop),
    resume: (ctx, checkpoint, stop) => factory.resume(wrap(ctx), checkpoint, stop),
  }
}
const mayHaveSent = (id: string) => ({
  [id]: { status: 'may-have-sent', invocationId: id, checkpoint: null },
})
const modelError = (code: string, retryable: boolean, retryAfterMs?: number) => [
  {
    type: 'error',
    reason: 'error',
    code,
    message: code,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  },
]
const answerStep = (llm: JevState['cur']['llm']) =>
  saved({
    stage: 'llm',
    cur: {
      ...saved({}).cur,
      route: { kind: 'answer', reason: null },
      decision: { ...decision, phase: 'RESPOND', op: 'ANSWER' } as never,
      ...(llm ? { llm } : {}),
    },
  })
const responded = (id: string, result: unknown) => ({
  [id]: { status: 'responded', invocationId: id, checkpoint: null, result },
})

describe('recovery after resume', () => {
  it('llm responded: uses the recorded reply without a new request', async () => {
    const r = await resume(
      saved({
        stage: 'llm',
        cur: {
          ...saved({}).cur,
          route: { kind: 'answer', reason: null },
          decision: { ...decision, phase: 'RESPOND', op: 'ANSWER' } as never,
          llm: { kind: 'answer', attempt: 0 },
        },
      }),
      { effects: responded('jev:1:0:m0', textReply('Recorded answer.')) },
    )
    expect(r.requests).toHaveLength(0)
    expect(r.events.find((e) => e.type === 'assistant/message')?.data).toMatchObject({
      content: [{ type: 'text', text: 'Recorded answer.' }],
    })
    expect(r.finished?.[0]).toBe('completed')
  })
  it('llm not-sent: sends the same attempt again', async () => {
    const r = await resume(
      saved({
        stage: 'llm',
        cur: {
          ...saved({}).cur,
          route: { kind: 'answer', reason: null },
          decision: { ...decision, phase: 'RESPOND', op: 'ANSWER' } as never,
          llm: { kind: 'answer', attempt: 0, note: '[answer request] x' },
        },
      }),
    )
    expect(r.requests).toHaveLength(1)
    expect(r.prepared).toHaveLength(1)
    expect(r.prepared[0]).toMatchObject({
      invocationId: 'jev:1:0:m0',
      tailNote: { text: '[answer request] x', commit: true },
    })
  })
  it('llm may-have-sent: records LLM_OUTCOME_UNKNOWN and arbitrates next', async () => {
    const r = await resume(
      saved({ stage: 'llm', cur: { ...saved({}).cur, llm: { kind: 'parameters', attempt: 0 } } }),
      {
        effects: { 'jev:1:0:m0': { status: 'may-have-sent', invocationId: 'jev:1:0:m0', checkpoint: null } },
        jev: fakeJev(() => ({ pick: PICK_RESPOND })),
      },
    )
    expect(r.steps[0]).toMatchObject({ refusal: { code: 'LLM_OUTCOME_UNKNOWN' } })
    expect(r.steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
    expect(r.prepared.map((options) => options.invocationId)).not.toContain('jev:1:0:m0')
    expect(r.prepared.map((options) => options.invocationId)).toEqual(['jev:1:1:m0'])
  })
  it('llm restart twice in one step: counts the attempts sent before the restarts once', async () => {
    const step = answerStep({ kind: 'answer', attempt: 1 })
    step.counters.llm.answer = 0
    // The first restart resends m1, then the model port fails before anything is recorded.
    const first = await resume(step, { replies: [] })
    const after = first.checkpoint?.state as unknown as JevState
    expect(after.cur.llm).toMatchObject({ attempt: 1, counted: 1 })
    expect(after.counters.llm).toMatchObject({ answer: 1, retries: 0 })
    // A second restart finds m1 possibly sent: m0 is not counted again.
    const second = await resume({ ...after, stage: 'llm' }, { effects: mayHaveSent('jev:1:0:m1') })
    // m1 is counted once; the next step's request is an arbitration.
    expect((second.checkpoint as unknown as { state: JevState }).state.counters.llm).toMatchObject({
      answer: 2,
      retries: 1,
      arbitration: 1,
    })
  })
  it('llm responded with an overflow: compacts and retries like a live request', async () => {
    const runs: string[] = []
    const r = await resume(answerStep({ kind: 'answer', attempt: 0 }), {
      effects: responded('jev:1:0:m0', modelError('OVERFLOW', false)),
      ports: () => ({
        compaction: {
          run: async () => {
            runs.push('compact')
            return { outcome: 'running' }
          },
        },
      }),
    })
    expect(runs).toEqual(['compact'])
    expect(r.prepared).toHaveLength(1)
    expect(r.prepared[0]?.invocationId).toBe('jev:1:0:m1')
    expect(r.prepared[0]?.tailNote).toBeUndefined()
    expect(r.finished?.[0]).toBe('completed')
  })
  it('llm responded with an overflow and no compaction: ends like a live request', async () => {
    const r = await resume(answerStep({ kind: 'answer', attempt: 0 }), {
      effects: responded('jev:1:0:m0', modelError('OVERFLOW', false)),
    })
    expect(r.prepared).toHaveLength(0)
    expect(r.finished).toEqual(['error', expect.objectContaining({ code: 'JEV_LOOP_MODEL_FAILED' })])
  })
  it('llm responded with a retryable error: backs off, then retries under the next id', async () => {
    const waits: number[] = []
    const r = await resume(answerStep({ kind: 'answer', attempt: 0 }), {
      effects: responded('jev:1:0:m0', modelError('RATE_LIMIT', true, 1234)),
      ports: (ctx) => ({
        wait: {
          ...ctx.wait,
          delay: async (ms: number) => {
            waits.push(ms)
          },
        },
      }),
    })
    expect(waits).toEqual([1234])
    expect(r.prepared.map((options) => options.invocationId)).toEqual(['jev:1:0:m1'])
    expect(r.finished?.[0]).toBe('completed')
  })
  it('llm not-sent in a turn cancelled while down: ends aborted without a request', async () => {
    const r = await resume(answerStep({ kind: 'answer', attempt: 0, note: 'n' }), { cancelled: true })
    expect(r.prepared).toHaveLength(0)
    expect(r.finished?.[0]).toBe('aborted')
  })
  it('decide absent in a turn cancelled while down: ends aborted without a side call', async () => {
    const jev = fakeJev(() => ({ pick: PICK_RESPOND }))
    const r = await resume(saved({ stage: 'decide' }), { jev, cancelled: true })
    expect(jev.prepared).toHaveLength(0)
    expect(r.finished?.[0]).toBe('aborted')
  })
  it('dispatch responded: records the receipt result without running again', async () => {
    const r = await resume(saved({ stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }), {
      effects: responded('jev:1:0:t0', ok('wrote a.txt')),
    })
    expect(r.executed).toEqual([])
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['ok'] } })
  })
  it('dispatch of a read batch responded: one entry and one view, nothing run again', async () => {
    const reads = ['a.md', 'b.md', 'c.md'].map(
      (path, i): PendingCall => ({
        invocationId: `jev:1:0:t${i}`,
        name: 'read',
        args: { path, offset: 1, limit: 200 },
        announce: 'true',
      }),
    )
    const batchDecision = {
      ...decision,
      phase: 'INSPECT',
      op: 'read',
      target: ['a.md', 'b.md', 'c.md'],
      bindingMode: 'observed',
      args: reads[0]?.args,
      batch: reads.map((c) => c.args),
    }
    const r = await resume(
      saved({
        stage: 'dispatch',
        cur: {
          ...saved({}).cur,
          decision: batchDecision as never,
          route: { kind: 'direct', reason: null },
          calls: reads,
        },
      }),
      {
        effects: Object.assign(
          {},
          ...reads.map((c) => responded(c.invocationId, ok(`text of ${(c.args as { path: string }).path}`))),
        ),
      },
    )
    expect(r.executed).toEqual([])
    expect(r.steps[0]).toMatchObject({ dispatch: { batch: true, results: ['ok', 'ok', 'ok'] } })
    const state = (r.jev.prepared[0] as unknown as { payload: { state: JsonObject } }).payload.state
    expect((state.recent_steps as JsonObject[]).at(-1)).toMatchObject({
      read_files: ['a.md', 'b.md', 'c.md'],
    })
    expect((state.observation_views as JsonObject[]).filter((v) => v.kind === 'read')).toHaveLength(1)
  })
  it('dispatch closed with TOOL_NOT_STARTED: records it as recoverable', async () => {
    const r = await resume(saved({ stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }), {
      effects: responded('jev:1:0:t0', {
        content: [{ type: 'text', text: 'write was announced but did not run' }],
        isError: true,
      }),
    })
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['not_started'] } })
    expect(r.steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
  })
  it('dispatch uncertain: records TOOL_OUTCOME_UNKNOWN', async () => {
    const r = await resume(saved({ stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }), {
      tools: {
        write: () => {
          throw Object.assign(new Error('reconcile'), { code: 'E_RELATION' })
        },
      },
    })
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['unknown'] } })
  })
  it('decide finished: decodes the recorded answer without a new side call', async () => {
    const jev = fakeJev(() => ({ pick: PICK_LS }))
    await jev.invoke(
      await jev.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        payload: {
          state: {},
          questions: {
            phase: { type: 'choice', criteria: { INSPECT: 'i', ACT: 'a', VERIFY: 'v', RESPOND: 'r' } },
            action__inspect: {
              type: 'choice',
              criteria: { ls: '', read: '', grep: '', find: '', shell: '' },
            },
            target__inspect__ls: { type: 'choice', criteria: { LLM_PARAMETERS: {}, DEFAULT_ARGUMENTS: {} } },
          },
        },
        invocationId: 'jev:1:0:d0',
      }),
      new AbortController().signal,
    )
    const r = await resume(saved({ stage: 'decide' }), { jev })
    expect(jev.invoked[0]).toBe('jev:1:0:d0')
    expect(r.executed[0]).toBe('ls')
  })
  it('decide interrupted: records MODEL_UNAVAILABLE and does not resend that id', async () => {
    const jev = fakeJev((n) => (n === 0 ? { unknown: true } : { pick: PICK_RESPOND }))
    await jev.invoke(
      await jev.prepare({
        label: 'jev.decide',
        target: { route: 'jev', model: 'm' },
        invocationId: 'jev:1:0:d0',
      }),
      new AbortController().signal,
    )
    const r = await resume(saved({ stage: 'decide' }), { jev })
    expect(r.steps[0]).toMatchObject({ route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' })
    expect(jev.invoked.filter((id) => id === 'jev:1:0:d0')).toHaveLength(1)
  })
  it('finish in the same turn: finishes without a model request (cold restore)', async () => {
    const r = await resume(saved({ stage: 'finish', endReason: 'completed' }))
    expect(r.requests).toHaveLength(0)
    expect(r.finished?.[0]).toBe('completed')
  })
  it('approval continuation keeps goal, notes and step and runs the call once', async () => {
    const s = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [call] } })
    s.workspace.notes = [{ kind: 'steer', text: 'keep me' }]
    s.step = 4
    const r = await resume(s, {
      noView: false,
      turnId: 2,
      resumeParked: 'opened',
      effects: { 'jev:1:0:t0': { status: 'may-have-sent', invocationId: 'jev:1:0:t0', checkpoint: null } },
      resumeTool: () => ok('wrote a.txt'),
    })
    const state = (r.jev.prepared[0] as unknown as { payload: { state: JsonObject } }).payload.state
    expect(state.goal).toBe('write a file')
    expect(state.current_turn_notes).toEqual([{ kind: 'steer', text: 'keep me' }])
    expect(r.jev.invoked[0]).toBe('jev:1:5:d0')
    expect(r.executed).toEqual([])
    expect(r.resumed).toEqual(['jev:1:0:t0'])
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['ok'] } })
  })
  it('approval continuation: a failed read-only tool without a profile is not applied', async () => {
    const search: PendingCall = {
      invocationId: 'jev:1:0:t0',
      name: 'docs_search',
      args: {},
      announce: 'content',
      content: [],
    }
    const s = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [search] } })
    s.toolNames = [...s.toolNames, 'docs_search'].sort()
    const r = await resume(s, {
      turnId: 2,
      resumeParked: 'opened',
      view: {
        tools: [...s.toolNames],
        platform: { meta: { docs_search: { isReadOnly: true, isOpenWorld: true } } },
      },
      effects: { 'jev:1:0:t0': { status: 'may-have-sent', invocationId: 'jev:1:0:t0', checkpoint: null } },
      resumeTool: () => ({ ...ok('backend down'), isError: true }),
    })
    const state = (r.jev.prepared[0] as unknown as { payload: { state: JsonObject } }).payload.state
    expect((state.last_result as { error: JsonObject }).error).toMatchObject({
      code: 'EXECUTION_FAILED',
      recoverability: 'recoverable',
    })
  })
  it('approval continuation: counts the references taken from text and reports them', async () => {
    const list: PendingCall = {
      invocationId: 'jev:1:0:t0',
      name: 'ls',
      args: { path: '.' },
      announce: 'content',
      content: [],
    }
    const s = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [list] } })
    const r = await resume(s, {
      turnId: 2,
      resumeParked: 'opened',
      effects: { 'jev:1:0:t0': { status: 'may-have-sent', invocationId: 'jev:1:0:t0', checkpoint: null } },
      resumeTool: () => ok('notes.txt'),
    })
    expect(r.steps[0]).toMatchObject({ dispatch: { refs: { source: 'text', count: 1 } } })
    expect(r.metrics.at(-1)).toMatchObject({ textReferences: 1 })
  })
  it('parked: waiting stays parked, blocked ends blocked, nothing parked goes idle', async () => {
    const parked = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [call] } })
    expect((await resume(parked, { noView: true, resumeParked: 'waiting' })).steps).toEqual([])
    const blocked = await resume(parked, { noView: true, resumeParked: 'blocked' })
    expect(blocked.finished).toBeUndefined()
    expect(blocked.outcomes).toEqual([{ outcome: 'turn-ended', reason: 'blocked' }])
    expect(blocked.checkpoint?.state).toMatchObject({ stage: 'done' })
    expect(blocked.metrics).toEqual([expect.objectContaining({ endReason: 'blocked' })])
    const idle = await resume(parked, { noView: true, resumeParked: false })
    expect(idle.outcomes).toEqual([{ outcome: 'idle' }])
    expect(idle.checkpoint?.state).toMatchObject({ stage: 'done' })
    expect(idle.metrics).toEqual([expect.objectContaining({ endReason: 'interrupted' })])
  })
  it('parked: E_LANE_BUSY finishes the turn as parked', async () => {
    const r = await resume(saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [call] } }), {
      turnId: 2,
      resumeParked: 'opened',
      effects: { 'jev:1:0:t0': { status: 'may-have-sent', invocationId: 'jev:1:0:t0', checkpoint: null } },
      resumeTool: () => {
        throw Object.assign(new Error('busy'), { code: 'E_LANE_BUSY' })
      },
    })
    expect(r.finished?.[0]).toBe('parked')
    expect(r.outcomes).toEqual([{ outcome: 'parked', reason: 'parked' }])
    expect(r.checkpoint?.state).toMatchObject({
      stage: 'parked',
      coreTurn: 2,
      cur: { calls: [{ invocationId: 'jev:1:0:t0' }] },
    })
  })
  it('dispatch with its turn closed: saves the park intent before asking for the approval', async () => {
    const written: Array<{ state: JsonObject; ids?: readonly string[] }> = []
    const r = await resume(saved({ stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }), {
      noView: true,
      resumeParked: 'waiting',
      ports: (ctx) => ({
        checkpoints: {
          read: () => ctx.checkpoints.read(),
          write: async (
            checkpoint: Parameters<LoopContext['checkpoints']['write']>[0],
            association?: { invocationIds?: readonly string[] },
          ) => {
            written.push({
              state: structuredClone(checkpoint.state) as JsonObject,
              ...(association?.invocationIds ? { ids: [...association.invocationIds] } : {}),
            })
            await ctx.checkpoints.write(checkpoint, association)
          },
        },
      }),
    })
    expect(r.outcomes).toEqual([{ outcome: 'parked', reason: 'parked' }])
    expect(written[0]).toMatchObject({ state: { stage: 'parked' }, ids: ['jev:1:0:t0'] })
  })
  it('parked after the continuation resumed the call: records the receipt result once', async () => {
    const s = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [call] } })
    const r = await resume(s, {
      turnId: 2,
      effects: responded('jev:1:0:t0', ok('wrote a.txt')),
    })
    expect(r.executed).toEqual([])
    expect(r.resumed).toEqual([])
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['ok'] } })
    const state = (r.jev.prepared[0] as unknown as { payload: { state: JsonObject } }).payload.state
    expect(state.goal).toBe('write a file')
  })
})

describe('recovery under a code or hybrid disclosure', () => {
  const standard = ['ls', 'read', 'grep', 'find', 'write', 'edit', 'shell', 'tool_search', 'tool_describe']
  const hybrid = { tools: [...standard, 'run_code'], platform: { disclosed: [...standard, 'run_code'] } }
  const unsupported = ['error', expect.objectContaining({ code: 'JEV_UNSUPPORTED_DISCLOSURE' })]
  it('a finished refusal ends again with the saved error and no request', async () => {
    const error = { code: 'JEV_UNSUPPORTED_DISCLOSURE', message: 'refused earlier' }
    const r = await resume(saved({ stage: 'finish', endReason: 'error', endError: error }), { view: hybrid })
    expect(r.finished).toEqual(['error', error])
    expect(r.requests).toHaveLength(0)
    expect(r.jev.invoked).toHaveLength(0)
  })
  it.each<[string, Partial<JevState>]>([
    ['an interrupted model call', { stage: 'llm' }],
    ['an interrupted dispatch', { stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }],
    ['a step that only began', { stage: 'decide', cur: { jevAttempts: [], level: 0 } }],
  ])('refuses %s of a session whose disclosure became unsupported', async (_name, over) => {
    const r = await resume(saved(over), { view: hybrid })
    expect(r.finished).toEqual(unsupported)
    expect(r.requests).toHaveLength(0)
    expect(r.jev.invoked).toHaveLength(0)
    expect(r.executed).toHaveLength(0)
  })
  it('recovers an interrupted model call whose turn is already closed without checking the disclosure', async () => {
    const r = await resume(saved({ stage: 'llm' }), { noView: true })
    // The recovery itself runs (and finds nothing recorded); a disclosure check on a null view would throw a TypeError instead.
    expect(r.finished?.[1]).toEqual({
      code: 'JEV_LOOP_FAILED',
      message: 'Error: The interrupted Jev loop model request has no record',
    })
  })
  it.each<[string, Partial<JevState>]>([
    ['an interrupted step', { stage: 'llm' }],
    ['a step that only began', { stage: 'decide', cur: { jevAttempts: [], level: 0 } }],
  ])('refuses %s of a cancelled turn as unsupported, not as aborted', async (_name, over) => {
    const r = await resume(saved(over), { view: hybrid, cancelled: true })
    expect(r.finished).toEqual(unsupported)
  })
  it('keeps recovering under the standard disclosure with run_code in the catalog', async () => {
    const r = await resume(answerStep({ kind: 'answer', attempt: 0 }), {
      view: { tools: hybrid.tools, platform: { disclosed: standard } },
    })
    expect(r.finished?.[0]).toBe('completed')
  })
})
