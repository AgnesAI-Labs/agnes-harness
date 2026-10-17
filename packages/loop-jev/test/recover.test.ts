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
    resumeTool?: () => unknown
  } = {},
) {
  const executed: string[] = []
  const resumeTool = o.resumeTool
  const jev = o.jev ?? fakeJev(() => ({ pick: PICK_RESPOND }))
  const result = await driveLoop(createJevLoopFactory(), {
    checkpoint: encodeState(state),
    turnOpen: true,
    sideCall: jev,
    ...(o.noView ? {} : { turnView: turnView({ turnId: o.turnId ?? 1 }) }),
    effects: (o.effects ?? {}) as never,
    replies: (o.replies ?? [textReply('Done.')]) as never,
    ...(o.resumeParked !== undefined ? { resumeParked: o.resumeParked } : {}),
    tools: {
      execute: async (c: { name: string }) => {
        executed.push(c.name)
        return (o.tools?.[c.name] ?? (() => ok('ok')))()
      },
      batch: async () => [],
      ...(resumeTool ? { resume: async () => resumeTool() } : {}),
    } as never,
  })
  return {
    ...result,
    executed,
    jev,
    steps: result.events.filter((e) => e.type === 'jev.step').map((e) => e.data as JsonObject),
  }
}
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
  })
  it('dispatch responded: records the receipt result without running again', async () => {
    const r = await resume(saved({ stage: 'dispatch', cur: { ...saved({}).cur, calls: [call] } }), {
      effects: responded('jev:1:0:t0', ok('wrote a.txt')),
    })
    expect(r.executed).toEqual([])
    expect(r.steps[0]).toMatchObject({ dispatch: { results: ['ok'] } })
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
    const state = (r.jev.prepared[0] as { payload: { state: JsonObject } }).payload.state
    expect(state.goal).toBe('write a file')
    expect(state.current_turn_notes).toEqual([{ kind: 'steer', text: 'keep me' }])
    expect(r.jev.invoked[0]).toBe('jev:1:5:d0')
    expect(r.executed).toEqual([])
  })
  it('parked: waiting stays parked, blocked ends blocked, nothing parked goes idle', async () => {
    const parked = saved({ stage: 'parked', cur: { ...saved({}).cur, calls: [call] } })
    expect((await resume(parked, { noView: true, resumeParked: 'waiting' })).steps).toEqual([])
    expect((await resume(parked, { noView: true, resumeParked: 'blocked' })).finished).toBeUndefined()
    expect((await resume(parked, { noView: true, resumeParked: false })).checkpoint?.state).toMatchObject({
      stage: 'done',
    })
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
    expect(r.checkpoint?.state).toMatchObject({
      stage: 'parked',
      coreTurn: 2,
      cur: { calls: [{ invocationId: 'jev:1:0:t0' }] },
    })
  })
})
