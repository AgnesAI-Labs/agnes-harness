import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { failureSignature } from '../src/guards.js'
import { intentFingerprint } from '../src/profile.js'
import { recordRefusal, type Scope } from '../src/scope.js'
import { initialState } from '../src/state.js'
import { dispatchStep, stepTools } from '../src/step.js'
import type { JsonObject, PendingCall, Route } from '../src/types.js'
import { emptyWorkspace, newTurn } from '../src/workspace.js'
import { callReply, jevState, ok, run, textReply, toolPort, withPorts } from './helpers/drive.js'
import { PICK_LS, PICK_RESPOND } from './helpers/fake-jev.js'
import { turnView } from './helpers/view.js'

// The test kit lists a request's tools in catalog order; the names are compared as a sorted set.
const toolNamesOf = (request: unknown) =>
  (request as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort()
const paths = (...refs: Array<[string, string]>) => ({
  schema: 'agh.path-references/1',
  references: refs.map(([kind, path]) => ({ kind, path })),
  total: refs.length,
  truncated: false,
})
const lsResult = (text: string, structured?: object) => () => ({
  ...ok(text),
  ...(structured ? { structured } : {}),
})
const readPick = (target: string, confidence = 0.9) => ({
  pick: {
    phase: 'INSPECT',
    action__inspect: 'read',
    target__inspect__read: target,
    target_mode__inspect__read: 'one',
  },
  confidence,
})

describe('observations in the loop', () => {
  it('reads an observed file directly after ls, with no model request', async () => {
    const r = await run([{ pick: PICK_LS }, readPick('notes.txt'), { pick: PICK_RESPOND }], {
      tools: toolPort({ ls: lsResult('notes.txt', paths(['file', 'notes.txt'])), read: () => ok('hello') }),
      replies: [textReply('notes.txt says hello.')],
    })
    expect(r.tools.executed.map((c) => [c.name, c.args, c.options])).toEqual([
      ['ls', { path: '.' }, { announce: true }],
      ['read', { path: 'notes.txt', offset: 1, limit: 200 }, { announce: true }],
    ])
    expect(r.requests).toHaveLength(1)
    expect(r.steps.map((s) => [s.route, s.bindingMode])).toEqual([
      ['direct', 'defaults'],
      ['direct', 'observed'],
      ['answer', 'llm_parameters'],
    ])
    expect(r.steps[1]).toMatchObject({
      binding: { mode: 'observed', targets: ['notes.txt'], batch: 1 },
      dispatch: { refs: { source: 'arguments', count: 1 } },
    })
    expect(r.metrics.at(-1)).toMatchObject({ observedSteps: 1, directSuccess: 2 })
  })
  it('reads three observed files in one direct batch with one history entry and one view', async () => {
    const files = ['a.md', 'b.md', 'c.md']
    const batchPick = {
      pick: {
        phase: 'INSPECT',
        action__inspect: 'read',
        target_mode__inspect__read: 'many',
        include__inspect__read__0: 'include',
        include__inspect__read__1: 'include',
        include__inspect__read__2: 'include',
      },
    }
    const r = await run([{ pick: PICK_LS }, batchPick, { pick: PICK_RESPOND }], {
      tools: toolPort({
        ls: lsResult(files.join('\n'), paths(...files.map((f) => ['file', f] as [string, string]))),
        read: (args) => ok(`content of ${args.path}`),
      }),
      replies: [textReply('done')],
    })
    expect(
      r.tools.executed.filter((c) => c.name === 'read').map((c) => (c.args as { path: string }).path),
    ).toEqual(files)
    expect(r.steps[1]).toMatchObject({
      route: 'direct',
      dispatch: {
        batch: true,
        names: ['read', 'read', 'read'],
        invocationIds: ['jev:1:1:t0', 'jev:1:1:t1', 'jev:1:1:t2'],
      },
      binding: { batch: 3 },
    })
    const state = jevState(r.jev, 2)
    expect((state.recent_steps as JsonObject[]).at(-1)).toMatchObject({
      operation: 'read',
      read_files: files,
    })
    expect((state.observation_views as JsonObject[]).map((v) => v.kind)).toEqual(['ls', 'read'])
    expect(r.metrics.at(-1)).toMatchObject({ batchSteps: 1 })
  })
  it('reports one dispatched call when Core narrows a batch to its first call', async () => {
    const files = ['a.md', 'b.md', 'c.md']
    const batchPick = {
      pick: {
        phase: 'INSPECT',
        action__inspect: 'read',
        target_mode__inspect__read: 'many',
        include__inspect__read__0: 'include',
        include__inspect__read__1: 'include',
        include__inspect__read__2: 'include',
      },
    }
    const r = await run([{ pick: PICK_LS }, batchPick, { pick: PICK_RESPOND }], {
      tools: toolPort({
        ls: lsResult(files.join('\n'), paths(...files.map((f) => ['file', f] as [string, string]))),
        read: (args) => ok(`content of ${args.path}`),
      }),
      // Core refuses the batch before it writes anything; the first call then runs alone.
      wrap: (factory) =>
        withPorts(factory, (ctx) => ({
          tools: {
            ...ctx.tools,
            batch: async (...args: Parameters<typeof ctx.tools.batch>) => {
              if (args[0].length > 1)
                throw Object.assign(new Error('bad batch'), { code: 'TOOL_ARGS_INVALID' })
              return ctx.tools.batch(...args)
            },
          },
        })),
      replies: [textReply('done')],
    })
    expect(r.steps[1]).toMatchObject({
      route: 'direct',
      binding: { mode: 'observed', targets: ['a.md'], batch: 1 },
      dispatch: { batch: false, invocationIds: ['jev:1:1:t0'] },
    })
    expect(
      r.tools.executed.filter((c) => c.name === 'read').map((c) => (c.args as { path: string }).path),
    ).toEqual(['a.md'])
  })
  it('falls back to the text of ls when the result has no structured references', async () => {
    const r = await run([{ pick: PICK_LS }, readPick('notes.txt'), { pick: PICK_RESPOND }], {
      tools: toolPort({ ls: lsResult('notes.txt'), read: () => ok('hello') }),
      replies: [textReply('ok')],
    })
    expect(r.tools.executed[1]).toMatchObject({ name: 'read', args: { path: 'notes.txt' } })
    expect(r.metrics.at(-1)).toMatchObject({ textReferences: 1 })
  })
  it('refuses a third identical read and arbitrates with a recovery note even at high confidence', async () => {
    const r = await run(
      [
        { pick: PICK_LS },
        readPick('a.md', 0.99),
        readPick('a.md', 0.99),
        readPick('a.md', 0.99),
        { pick: PICK_RESPOND },
      ],
      {
        tools: toolPort({ ls: lsResult('a.md', paths(['file', 'a.md'])), read: () => ok('same') }),
        replies: [textReply('a.md says same.')],
      },
    )
    expect(r.tools.executed.filter((c) => c.name === 'read')).toHaveLength(2)
    expect(r.steps[3]).toMatchObject({
      refusal: { code: 'DUPLICATE_NO_PROGRESS', stage: 'dispatch', recoverability: 'recoverable' },
    })
    expect(r.steps[4]).toMatchObject({ route: 'arbitration', reason: 'recoverable_observation' })
    expect(r.steps[4]?.binding).toBeUndefined()
    expect((jevState(r.jev, 4).last_result as { error: JsonObject }).error.code).toBe('DUPLICATE_NO_PROGRESS')
    expect(r.metrics.at(-1)).toMatchObject({ duplicateRefusals: 1 })
  })
  it('takes the tool names from the disclosed tools and offers a tool without a profile for parameters only', async () => {
    const r = await run(
      [{ pick: { phase: 'INSPECT', action__inspect: 'docs_search' } }, { pick: PICK_RESPOND }],
      {
        view: {
          tools: ['ls', 'read', 'compact', 'docs_search'],
          platform: { meta: { docs_search: { isReadOnly: true, isOpenWorld: true } } },
        },
        replies: [callReply('docs_search', {}), textReply('found')],
        tools: toolPort({ docs_search: () => ok('result') }),
      },
    )
    expect(toolNamesOf(r.requests[0])).toEqual(['docs_search', 'ls', 'read'])
    expect((jevState(r.jev, 0).decision_surface as { phases: JsonObject }).phases.INSPECT).toEqual([
      'ls',
      'read',
      'docs_search',
    ])
    expect(r.steps[0]).toMatchObject({ route: 'parameters', op: 'docs_search' })
    expect(r.steps[0]?.binding).toBeUndefined()
  })
  // The model "loads" the tool `later` by listing: the view then discloses it, and after a second listing it does not.
  const loading = () => {
    let listed = 0
    const tools = toolPort({
      ls: () => {
        listed++
        return ok('a.txt')
      },
    })
    const wrap = (factory: Parameters<typeof withPorts>[0]) =>
      withPorts(factory, (ctx) => ({
        turn: {
          ...ctx.turn,
          view: async () => {
            const v = await ctx.turn.view()
            const disclosed = listed === 1 ? ['later', 'ls', 'read'] : ['ls', 'read']
            return v && { ...v, disclosedTools: disclosed }
          },
        },
      }))
    return { tools, wrap, view: { tools: ['ls', 'read', 'later'], platform: { disclosed: ['ls', 'read'] } } }
  }
  it('adds a tool the model loaded during the turn once, never takes one away, and counts the change', async () => {
    const { tools, wrap, view } = loading()
    const r = await run([{ pick: PICK_LS }, { pick: PICK_LS }, { pick: PICK_RESPOND }], {
      tools,
      wrap,
      view,
      replies: [textReply('ok')],
    })
    // The view drops `later` again after the second listing; the names keep it, sorted.
    expect(toolNamesOf(r.requests[0])).toEqual(['later', 'ls', 'read'])
    expect(r.checkpoint?.state).toMatchObject({ toolNames: ['later', 'ls', 'read'] })
    expect(r.metrics.at(-1)).toMatchObject({ toolNamesChanges: 1 })
  })
  it('counts the tool name changes of each turn on its own', async () => {
    const { tools, wrap, view } = loading()
    const r = await run([{ pick: PICK_LS }, { pick: PICK_RESPOND }, { pick: PICK_RESPOND }], {
      tools,
      wrap,
      view,
      inputs: [
        { content: [{ type: 'text', text: 'first' }] },
        { content: [{ type: 'text', text: 'second' }] },
      ],
      replies: [textReply('one'), textReply('two')],
      until: 'idle',
    })
    // The second turn starts from the disclosed tools and changes nothing.
    expect(r.metrics.map((m) => m.toolNamesChanges)).toEqual([1, 0])
  })
  it('keeps the state bounded after a 200 KB read of an observed file', async () => {
    const r = await run([{ pick: PICK_LS }, readPick('big.txt'), { pick: PICK_RESPOND }], {
      tools: toolPort({
        ls: lsResult('big.txt', paths(['file', 'big.txt'])),
        read: () => ok('x'.repeat(200_000)),
      }),
      replies: [textReply('big')],
    })
    const state = jevState(r.jev, 2)
    expect(String((state.observation_views as JsonObject[]).at(-1)?.evidence).length).toBeLessThanOrEqual(
      1600,
    )
    expect(JSON.stringify(state).length).toBeLessThan(24_000 * 3)
  })
  it('treats a failed call of a read-only tool without a profile as not applied', async () => {
    const r = await run(
      [{ pick: { phase: 'INSPECT', action__inspect: 'docs_search' } }, { pick: PICK_RESPOND }],
      {
        view: {
          tools: ['ls', 'read', 'docs_search'],
          platform: { meta: { docs_search: { isReadOnly: true, isOpenWorld: true } } },
        },
        replies: [callReply('docs_search', {}), textReply('failed')],
        tools: toolPort({ docs_search: () => ({ ...ok('backend down'), isError: true }) }),
      },
    )
    expect((jevState(r.jev, 1).last_result as { error: JsonObject }).error).toMatchObject({
      code: 'EXECUTION_FAILED',
      recoverability: 'recoverable',
    })
  })
  it('sends the questions of the shrink level: criteria of a tool without a profile are clipped from level 6', () => {
    const view = turnView({
      tools: ['ls', 'read', 'docs_search'],
      platform: { meta: { docs_search: { isReadOnly: true } } },
    })
    const long = 'x'.repeat(1200)
    const tool = view.tools.find((t) => t.name === 'docs_search')
    if (!tool) throw new Error('no docs_search')
    ;(tool as { description: string }).description = long
    const state = initialState()
    state.workspace = emptyWorkspace()
    state.toolNames = ['docs_search', 'ls', 'read']
    const s = { cfg: resolveConfig({}), state, cwd: '/fixture' } as never
    const { build } = stepTools(s, view)
    const criteria = (level: number): string => {
      const payload = build(level)
      if (!payload) throw new Error(`no payload at level ${level}`)
      return (
        (payload.questions.action__inspect as { criteria: Record<string, string> }).criteria.docs_search ?? ''
      )
    }
    expect(criteria(0).length).toBeGreaterThan(1000)
    expect(criteria(6).length).toBeLessThanOrEqual(500)
  })
})

describe('dispatch guards on a step', () => {
  const decision = (op: string) => ({
    phase: 'INSPECT',
    op,
    target: 'x',
    bindingMode: 'observed',
    args: {},
    confidence: 0.9,
    operationPathConfidence: 0.9,
    targetConfidence: null,
    ambiguity: null,
    progress: null,
    phaseTop: [['INSPECT', 0.9]],
    actionTop: [[op, 0.9]],
    consumed: [],
  })
  const route = (op: string) => ({ kind: 'direct', reason: null, decision: decision(op) }) as unknown as Route
  const read = (path: string, i = 0): PendingCall => ({
    invocationId: `jev:1:0:t${i}`,
    name: 'read',
    args: { path, offset: 1, limit: 200 },
    announce: 'true',
  })
  function scopeStub(toolNames: string[]) {
    const executed: string[] = []
    const events: Array<[string, JsonObject]> = []
    const state = initialState()
    state.workspace = emptyWorkspace()
    newTurn(state.workspace, 'goal')
    state.toolNames = toolNames
    const run = async (c: { name: string }) => {
      executed.push(c.name)
      return ok('text')
    }
    const ctx = {
      events: {
        emit: async (name: string, data: JsonObject) => {
          events.push([name, data])
        },
      },
      checkpoints: { write: async () => {} },
      tools: { execute: run, batch: async (calls: Array<{ name: string }>) => Promise.all(calls.map(run)) },
    }
    const s = { ctx, cfg: resolveConfig({}), state, cwd: '/fixture' } as unknown as Scope
    return { s, executed, events, state }
  }
  const signal = new AbortController().signal

  it('refuses a call of a tool that is no longer offered, before anything is announced', async () => {
    const { s, executed, events, state } = scopeStub(['ls', 'read'])
    const calls: PendingCall[] = [{ invocationId: 'jev:1:0:t0', name: 'ghost', args: {}, announce: 'true' }]
    await dispatchStep(s, calls, route('ghost'), signal)
    expect(executed).toEqual([])
    expect(state.counters).toMatchObject({ unavailableRefusals: 1, duplicateRefusals: 0 })
    expect(events.find(([name]) => name === 'jev.step')?.[1]).toMatchObject({
      refusal: { code: 'UNAVAILABLE', stage: 'dispatch', recoverability: 'recoverable' },
    })
    expect(state.workspace.history.at(-1)).toMatchObject({
      dispatched: false,
      error: { code: 'UNAVAILABLE' },
    })
    expect(state.cur.calls).toBeUndefined()
  })
  it('checks the name of every call of a batch, not only the first', async () => {
    const refused = scopeStub(['read'])
    await dispatchStep(
      refused.s,
      [read('a.md', 0), { ...read('b.md', 1), name: 'ghost' }],
      route('read'),
      signal,
    )
    expect(refused.executed).toEqual([])
    expect(refused.state.counters).toMatchObject({ unavailableRefusals: 1 })
    // A batch names the operation once per call; all offered runs.
    const offered = scopeStub(['read'])
    await dispatchStep(offered.s, [read('a.md', 0), read('b.md', 1)], route('read'), signal)
    expect(offered.executed).toEqual(['read', 'read'])
    expect(offered.state.counters).toMatchObject({ unavailableRefusals: 0 })
  })
  it('records the refused targets and the intent of the refused calls', async () => {
    const batch = scopeStub([])
    const calls = [read('a.md', 0), read('b.md', 1)]
    await dispatchStep(batch.s, calls, route('read'), signal)
    expect(batch.state.workspace.history.at(-1)).toMatchObject({
      target: ['a.md', 'b.md'],
      intentFp: intentFingerprint(calls),
    })
    const single = scopeStub([])
    await dispatchStep(single.s, [read('a.md')], route('read'), signal)
    expect(single.state.workspace.history.at(-1)).toMatchObject({ target: 'a.md' })
  })
  it('keeps two refused intents on one target apart in the failure signature', () => {
    const { s } = scopeStub([])
    const refuse = (intentFp: string) =>
      recordRefusal(s, {
        phase: 'INSPECT',
        op: 'read',
        target: 'a.md',
        code: 'DUPLICATE_NO_PROGRESS',
        stage: 'dispatch',
        message: 'm',
        intentFp,
      }).entry
    const [one, same, other] = [refuse('x'), refuse('x'), refuse('y')]
    expect(one?.intentFp).toBe('x')
    expect(failureSignature(one as never)).toBe(failureSignature(same as never))
    expect(failureSignature(one as never)).not.toBe(failureSignature(other as never))
  })
})
