import type { LoopCheckpoint, LoopContext, LoopToolCall, LoopRequest } from '@agnes/extension-api'
import { expect, it } from 'vitest'
import { codec, createDagLoop } from './index.mjs'

const nodes = [
  { id: 'a', tool: 'read', args: { path: 'a' }, after: [] },
  { id: 'b', tool: 'read', args: { path: 'b' }, after: [] },
  { id: 'join', tool: 'join', args: { a: { $result: 'a' }, b: { $result: 'b' } }, after: ['a', 'b'] },
]
function ports() {
  let checkpoint: LoopCheckpoint | null = null
  const batches: LoopToolCall[][] = []
  const events: Array<{ type: string; data: unknown }> = []
  const requests: unknown[] = []
  let finished = false
  const ctx: LoopContext = {
    sessionKey: 'dag',
    lane: 'main',
    prepareRequest: async (options = {}) => ({ ...options } as LoopRequest),
    turn: { view: async () => null, continuation: () => null, cancelled: () => false, checkpoint: async () => ({ outcome: 'running' }), finishCancelled: async () => ({ outcome: 'turn-ended', reason: 'aborted' }), finishFailure: async () => ({ outcome: 'turn-ended', reason: 'error' }) },
    effects: { status: async (id) => ({ status: 'may-have-sent', invocationId: id, checkpoint }) },
    input: {
      accept: async () => ctx.input.claim('next-turn'),
      claim: async () => (finished ? null : { id: '1', turnId: 1, actor: { id: 'test', org: 'test', role: 'owner', deptPath: [], attrs: {} }, trust: 'trusted', kind: 'prompt', content: [{ type: 'text', text: 'do the DAG' }] }),
      resumeParked: async () => false,
      pending: () => !finished,
    },
    tools: {
      drain: async () => ({ outcome: 'running' }),
      execute: async () => {
        throw new Error('DAG must use the batch port')
      },
      batch: async (calls) => {
        batches.push([...calls])
        return calls.map((call) => ({ content: [{ type: 'text', text: JSON.stringify(call.args) }] }))
      },
    },
    model: {
      respond: async () => ({ outcome: 'running' }),
      // biome-ignore lint/correctness/useYield: assert that this fixture never starts model streaming.
      stream: async function* () {
        throw new Error('use complete')
      },
      complete: async (request) => {
        requests.push(request)
        return [
          { type: 'text_delta', delta: requests.length === 1 ? JSON.stringify(nodes) : 'joined summary' },
        ]
      },
    },
    checkpoints: {
      read: () => checkpoint,
      write: async (next) => {
        checkpoint = structuredClone(next)
      },
    },
    events: {
      emit: async (type, data) => {
        events.push({ type, data })
      },
      finish: async () => {
        finished = true
      },
    },
    wait: { park: async () => {}, wake() {}, poll: async () => ({ outcome: 'running' }), delay: async () => {} },
  }
  return { ctx, batches, events, requests, checkpoint: () => checkpoint! }
}
const signal = new AbortController().signal

it('batches independent nodes, resumes their committed wave, joins outputs and finishes without a model for a static plan', async () => {
  const p = ports()
  const factory = createDagLoop({ plan: nodes })
  let driver = factory.create(p.ctx)
  await driver.step(signal) // accept input
  await driver.step(signal) // parallel wave
  expect(p.batches[0]?.map((call) => call.args)).toEqual([{ path: 'a' }, { path: 'b' }])
  const saved = p.checkpoint()
  await driver.dispose()
  driver = factory.resume(p.ctx, saved)
  for (let i = 0; i < 4; i++) {
    if ((await driver.step(signal)).reason) break
  }
  expect(p.batches).toHaveLength(2)
  expect(p.batches[1]?.[0]).toMatchObject({
    name: 'join',
    args: { a: { isError: false }, b: { isError: false } },
  })
  expect(p.requests).toEqual([])
  expect(p.events.at(-1)?.type).toBe('x/dag/result')
})

it('plans from the first model reply and summarizes only after the join', async () => {
  const p = ports()
  const driver = createDagLoop().create(p.ctx)
  for (let i = 0; i < 10; i++) {
    if ((await driver.step(signal)).reason) break
  }
  expect(p.requests).toHaveLength(2)
  expect(p.batches.map((batch) => batch.map((call) => call.name))).toEqual([['read', 'read'], ['join']])
  expect(p.events).toContainEqual({
    type: 'assistant/message',
    data: { content: [{ type: 'text', text: 'joined summary' }], stopReason: 'end_turn' },
  })
})

it('refuses cycles, unsupported codecs and uncertain effects before resumed work', async () => {
  expect(() => createDagLoop({ plan: [{ ...nodes[0]!, after: ['a'] }] })).toThrow('cycle')
  const factory = createDagLoop({ plan: nodes })
  const p = ports()
  const checkpoint = factory.create(p.ctx).checkpoint()
  expect(() => codec.decode({ ...checkpoint, codecVersion: 2 })).toThrow('version 2')
  const resumed = factory.resume(p.ctx, { ...checkpoint, state: { ...(checkpoint.state as object), stage: 'tools', inFlight: ['a'] } })
  await expect(resumed.step(signal)).rejects.toThrow('outcome is uncertain')
  expect(p.batches).toEqual([])
})
