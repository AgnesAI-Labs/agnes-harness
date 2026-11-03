import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Kernel, RefinementPlanner } from '@agnes/core'
import { ProjectionRegistry, refinementFacade } from '@agnes/core'
import { actor, fakeProvider, openSession, sent, textTurn, usage } from '@agnes/core/testkit'
import { RefinementSettingsStore } from '@agnes/host-infrastructure/refinement-settings'
import type { ModelRecord, Provider } from '@agnes/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRefinementHost } from '../../src/runtime/assemble/refinement.js'

const PROFILE = 'p'
const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agnes-refinement-host-'))
  dirs.push(dir)
  return dir
}
const save = (dataDir: string, settings: { enabled: boolean; mode: 'manual' | 'auto' }) => {
  const store = new RefinementSettingsStore(dataDir, PROFILE)
  store.save(settings, store.read().revision)
}
const planner = { buildPrompt: () => ({}) as never, parseOutput: () => ({ error: 'unused' }) }

describe('the host side of refinement', () => {
  it('Core sees the switch only while it is on both at assembly and now', () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const on = createRefinementHost(dataDir, PROFILE)
    expect(on.kernelOptions.refinementEnabled()).toBe(true)
    save(dataDir, { enabled: true, mode: 'manual' })
    // Mode changes are live; automatic candidates are wanted only in auto mode.
    expect(on.kernelOptions.refinement.settings()).toMatchObject({ enabled: true, mode: 'manual' })
    expect(on.kernelOptions.refinementTriggers.accepts?.('k')).toBe(false)
    save(dataDir, { enabled: false, mode: 'manual' })
    expect(on.kernelOptions.refinementEnabled()).toBe(false)
    // The tools keep the value read at assembly.
    expect(on.view.current().settings.enabled).toBe(true)

    const off = createRefinementHost(scratch(), PROFILE)
    expect(off.view.current().settings.enabled).toBe(false)
    expect(off.kernelOptions.refinementEnabled()).toBe(false)
  })

  it('a read that throws is off, never an error', () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const bridge = createRefinementHost(dataDir, PROFILE)
    vi.spyOn(RefinementSettingsStore.prototype, 'current').mockImplementation(() => {
      throw new Error('disk gone')
    })
    expect(bridge.kernelOptions.refinementEnabled()).toBe(false)
    expect(bridge.kernelOptions.refinement.settings().enabled).toBe(false)
    expect(bridge.kernelOptions.refinementTriggers.accepts?.('k')).toBe(false)
  })

  it('the plugin connects with its planner; its calls reach the session the tool ran in', async () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const bridge = createRefinementHost(dataDir, PROFILE)
    expect(bridge.kernelOptions.refinement.planner()).toBeUndefined()
    const runs = bridge.connect(planner)
    expect(bridge.kernelOptions.refinement.planner()).toBe(planner)
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      refinement: bridge.kernelOptions.refinement,
    })
    bridge.bindKernel({ sessions: new Map([[session.key, session]]) } as unknown as Kernel)
    await session.enqueue('next-turn', { content: [{ type: 'text', text: 'task' }], actor })
    await session.run({ until: 'turn-end', signal: new AbortController().signal })
    const proposal = {
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ op: 'upsert' as const, kind: 'memory' as const, id: 'm', title: 't', content: 'c' }],
    }
    expect(await runs.propose({ key: session.key, lane: 'other' }, proposal)).toEqual({
      refused: 'unavailable',
    })
    expect(await runs.propose({ key: 'nobody', lane: session.lane }, proposal)).toEqual({
      refused: 'unavailable',
    })
    const outcome = await runs.propose({ key: session.key, lane: session.lane }, proposal)
    expect(session.state.refinementRuns.get((outcome as { runId: string }).runId)?.state).toBe('applied')
    // An automatic candidate for a session that is not open here is dropped quietly.
    expect(() =>
      bridge.kernelOptions.refinementTriggers.offer({
        sessionKey: 'nobody',
        lane: 'main',
        trigger: { kind: 'compaction', seq: 1 },
      }),
    ).not.toThrow()
    await session.close()
  })

  it("Core reads the session's task through the projection the task plugin offers", async () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const bridge = createRefinementHost(dataDir, PROFILE)
    const projections = new ProjectionRegistry()
    // A stand-in task projection: the last request names the goal, `fail` breaks the fold.
    projections.register({
      key: 'agnes/goal/goal',
      stateVersion: 1,
      init: () => ({ goal: null as string | null }),
      apply: (state, event) => {
        if (event.type !== 'user/message') return state
        const text = JSON.stringify(event.data)
        if (text.includes('fail')) throw new Error('broken')
        const goal = /goal (\w+)/u.exec(text)?.[1]
        return goal ? { goal } : state
      },
    })
    const { session } = await openSession({
      provider: fakeProvider([textTurn('done')]),
      refinement: bridge.kernelOptions.refinement,
    })
    bridge.bindKernel({ sessions: new Map([[session.key, session]]), projections } as unknown as Kernel)
    const say = async (text: string) => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      await session.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    const read = () => bridge.kernelOptions.refinement.taskScope?.({ key: session.key, lane: session.lane })
    await say('goal first')
    // Nothing offered yet (the plugin is off or reloading): the task cannot be read.
    expect(await read()).toBeUndefined()
    const withdraw = bridge.provideTaskScope('agnes/goal', {
      projection: 'goal',
      reader: (state) => ({
        current: () => {
          const goal = (state as { goal: string | null }).goal
          return goal ? { id: goal, revision: 1, phase: 'active' as const } : null
        },
      }),
    })
    expect(await read()).toEqual({ id: 'first', revision: 1, phase: 'active' })
    // Folded on from where the registry left off: a later row is seen.
    await say('goal second')
    expect(await read()).toEqual({ id: 'second', revision: 1, phase: 'active' })
    expect(
      await bridge.kernelOptions.refinement.taskScope?.({ key: 'nobody', lane: session.lane }),
    ).toBeUndefined()
    // A projection that cannot be folded cannot be read, and the failure is recorded once.
    await say('fail')
    expect(await read()).toBeUndefined()
    expect(await read()).toBeUndefined()
    const diags = await session.scan({ type: 'x/core/projection-failed', toSeq: session.lastSeq })
    expect(diags.map((row) => row.data)).toEqual([{ key: 'agnes/goal/goal', asOfSeq: expect.any(Number) }])
    withdraw()
    expect(await read()).toBeUndefined()
    await session.close()
  })
})

describe('inspect through the host', () => {
  it('inspect never returns another session’s entries', async () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'manual' })
    const bridge = createRefinementHost(dataDir, PROFILE)
    const runs = bridge.connect(planner)
    const opened = async (key: string) =>
      (
        await openSession({
          provider: fakeProvider([textTurn('done')]),
          key,
          refinement: bridge.kernelOptions.refinement,
          refinementEnabled: bridge.kernelOptions.refinementEnabled,
        })
      ).session
    const a = await opened('a')
    const b = await opened('b')
    bridge.bindKernel({
      sessions: new Map([
        [a.key, a],
        [b.key, b],
      ]),
    } as unknown as Kernel)
    await a.enqueue('next-turn', { content: [{ type: 'text', text: 'task' }], actor })
    await a.run({ until: 'turn-end', signal: new AbortController().signal })
    const proposal = {
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [
        { op: 'upsert' as const, kind: 'memory' as const, id: 'm', title: 'A only', content: 'a fact' },
      ],
    }
    expect(await runs.propose({ key: a.key, lane: a.lane }, proposal)).toHaveProperty('runId')
    const get = { op: 'get' as const, id: 'memory/m' }
    expect(await runs.inspect({ key: a.key, lane: a.lane }, get)).toMatchObject({
      op: 'get',
      entry: { kind: 'memory', id: 'm', content: 'a fact' },
    })
    // The same request from the other session reads only that session, which holds nothing.
    expect(await runs.inspect({ key: b.key, lane: b.lane }, get)).toEqual({
      refused: 'not-found',
      detail: 'memory/m',
    })
    expect(await runs.inspect({ key: b.key, lane: b.lane }, { op: 'search', query: 'fact' })).toEqual({
      op: 'search',
      entries: [],
      matched: 0,
    })
    // A session that is not open here, or another lane, is no session at all.
    expect(await runs.inspect({ key: 'nobody', lane: a.lane }, get)).toEqual({ refused: 'unavailable' })
    expect(await runs.inspect({ key: a.key, lane: 'other' }, get)).toEqual({ refused: 'unavailable' })
    await a.close()
    await b.close()
  })
})

const NOOP = JSON.stringify({
  summary: 'Nothing.',
  rationale: '',
  expectedOutcome: '',
  edits: [],
  confirmations: [],
  evidenceIds: [],
})
const PLAN_SYSTEM = 'Plan one refinement.'
const jsonPlanner: RefinementPlanner = {
  buildPrompt: (snapshot) => ({
    system: PLAN_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(snapshot.items) }] }],
    evidenceIds: snapshot.items.map((item) => item.id),
    fullEntries: [],
    referenceEntries: [],
    omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
    inputTokens: 0,
  }),
  parseOutput: (text) => JSON.parse(text),
}
const primary: ModelRecord = {
  id: 'm',
  name: 'model',
  api: 'openai-completions',
  route: 'default',
  baseUrl: 'https://test.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10_000,
  maxTokens: 1000,
  toolCallFormats: ['native'],
  thinkingReplay: 'native',
  contract_id: null,
}
const gate = () => {
  let open!: () => void
  const wait = new Promise<void>((resolve) => {
    open = resolve
  })
  return { wait, open }
}

/** The conversation answers at once except the turns held; the planner call waits for `plan`. */
function provider(o: { holds?: Map<number, Promise<void>>; plan?: Promise<void> }) {
  const talk = fakeProvider([textTurn('done')])
  const planner = fakeProvider([
    [sent(), { type: 'text_delta', delta: NOOP }, usage(), { type: 'done', reason: 'stop' }],
  ])
  const seen = { turns: 0, plans: 0 }
  const p: Provider = {
    ...talk,
    models: () => [primary],
    async *infer(request, options) {
      if (request.system === PLAN_SYSTEM) {
        seen.plans++
        await o.plan
        yield* planner.infer(request, options)
        return
      }
      await o.holds?.get(seen.turns++)
      yield* talk.infer(request, options)
    },
  }
  return { provider: p, seen }
}

describe('switching refinement off and on again with the real settings store', () => {
  async function opened(dataDir: string, o: Parameters<typeof provider>[0] = {}) {
    const bridge = createRefinementHost(dataDir, PROFILE)
    bridge.connect(jsonPlanner)
    const p = provider(o)
    const { session } = await openSession({
      provider: p.provider,
      refinement: bridge.kernelOptions.refinement,
      refinementEnabled: bridge.kernelOptions.refinementEnabled,
    })
    const say = async (text: string) => {
      await session.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
      return session.run({ until: 'turn-end', signal: new AbortController().signal })
    }
    const rows = () => session.scan({ toSeq: session.lastSeq })
    return { session, say, rows, seen: p.seen }
  }

  it('a proposal pending when the switch went off is never applied after it is back on', async () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const held = gate()
    const t = await opened(dataDir, { holds: new Map([[1, held.wait]]) })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    await t.session.enqueue('next-turn', { content: [{ type: 'text', text: 'second task' }], actor })
    const second = t.session.run({ until: 'turn-end', signal: new AbortController().signal })
    await vi.waitFor(() => expect(t.seen.turns).toBe(2))
    const outcome = await refinementFacade(t.session).propose({
      rationale: 'r',
      evidenceSeqs: [1],
      edits: [{ op: 'upsert', kind: 'memory', id: 'm', title: 't', content: 'c' }],
    })
    const id = (outcome as { runId: string }).runId
    expect(t.session.state.refinementRuns.get(id)?.state).toBe('proposed')
    save(dataDir, { enabled: false, mode: 'auto' })
    const before = (await t.rows()).length
    held.open()
    expect(await second).toMatchObject({ reason: 'completed' })
    // Off: the turn ended and nothing at all was written for refinement.
    expect((await t.rows()).slice(before).filter((row) => row.lane === 'refinement')).toEqual([])
    save(dataDir, { enabled: true, mode: 'auto' })
    expect(await t.say('third task')).toMatchObject({ reason: 'completed' })
    expect(t.session.state.refinementRuns.get(id)).toMatchObject({
      state: 'cancelled',
      reason: 'settings-changed',
    })
    const all = await t.rows()
    expect(all.filter((row) => row.type === 'harness/entry' || row.type === 'harness/refine')).toEqual([])
    await t.session.close()
  })

  it('a queued request is not planned after the switch went off and on again', async () => {
    const dataDir = scratch()
    save(dataDir, { enabled: true, mode: 'auto' })
    const plan = gate()
    const t = await opened(dataDir, { plan: plan.wait })
    expect(await t.say('first task')).toMatchObject({ reason: 'completed' })
    const facade = refinementFacade(t.session)
    const a = (await facade.request({ kind: 'manual', seq: t.session.lastSeq })) as { runId: string }
    await vi.waitFor(() => expect(t.seen.plans).toBe(1))
    const b = (await facade.request({ kind: 'manual', seq: t.session.lastSeq })) as { runId: string }
    expect(t.session.state.refinementRuns.get(b.runId)?.state).toBe('queued')
    save(dataDir, { enabled: false, mode: 'auto' })
    save(dataDir, { enabled: true, mode: 'auto' })
    plan.open()
    await vi.waitFor(() => expect(t.session.state.refinementRuns.get(b.runId)?.state).toBe('cancelled'))
    // The plan in flight settles under the new revision and is not proposed either.
    expect(t.session.state.refinementRuns.get(a.runId)).toMatchObject({
      state: 'rejected',
      reason: 'settings-changed',
    })
    expect(t.seen.plans).toBe(1)
    await t.session.close()
  })
})
