import type { LoopContext, LoopFactory } from '@agnes/extension-api'
import { driveLoop } from '@agnes/plugin-runtime/testkit'
import { describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/compile.js'
import { createJevLoopFactory } from '../src/index.js'
import { boundContent } from '../src/scope.js'
import type { JsonObject } from '../src/types.js'
import { digest16 } from '../src/util.js'
import {
  callReply,
  errorReply,
  jevState,
  ok,
  recordWrites,
  run,
  textReply,
  toolPort,
  withPorts,
} from './helpers/drive.js'
import { fakeJev, type JevAct, PICK_LS, PICK_READ, PICK_RESPOND, PICK_WRITE } from './helpers/fake-jev.js'
import { turnView } from './helpers/view.js'

const budgetError = () =>
  Object.assign(new Error('budget'), { code: 'E_BUDGET', detail: { reason: 'max_steps' } })
/** The stop gate keeps the first completion open, as a verifier asking for more work would. */
function holdFirstCompletion(factory: LoopFactory): LoopFactory {
  let held = false
  const wrap = (ctx: LoopContext): LoopContext => {
    const events: LoopContext['events'] = {
      assistant: (message, checkpoint) => ctx.events.assistant(message, checkpoint),
      emit: (name, data) => ctx.events.emit(name, data),
      async finish(reason, error) {
        if (reason !== 'completed' || held) return ctx.events.finish(reason, error)
        held = true
        return { outcome: 'running' }
      },
    }
    return Object.create(ctx, { events: { value: events, enumerable: true } }) as LoopContext
  }
  return {
    ...factory,
    create: (ctx, stop) => factory.create(wrap(ctx), stop),
    resume: (ctx, checkpoint, stop) => factory.resume(wrap(ctx), checkpoint, stop),
  }
}

describe('Jev loop driver', () => {
  it('passes a default ls straight through, then answers with one model request', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }], {
      replies: [textReply('The workspace has notes.txt.')],
    })
    expect(r.tools.executed).toEqual([{ name: 'ls', args: { path: '.' }, options: { announce: true } }])
    expect(r.events.find((e) => e.type === 'assistant/message')?.data).toEqual({
      content: [],
      stopReason: 'tool_use',
    })
    expect(r.requests).toHaveLength(1)
    expect(r.steps.map((s) => s.route)).toEqual(['direct', 'answer'])
    expect(r.steps[1]).toMatchObject({ llm: { kind: 'answer', attempts: 1, outcome: 'text' } })
    expect(r.finished?.[0]).toBe('completed')
    expect(r.jev.invoked).toEqual(['jev:1:0:d0', 'jev:1:1:d0'])
  })
  it('asks for parameters and dispatches the authored call with its content', async () => {
    const r = await run([{ pick: PICK_WRITE }, { pick: PICK_RESPOND }], {
      replies: [callReply('write', { path: 'a.txt', content: 'x' }), textReply('Wrote a.txt.')],
    })
    expect(r.tools.executed[0]).toMatchObject({
      name: 'write',
      args: { path: 'a.txt', content: 'x' },
      options: { announce: { content: [] } },
    })
    expect(r.steps[0]).toMatchObject({
      route: 'parameters',
      llm: { kind: 'parameters', attempts: 1, outcome: 'call' },
    })
  })
  it('arbitrates a contested low-confidence decision', async () => {
    // A target head with two options cannot answer 0.4 as its argmax, so pick read, whose binding is fixed.
    const r = await run([{ pick: PICK_READ, confidence: 0.4, ambiguity: 0.9 }, { pick: PICK_RESPOND }], {
      replies: [callReply('read', { path: 'a' }), textReply('done')],
    })
    expect(r.steps[0]).toMatchObject({ route: 'arbitration', reason: 'low_confidence' })
  })
  it('records a Jev failure, runs nothing, and forces arbitration on the next step', async () => {
    const r = await run(
      [
        { failed: { reason: 'adapter-error', code: 'TRANSPORT', retryable: true } },
        { pick: PICK_LS },
        { pick: PICK_RESPOND },
      ],
      { replies: [textReply('Here is what I know.')] },
    )
    expect(r.steps[0]).toMatchObject({ route: 'decision_failed', reason: 'MODEL_UNAVAILABLE' })
    expect(r.steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
    expect(r.tools.executed).toEqual([])
    expect(r.requests).toHaveLength(1)
  })
  it('treats an invalid answer as INVALID_PROPOSAL with the same follow-up', async () => {
    const r = await run([{ answers: { phase: { choice: 'NOPE' } } }, { pick: PICK_RESPOND }], {
      replies: [textReply('ok')],
    })
    expect(r.steps.map((s) => [s.route, s.reason])).toEqual([
      ['decision_failed', 'INVALID_PROPOSAL'],
      ['arbitration', 'recoverable_observation'],
    ])
    expect(r.finished?.[0]).toBe('completed')
  })
  it('ends the turn at step 3 when the Jev route is not configured', async () => {
    const r = await run([
      { prepareThrows: 'E_MODEL_UNKNOWN' },
      { prepareThrows: 'E_MODEL_UNKNOWN' },
      { prepareThrows: 'E_MODEL_UNKNOWN' },
    ])
    expect(r.finished?.[0]).toBe('error')
    expect(r.finished?.[1]).toMatchObject({
      code: 'NO_PROGRESS_LIMIT',
      message: expect.stringContaining('E_MODEL_UNKNOWN'),
    })
    expect(r.requests).toHaveLength(0)
    expect(r.tools.executed).toHaveLength(0)
  })
  it('ends the turn the same way without a side-call port', async () => {
    const r = await run([], { sideCall: false })
    expect(r.finished?.[1]).toMatchObject({
      code: 'NO_PROGRESS_LIMIT',
      message: expect.stringContaining('NO_SIDE_CALL'),
    })
  })
  it('retries RATE_LIMIT with a new id, never TRANSPORT', async () => {
    const r = await run(
      [
        { failed: { reason: 'adapter-error', code: 'RATE_LIMIT', retryable: true, retryAfterMs: 10 } },
        { pick: PICK_RESPOND },
      ],
      { replies: [textReply('ok')] },
    )
    expect(r.jev.invoked.slice(0, 2)).toEqual(['jev:1:0:d0', 'jev:1:0:d1'])
    const t = await run(
      [{ failed: { reason: 'adapter-error', code: 'TRANSPORT', retryable: true } }, { pick: PICK_RESPOND }],
      { replies: [textReply('ok')] },
    )
    expect(t.jev.invoked.slice(0, 2)).toEqual(['jev:1:0:d0', 'jev:1:1:d0'])
  })
  it('refuses a plain-text parameters reply as NO_CALL and counts it', async () => {
    const r = await run([{ pick: PICK_WRITE }, { pick: PICK_RESPOND }], {
      replies: [textReply('I would write a file.'), textReply('ok')],
    })
    expect(r.steps[0]).toMatchObject({
      route: 'parameters',
      refusal: { code: 'NO_CALL', stage: 'llm', digest: digest16('I would write a file.') },
    })
    expect(JSON.stringify(r.steps)).not.toContain('I would write a file.')
    expect(r.events.find((e) => e.type === 'jev.metrics')?.data).toMatchObject({ noCall: 1 })
    expect(r.events.filter((e) => e.type === 'assistant/message')).toHaveLength(1)
  })
  it('resends a retryable main-model error once within the step', async () => {
    const r = await run([{ pick: PICK_RESPOND }], {
      replies: [errorReply('TRANSPORT', true), textReply('ok')],
    })
    expect(r.requests).toHaveLength(2)
    expect(r.finished?.[0]).toBe('completed')
  })
  it('ends with JEV_LOOP_MODEL_FAILED when model attempts run out', async () => {
    const r = await run([{ pick: PICK_RESPOND }], {
      replies: [errorReply('TRANSPORT', true), errorReply('TRANSPORT', true)],
    })
    expect(r.finished).toEqual(['error', expect.objectContaining({ code: 'JEV_LOOP_MODEL_FAILED' })])
  })
  // Ported from the JevLoop LLM cache contract test.
  it('keeps the tools option identical across six or more requests', async () => {
    const acts: JevAct[] = [...Array.from({ length: 6 }, () => ({ pick: PICK_READ })), { pick: PICK_RESPOND }]
    const replies = [
      ...Array.from({ length: 6 }, (_, i) => callReply('read', { path: `f${i}` })),
      textReply('done'),
    ]
    // Distinct contents, so the stale-observation limit does not end the turn first.
    const r = await run(acts, {
      replies,
      tools: toolPort({ read: (args) => ok(`content of ${String(args.path)}`) }),
    })
    expect(r.requests.length).toBeGreaterThanOrEqual(6)
    const names = r.requests.map((q) => (q as { tools: Array<{ name: string }> }).tools.map((t) => t.name))
    expect(new Set(names.map((n) => n.join(','))).size).toBe(1)
    expect([...(names[0] ?? [])].sort()).toEqual([
      'edit',
      'find',
      'grep',
      'ls',
      'read',
      'shell',
      'tool_describe',
      'tool_search',
      'write',
    ])
  })
  it('finishes with max_steps at the step cap', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_LS }, { pick: PICK_LS }], { config: { stepCap: 2 } })
    expect(r.finished?.[0]).toBe('max_steps')
  })
  it('puts a steer into the notes Jev sees', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }], {
      replies: [textReply('ok')],
      inputs: [
        { content: [{ type: 'text', text: 'goal' }] },
        { content: [{ type: 'text', text: 'also check docs' }], target: 'next-step' },
      ],
    })
    const state = jevState(r.jev, 0)
    expect(state.current_turn_notes).toEqual([{ kind: 'steer', text: 'also check docs' }])
  })
  it('finishes aborted when the view says the turn was cancelled', async () => {
    expect((await run([], { view: { cancelled: true } })).finished?.[0]).toBe('aborted')
  })
  it('parks on PARKED, keeping the calls in the checkpoint', async () => {
    const r = await run([{ pick: PICK_WRITE }], {
      replies: [callReply('write', { path: 'a', content: 'x' })],
      tools: toolPort({
        write: () => {
          throw Object.assign(new Error('approval'), { code: 'PARKED' })
        },
      }),
    })
    expect(r.steps.length).toBe(0)
    const saved = r.checkpoint?.state as { stage: string; cur: { calls?: unknown[] } } | undefined
    expect(saved?.stage).toBe('parked')
    expect(saved?.cur.calls).toHaveLength(1)
  })
  it('returns turn-ended without finishing again on E_BUDGET', async () => {
    const r = await run([{ pick: PICK_LS }], {
      tools: toolPort({
        ls: () => {
          throw Object.assign(new Error('budget'), { code: 'E_BUDGET', detail: { reason: 'max_steps' } })
        },
      }),
    })
    expect(r.finished).toBeUndefined()
  })
  it('ends with JEV_LOOP_FAILED on an unexpected error', async () => {
    const r = await run([{ pick: PICK_LS }], {
      tools: toolPort({
        ls: () => {
          throw new Error('boom')
        },
      }),
    })
    expect(r.finished).toEqual(['error', expect.objectContaining({ code: 'JEV_LOOP_FAILED' })])
  })
  it('records a Core refusal of announced arguments and arbitrates next', async () => {
    const r = await run([{ pick: PICK_WRITE }, { pick: PICK_RESPOND }], {
      replies: [callReply('write', { path: 1 }), textReply('ok')],
      tools: toolPort({
        write: () => {
          throw Object.assign(new Error('/path must be string'), { code: 'TOOL_ARGS_INVALID' })
        },
      }),
    })
    expect(r.steps[0]).toMatchObject({ refusal: { code: 'REFUSED_BY_CORE', stage: 'dispatch' } })
    expect(r.steps[1]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
  })
  it('carries the previous answer and prior steps into the next turn', async () => {
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }, { pick: PICK_RESPOND }], {
      replies: [textReply('First answer.'), textReply('Second answer.')],
      until: 'idle',
      inputs: [{ content: [{ type: 'text', text: 'one' }] }, { content: [{ type: 'text', text: 'two' }] }],
    })
    const state = jevState(r.jev, 2)
    expect(state.previous_answer).toBe('First answer.')
    expect((state.recent_steps as JsonObject[])[0]).toMatchObject({ operation: 'ls' })
  })
  it('adopts a tool call on the answer route as a declined answer', async () => {
    const r = await run([{ pick: PICK_RESPOND }, { pick: PICK_RESPOND }], {
      replies: [callReply('shell', { command: 'pytest' }), textReply('Tests pass.')],
    })
    expect(r.tools.executed[0]?.name).toBe('shell')
    expect(r.events.find((e) => e.type === 'jev.metrics')?.data).toMatchObject({ answerDeclined: 1 })
  })
  it('keeps state and checkpoint bounded after a 200 KB read', async () => {
    const r = await run([{ pick: PICK_READ }, { pick: PICK_RESPOND }], {
      replies: [callReply('read', { path: 'big.txt' }), textReply('ok')],
      tools: toolPort({ read: () => ok('x'.repeat(200_000)) }),
    })
    const state = jevState(r.jev, 1)
    expect(estimateTokens(state)).toBeLessThan(24_000)
    const [note] = state.current_turn_notes as JsonObject[]
    expect(note?.text).toEqual(expect.stringMatching(/^\[file: big\.txt\]/))
    expect(String(note?.text).length).toBeLessThanOrEqual(600)
    expect(Buffer.byteLength(JSON.stringify(r.checkpoint?.state))).toBeLessThanOrEqual(32_768)
  })
  it('asks Jev with a shrunk goal for a 30,000-character Chinese goal', async () => {
    const r = await run([{ pick: PICK_RESPOND }], { goal: '请'.repeat(30_000), replies: [textReply('好的')] })
    expect(r.steps.filter((s) => s.route === 'decision_failed')).toEqual([])
    const goal = jevState(r.jev, 0).goal as string
    expect(goal.length).toBeLessThanOrEqual(4003)
    expect(r.finished?.[0]).toBe('completed')
  })
  it('records a held completion and arbitrates the step Core asked for', async () => {
    const r = await run([{ pick: PICK_RESPOND }, { pick: PICK_RESPOND }], {
      replies: [textReply('Done already.'), textReply('Ran the tests; they pass.')],
      wrap: holdFirstCompletion,
      view: {
        history: [
          {
            seq: 1,
            kind: 'assistant',
            trust: 'trusted',
            data: { content: [{ type: 'text', text: 'Verifier: run the tests first.' }] },
          },
        ],
      },
    })
    expect(r.steps.map((s) => [s.route, s.reason])).toEqual([
      ['answer', null],
      ['answer', 'stop_gate_held'],
      ['arbitration', 'recoverable_observation'],
    ])
    expect(r.steps[1]).toMatchObject({
      refusal: {
        code: 'STOP_GATE_HELD',
        stage: 'finish',
        digest: digest16('Verifier: run the tests first.'),
      },
    })
    // The event holds a digest only; the text stays in the loop's own record for the next request.
    expect(r.steps[1]?.refusal).not.toHaveProperty('message')
    expect(jevState(r.jev, 1).last_result).toMatchObject({
      error: { code: 'STOP_GATE_HELD', message: 'Verifier: run the tests first.' },
    })
    expect(jevState(r.jev, 1).last_result).toMatchObject({ operation: 'ANSWER', status: 'held' })
    expect(r.finished?.[0]).toBe('completed')
    expect(r.requests).toHaveLength(2)
  })
  it('bounds the content announced with a call to 8 KiB', async () => {
    const preamble = { type: 'text_delta', delta: '写'.repeat(10_000) }
    const reply = [preamble, ...(callReply('write', { path: 'a.txt', content: 'x' }) as unknown[])]
    const r = await run([{ pick: PICK_WRITE }, { pick: PICK_RESPOND }], { replies: [reply, textReply('ok')] })
    const options = r.tools.executed[0]?.options as { announce: { content: Array<{ text: string }> } }
    const bytes = options.announce.content.reduce((n, block) => n + Buffer.byteLength(block.text), 0)
    expect(bytes).toBeGreaterThan(8000)
    expect(bytes).toBeLessThanOrEqual(8192)
  })
  it('reports every model attempt in a step event, failed ones included', async () => {
    const attempts = (steps: JsonObject[]) =>
      steps.reduce((n, step) => n + Number((step.llm as JsonObject | undefined)?.attempts ?? 0), 0)
    const failed = await run([{ pick: PICK_RESPOND }], {
      replies: [errorReply('TRANSPORT', true), errorReply('TRANSPORT', true)],
    })
    expect(failed.steps).toMatchObject([{ route: 'answer', llm: { attempts: 2, outcome: 'error' } }])
    expect(attempts(failed.steps)).toBe(failed.requests.length)
    const mixed = await run([{ pick: PICK_WRITE }, { pick: PICK_RESPOND }], {
      replies: [
        errorReply('TRANSPORT', true),
        callReply('write', { path: 'a', content: 'x' }),
        textReply('ok'),
      ],
    })
    expect(attempts(mixed.steps)).toBe(mixed.requests.length)
    expect(mixed.events.find((e) => e.type === 'jev.metrics')?.data).toMatchObject({
      llm: { parameters: 2, answer: 1, retries: 1 },
      jevCalls: 2,
      jevRetries: 0,
    })
  })
  it('leaves no call to replay when Core ends the turn at dispatch, and starts the next turn cleanly', async () => {
    const budget = () => {
      throw Object.assign(new Error('budget'), { code: 'E_BUDGET', detail: { reason: 'max_steps' } })
    }
    const first = await run([{ pick: PICK_LS }], { tools: toolPort({ ls: budget }) })
    expect(first.finished).toBeUndefined()
    const saved = first.checkpoint?.state as { stage: string; cur: { calls?: unknown[] } }
    expect(saved.stage).toBe('done')
    expect(saved.cur.calls).toBeUndefined()
    const jev = fakeJev(() => ({ pick: PICK_RESPOND }))
    const next = await driveLoop(createJevLoopFactory(), {
      ...(first.checkpoint ? { checkpoint: first.checkpoint } : {}),
      inputs: [{ turnId: 2, content: [{ type: 'text', text: 'two' }] }] as never,
      turnView: turnView({ turnId: 2 }),
      replies: [textReply('Second answer.')] as never,
      tools: toolPort().port,
      sideCall: jev,
    })
    expect(next.finished?.[0]).toBe('completed')
    expect(jev.invoked).toEqual(['jev:2:0:d0'])
  })
  it('drops the pending calls from the checkpoint when a dispatch is over budget', async () => {
    const r = await run([{ pick: PICK_WRITE }], {
      replies: [callReply('write', { path: 'a', content: 'x' })],
      tools: toolPort({
        write: () => {
          throw Object.assign(new Error('over budget'), { code: 'BUDGET_EXCEEDED' })
        },
      }),
    })
    expect(r.finished).toEqual(['budget', { code: 'BUDGET_EXCEEDED', message: 'over budget' }])
    const saved = r.checkpoint?.state as { cur: { calls?: unknown[] } } | undefined
    expect(saved?.cur).toBeDefined()
    expect(saved?.cur.calls).toBeUndefined()
  })
  it('reports the attempts of a request whose compaction ended the turn', async () => {
    const compactionEnds = (factory: LoopFactory): LoopFactory => {
      const wrap = (ctx: LoopContext): LoopContext =>
        Object.create(ctx, {
          compaction: { value: { run: async () => ({ outcome: 'turn-ended', reason: 'budget' }) } },
        }) as LoopContext
      return {
        ...factory,
        create: (ctx, stop) => factory.create(wrap(ctx), stop),
        resume: (ctx, checkpoint, stop) => factory.resume(wrap(ctx), checkpoint, stop),
      }
    }
    const r = await run([{ pick: PICK_RESPOND }], {
      replies: [errorReply('OVERFLOW', false)],
      wrap: compactionEnds,
    })
    expect(r.requests).toHaveLength(1)
    expect(r.steps).toMatchObject([{ route: 'answer', llm: { attempts: 1, outcome: 'error' } }])
  })
  it('keeps the blocks after an empty one in announced content', () => {
    expect(
      boundContent([
        { type: 'thinking', text: '' },
        { type: 'text', text: 'Writing the file.' },
      ]),
    ).toEqual([{ type: 'text', text: 'Writing the file.' }])
  })
  it('commits the answer before it reports the answer step', async () => {
    const r = await run([{ pick: PICK_RESPOND }], { replies: [textReply('ok')] })
    const answer = r.events.findIndex(
      (e) => e.type === 'assistant/message' && (e.data as JsonObject).stopReason === 'end_turn',
    )
    const step = r.events.findIndex((e) => e.type === 'jev.step')
    expect(answer).toBeGreaterThanOrEqual(0)
    expect(step).toBeGreaterThan(answer)
  })
  it('reports the attempts sent before a model request throws', async () => {
    const written: JsonObject[] = []
    const r = await run([{ pick: PICK_RESPOND }], {
      replies: [errorReply('TRANSPORT', true)],
      wrap: (factory) =>
        withPorts(factory, (ctx) => ({
          ...recordWrites(written)(ctx),
          // Core refuses admission while the loop backs off before its retry.
          wait: {
            ...ctx.wait,
            delay: async () => {
              throw budgetError()
            },
          },
        })),
    })
    expect(r.finished).toBeUndefined()
    expect(r.requests).toHaveLength(1)
    expect(r.steps).toMatchObject([
      { route: 'answer', llm: { attempts: 1, invocationIds: ['jev:1:0:m0'], outcome: 'error' } },
    ])
    expect(r.metrics).toEqual([
      expect.objectContaining({ endReason: 'max_steps', llm: expect.objectContaining({ answer: 1 }) }),
    ])
    expect(written.at(-1)).toMatchObject({ stage: 'done' })
  })
  it('reports the model attempts of a step whose dispatch throws', async () => {
    const r = await run([{ pick: PICK_WRITE }], {
      replies: [callReply('write', { path: 'a', content: 'x' })],
      tools: toolPort({
        write: () => {
          throw budgetError()
        },
      }),
    })
    expect(r.steps).toMatchObject([{ route: 'parameters', llm: { attempts: 1, outcome: 'call' } }])
  })
  it('reports the counters and saves the ending when Core ends the turn at dispatch', async () => {
    const written: JsonObject[] = []
    const r = await run([{ pick: PICK_LS }], {
      tools: toolPort({
        ls: () => {
          throw budgetError()
        },
      }),
      wrap: (factory) => withPorts(factory, recordWrites(written)),
    })
    expect(r.finished).toBeUndefined()
    expect(r.metrics).toEqual([expect.objectContaining({ endReason: 'max_steps', directSteps: 1 })])
    expect(written.at(-1)).toMatchObject({ stage: 'done' })
    expect(written.at(-1)?.cur).not.toHaveProperty('calls')
  })
  it('ends the turn on budget when the side call is refused for budget', async () => {
    const r = await run([{ refused: 'budget' }])
    expect(r.finished).toEqual([
      'budget',
      { code: 'BUDGET_EXCEEDED', message: 'the Jev call was refused: budget' },
    ])
    expect(r.jev.invoked).toEqual(['jev:1:0:d0'])
    expect(r.requests).toHaveLength(0)
    expect(r.metrics).toEqual([expect.objectContaining({ endReason: 'budget', jevCalls: 0 })])
  })
  describe('cancellation while a request is running', () => {
    /** Runs one turn whose `cancel` port aborts the session signal mid-request; driveLoop then throws. */
    async function cancelledRun(
      acts: JevAct[],
      o: {
        tools?: ReturnType<typeof toolPort>
        ports?: (ctx: LoopContext, stop: AbortController) => Record<string, unknown>
      },
    ) {
      const stop = new AbortController()
      const finished: unknown[] = []
      const emitted: Array<{ type: string; data: JsonObject }> = []
      const events = (ctx: LoopContext): LoopContext['events'] => ({
        assistant: (message, checkpoint) => ctx.events.assistant(message, checkpoint),
        emit: async (name, data) => {
          emitted.push({ type: name, data: structuredClone(data) as JsonObject })
          await ctx.events.emit(name, data)
        },
        finish: async (reason, error) => {
          finished.push(reason)
          return ctx.events.finish(reason, error)
        },
      })
      const jev = fakeJev((n) => acts[n] ?? { pick: PICK_RESPOND })
      const factory = withPorts(createJevLoopFactory(), (ctx) => ({
        events: events(ctx),
        ...(o.ports?.(ctx, stop) ?? {}),
      }))
      await expect(
        driveLoop(factory, {
          inputs: [{ content: [{ type: 'text', text: 'list the workspace' }] }] as never,
          turnView: turnView(),
          replies: [textReply('never sent')] as never,
          tools: (o.tools ?? toolPort()).port,
          sideCall: jev,
          signal: stop.signal,
        }),
      ).rejects.toThrow()
      const of = (type: string) => emitted.filter((e) => e.type === type).map((e) => e.data)
      return { finished, steps: of('jev.step'), metrics: of('jev.metrics') }
    }
    it('ends aborted when the turn is cancelled while a tool runs', async () => {
      let stop: AbortController | undefined
      const r = await cancelledRun([{ pick: PICK_LS }], {
        tools: toolPort({
          ls: () => {
            stop?.abort()
            throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
          },
        }),
        ports: (_ctx, controller) => {
          stop = controller
          return {}
        },
      })
      expect(r.finished).toEqual(['aborted'])
      expect(r.steps).toMatchObject([{ route: 'direct', op: 'ls' }])
      expect(r.metrics).toEqual([expect.objectContaining({ endReason: 'aborted', directSteps: 1 })])
    })
    it('ends aborted and reports the attempt when the turn is cancelled while the model answers', async () => {
      const r = await cancelledRun([{ pick: PICK_RESPOND }], {
        ports: (ctx, stop) => ({
          model: {
            ...ctx.model,
            // Core settles a cancelled request with an aborted error event.
            complete: async () => {
              stop.abort()
              return [
                { type: 'error', reason: 'aborted', code: 'ABORTED', message: 'aborted', retryable: false },
              ]
            },
          },
        }),
      })
      expect(r.finished).toEqual(['aborted'])
      expect(r.steps).toMatchObject([{ route: 'answer', llm: { attempts: 1, outcome: 'error' } }])
      expect(r.metrics).toEqual([
        expect.objectContaining({ endReason: 'aborted', llm: expect.objectContaining({ answer: 1 }) }),
      ])
    })
  })
  it('reports the step before it ends the turn on a second internal relation error', async () => {
    const relation = () => {
      throw Object.assign(new Error('unsettled'), { code: 'E_RELATION' })
    }
    // The first refusal is recoverable, so the second step is an arbitration whose call hits the same error.
    const r = await run([{ pick: PICK_LS }, { pick: PICK_LS }], {
      tools: toolPort({ ls: relation }),
      replies: [callReply('ls', { path: '.' })],
    })
    expect(r.steps.map((s) => (s.refusal as JsonObject | undefined)?.code)).toEqual([
      'INTERNAL_RELATION',
      'INTERNAL_RELATION',
    ])
    expect(r.steps[1]).toMatchObject({
      route: 'arbitration',
      llm: { attempts: 1 },
      refusal: { recoverability: 'terminal' },
    })
    expect(r.finished?.[1]).toMatchObject({ code: 'JEV_LOOP_FAILED' })
  })
})
