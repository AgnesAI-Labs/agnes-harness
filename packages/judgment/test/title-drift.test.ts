import type {
  AutoTitleInspection,
  PluginContextFacets,
  PreparedSideCall,
  ProjectionEvent,
  ProjectionReader,
  SessionRef,
  SessionWorkContext,
  SessionWorkObservation,
  SessionWorkRegistration,
  SideCallOptions,
} from '@agnes/extension-api'
import type { JsonValue } from '@agnes/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveTitleConfig } from '../src/config.js'
import type { JudgeOutcome } from '../src/judge.js'
import { createJudgmentRuntime, type JudgmentRuntime } from '../src/runtime.js'
import { createTitleProjection } from '../src/uses/title-context.js'
import { registerTitleDrift } from '../src/uses/title-drift.js'

const enabled = { uses: { title: { enabled: true, refreshAfterPrompts: 2 } } }
const session: SessionRef = { key: 'synthetic', lane: 'main', workspaceRoot: '' }
const outcome = (fits?: number): JudgeOutcome => ({
  status: 'ok',
  answers: fits === undefined ? {} : { fits: { type: 'noul', noul: fits } },
  cached: false,
  backend: 'text',
  model: 'fixture',
  probabilityAvailable: false,
  accounting: { calls: [] },
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture(config: unknown = enabled, backend?: 'native' | 'text' | 'missing') {
  let registration: SessionWorkRegistration | undefined
  const owner = new AbortController(),
    runOwner = new AbortController()
  const p = createTitleProjection()
  let state = p.init(),
    seq = 0
  let inspect: AutoTitleInspection = { eligible: true, title: 'Original topic', revision: 7 }
  const received: { purpose: string; state: unknown; options: unknown }[] = []
  const refreshes: { expectedRevision: number; context: string }[] = []
  let judgeResult = async (): Promise<JudgeOutcome> => outcome(0.1)
  let refreshResult = async () => ({ status: 'applied' as const })
  const preparations: SideCallOptions[] = []
  const plugin = {
    self: {
      signal: owner.signal,
      log: { warn() {} },
      sideModels: {
        list: async () =>
          backend === 'missing'
            ? []
            : [
                {
                  route: 'chosen',
                  model: 'fixture',
                  api: backend === 'native' ? 'typesafe-systemone' : 'openai-completions',
                },
              ],
      },
    },
    projections: { register: () => () => {} },
    sessionWork: {
      register(value: SessionWorkRegistration) {
        registration = value
        return () => {
          registration = undefined
        }
      },
    },
  } as unknown as PluginContextFacets
  const runtime = backend
    ? createJudgmentRuntime(plugin, config)
    : ({
        judge: async (_ctx: unknown, requirements?: unknown) => {
          expect(requirements).toBeUndefined()
          return {
            judge: async (purpose: string, req: { state: unknown }, options: unknown) => {
              received.push({ purpose, state: req.state, options })
              return judgeResult()
            },
          }
        },
      } as unknown as JudgmentRuntime)
  const dispose = registerTitleDrift(plugin, runtime, config)
  const reader: ProjectionReader = {
    async readOwn<T extends JsonValue>() {
      return {
        status: 'available' as const,
        value: state as unknown as T,
        name: 'title.context',
        asOfSeq: seq,
        stateVersion: 1,
      }
    },
  }
  const ctx: SessionWorkContext = {
    session,
    signal: runOwner.signal,
    boundary: { turn: 1, startSeq: 1, endSeq: 10, lastAssistantSeq: 9 },
    sideCall: {
      prepare: async (input) => {
        preparations.push(input)
        return input as unknown as PreparedSideCall
      },
      invoke: async (input) => ({
        status: 'ok',
        invocationId: input.invocationId,
        latencyMs: 1,
        replayed: false,
        usage: {
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          credits: 1,
          creditSource: 'estimated',
        },
        text: 'fits: no',
        json: { fits: { type: 'noul', noul: 0.1 } },
      }),
      status: async (invocationId) => ({ status: 'absent', invocationId }),
    },
    projections: reader,
    title: {
      inspect: async () => inspect,
      refresh: async (input) => {
        refreshes.push(input)
        return refreshResult()
      },
    },
  }
  const prompt = (text = 'Implement parser task', extra: Partial<SessionWorkObservation> = {}) => {
    seq++
    state = p.apply(state, {
      seq,
      id: `e${seq}`,
      ts: '',
      type: 'user/message',
      origin: 'principal',
      trust: 'trusted',
      actor: { id: 'u', role: 'user', org: 'test', deptPath: [], attrs: {} },
      data: { kind: 'prompt', content: [{ type: 'text', text }] },
    } as Parameters<typeof p.apply>[1])
    registration?.observe({
      kind: 'message',
      seq,
      session,
      hasGeneratedTitle: true,
      message: { role: 'user', origin: 'principal', attribution: 'operator', kind: 'prompt', text },
      ...extra,
    })
  }
  return {
    received,
    refreshes,
    preparations,
    runtime,
    prompt,
    append: (event: ProjectionEvent) => {
      state = p.apply(state, event)
    },
    ctx,
    dispose: () => {
      dispose()
      if (backend) runtime.dispose()
    },
    owner,
    runOwner,
    run: (context = ctx) => registration?.run(context) ?? Promise.resolve(),
    observe: (event: SessionWorkObservation) => registration?.observe(event),
    set inspect(value: AutoTitleInspection) {
      inspect = value
    },
    set judgeResult(value: () => Promise<JudgeOutcome>) {
      judgeResult = value
    },
    set refreshResult(value: typeof refreshResult) {
      refreshResult = value
    },
  }
}
afterEach(() => vi.useRealTimers())
it('requires explicit enabled and a positive safe integer cadence', () => {
  expect(resolveTitleConfig({})).toEqual({ enabled: false, refreshAfterPrompts: 0 })
  for (const n of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', NaN, Infinity])
    expect(resolveTitleConfig({ uses: { title: { enabled: true, refreshAfterPrompts: n } } })).toEqual({
      enabled: false,
      refreshAfterPrompts: 0,
    })
  expect(resolveTitleConfig(enabled)).toEqual({ enabled: true, refreshAfterPrompts: 2 })
  expect(resolveTitleConfig({ uses: { title: { refreshAfterPrompts: 2 } } })).toEqual({
    enabled: false,
    refreshAfterPrompts: 2,
  })
})
it('counts only live operator prompts with an existing generated title and consumes admitted batches', async () => {
  const f = fixture()
  for (const text of ['hi', 'thanks', '123', '🙂']) f.prompt(text)
  f.prompt('tool task', { hasGeneratedTitle: false })
  f.prompt('agent task', {
    message: { role: 'user', origin: 'principal', attribution: 'agent', kind: 'prompt', text: 'agent task' },
  })
  f.prompt('runtime task', {
    message: {
      role: 'user',
      origin: 'system',
      attribution: 'system',
      kind: 'runtime_context',
      text: 'runtime task',
    },
  })
  f.prompt()
  await f.run()
  expect(f.received).toHaveLength(0)
  f.prompt()
  await f.run()
  expect(f.received).toHaveLength(1)
  expect(f.received[0]).toMatchObject({ purpose: 'judgment.title' })
  expect(f.refreshes).toHaveLength(1)
  await f.run()
  expect(f.received).toHaveLength(1)
  f.dispose()
})
it('does not consume cadence while title authority or eligibility is missing', async () => {
  const f = fixture()
  f.prompt()
  f.prompt()
  for (const reason of ['no-title', 'explicit-title', 'unavailable'] as const) {
    f.inspect = { eligible: false, reason }
    await f.run()
  }
  await f.run((({ title: _title, ...context }) => context)(f.ctx))
  expect(f.received).toHaveLength(0)
  f.inspect = { eligible: true, title: 'Original topic', revision: 7 }
  await f.run()
  expect(f.refreshes).toHaveLength(1)
  f.dispose()
})
it('keeps singleflight through generation, accumulates new prompts and never drains on finally', async () => {
  const f = fixture(),
    judge = deferred<JudgeOutcome>(),
    generation = deferred<{ status: 'applied' }>()
  f.judgeResult = () => judge.promise
  f.refreshResult = () => generation.promise
  f.prompt()
  f.prompt()
  const active = f.run()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  f.prompt('new subject one')
  f.prompt('new subject two')
  await f.run()
  expect(f.received).toHaveLength(1)
  judge.resolve(outcome(0.1))
  for (let i = 0; i < 12; i++) await Promise.resolve()
  expect(f.refreshes[0]?.context).toContain('new subject two')
  await f.run()
  expect(f.received).toHaveLength(1)
  generation.resolve({ status: 'applied' })
  await active
  expect(f.received).toHaveLength(1)
  await f.run()
  expect(f.received).toHaveLength(2)
  f.dispose()
})
it.each([0, 0.49, 0.5, 0.51, 1, undefined, -0.1, 1.1, NaN])(
  'refreshes only a valid fits below 0.5 including text decisions: %s',
  async (fits) => {
    const f = fixture()
    f.judgeResult = async () => outcome(fits)
    f.prompt()
    f.prompt()
    await f.run()
    expect(f.refreshes).toHaveLength(typeof fits === 'number' && fits >= 0 && fits < 0.5 ? 1 : 0)
    await f.run()
    expect(f.received).toHaveLength(1)
    f.dispose()
  },
)
it('rechecks accepted revision and explicit title ownership after judging', async () => {
  for (const next of [
    { eligible: false, reason: 'explicit-title' },
    { eligible: true, title: 'Other automatic title', revision: 8 },
  ] as const) {
    const f = fixture()
    f.judgeResult = async () => {
      f.inspect = next
      return outcome(0.1)
    }
    f.prompt()
    f.prompt()
    await f.run()
    expect(f.refreshes).toHaveLength(0)
    f.dispose()
  }
})
it('fails open on judge errors and a 15000ms timeout without retry or refresh', async () => {
  vi.useFakeTimers()
  const f = fixture()
  f.prompt()
  f.prompt()
  f.judgeResult = () => new Promise(() => {})
  const active = f.run()
  await vi.advanceTimersByTimeAsync(15000)
  await active
  expect(f.received).toHaveLength(1)
  expect(f.refreshes).toHaveLength(0)
  await f.run()
  expect(f.received).toHaveLength(1)
  f.dispose()
})
it('rejects late model results after lifecycle abort, reset, close or disposal', async () => {
  for (const action of ['abort', 'reset', 'close', 'dispose'] as const) {
    const f = fixture(),
      held = deferred<JudgeOutcome>()
    f.judgeResult = () => held.promise
    f.prompt()
    f.prompt()
    const active = f.run()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    if (action === 'abort') f.runOwner.abort()
    else if (action === 'dispose') f.dispose()
    else f.observe({ kind: action, seq: 99, session, hasGeneratedTitle: true })
    held.resolve(outcome(0.1))
    await active
    expect(f.refreshes).toHaveLength(0)
    f.dispose()
  }
})
it('starts fresh after restart and never reconstructs cadence from its context projection', async () => {
  const f = fixture()
  f.prompt()
  f.dispose()
  const restarted = fixture()
  await restarted.run()
  expect(restarted.received).toHaveLength(0)
  restarted.prompt()
  await restarted.run()
  expect(restarted.received).toHaveLength(0)
  restarted.dispose()
})
it.each(['native', 'text', 'missing'] as const)(
  'uses only the configured real runtime path: %s',
  async (backend) => {
    const f = fixture({ ...enabled, judge: { route: 'chosen', model: 'fixture' } }, backend)
    f.prompt('Investigate password=synthetic_secret parser issue')
    f.prompt('Now design settings layout')
    f.append({
      seq: 3,
      id: 'assistant',
      ts: '',
      type: 'assistant/message',
      origin: 'model',
      trust: 'trusted',
      actor: { id: 'model', role: 'assistant', org: 'test', deptPath: [], attrs: {} },
      data: {
        stopReason: 'end_turn',
        content: [
          { type: 'text', text: 'Public final answer' },
          { type: 'thinking', text: 'PLAIN_GENERATION_THOUGHT', signature: 'OPAQUE_SIGNATURE' },
          { type: 'tool_call', arguments: 'PRIVATE_TOOL_ARGUMENTS' },
          { type: 'redactedThinking', data: 'OPAQUE_REPLAY_STATE' },
        ],
      },
    } as ProjectionEvent)
    await f.run()
    expect(f.preparations).toHaveLength(backend === 'missing' ? 0 : 1)
    expect(f.refreshes).toHaveLength(backend === 'missing' ? 0 : 1)
    if (backend !== 'missing') {
      expect(f.preparations[0]).toMatchObject({
        label: 'judgment.title',
        target: { route: 'chosen', model: 'fixture' },
        output: backend === 'native' ? 'json' : 'text',
      })
      expect(JSON.stringify(f.preparations)).not.toMatch(
        /synthetic_secret|OPAQUE_SIGNATURE|PRIVATE_TOOL_ARGUMENTS|OPAQUE_REPLAY_STATE|PLAIN_GENERATION_THOUGHT/,
      )
      expect(f.refreshes[0]?.context).toContain('PLAIN_GENERATION_THOUGHT')
      expect(f.refreshes[0]?.context).not.toMatch(
        /synthetic_secret|OPAQUE_SIGNATURE|PRIVATE_TOOL_ARGUMENTS|OPAQUE_REPLAY_STATE/,
      )
      expect(f.runtime.stats().requests).toEqual({ stop: 0, findRelevant: 0, judgeBatch: 0, rules: 0 })
    }
    f.dispose()
  },
)
it.each(['throw', 'unknown', 'unavailable'] as const)(
  'consumes an admitted failed or unknown judge batch without immediately retrying: %s',
  async (failure) => {
    const f = fixture()
    f.judgeResult = async () => {
      if (failure === 'throw') throw new Error('synthetic failure')
      return failure === 'unknown'
        ? outcome(undefined)
        : { status: 'failed', reason: 'no-judge', accounting: { calls: [] } }
    }
    f.prompt()
    f.prompt()
    await f.run()
    await f.run()
    expect(f.received).toHaveLength(1)
    expect(f.refreshes).toHaveLength(0)
    f.dispose()
  },
)
it('does not consume a batch suppressed by an unavailable title grant', async () => {
  const f = fixture()
  f.prompt()
  f.prompt()
  await f.run((({ title: _title, ...context }) => context)(f.ctx))
  expect(f.received).toHaveLength(0)
  await f.run()
  expect(f.refreshes).toHaveLength(1)
  f.dispose()
})
