import type { HarnessEntry } from '@agnes/core-ledger/reduce/shapes'
import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { describe, expect, it, vi } from 'vitest'
import { refinementFacade } from '../src/refinement/facade.js'
import type { RefinementDeps } from '../src/refinement/scheduler.js'
import type { RefinementPlanner } from '../src/refinement/types.js'
import type { RefinementWorkflowRuns, WorkflowRunView } from '../src/refinement/workflow-runs.js'
import { unavailableWorkflowRuns, WORKFLOW_RUN_LOOKUP_MS } from '../src/refinement/workflow-runs.js'
import { fakeProvider, sentFor, textTurn } from './helpers/fake-provider.js'
import { actor, openSession } from './helpers/open-session.js'
import { ofType, record } from './helpers/side-call-session.js'

const plannerModel = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
const target = { route: 'rsi', model: 'planner' }
const DONE = 'run-done'
const VIEW: WorkflowRunView = {
  runId: DONE,
  name: 'ship',
  stages: [{ name: 'research', members: [{ name: 'a', task: 'look' }] }],
}

const planner: RefinementPlanner = {
  buildPrompt(snapshot, entries) {
    const text = JSON.stringify({ entries, evidence: snapshot.items })
    return {
      system: 'Plan one refinement.',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      evidenceIds: snapshot.items.map((item) => item.id),
      fullEntries: entries.map(({ kind, id }) => ({ kind, id })),
      referenceEntries: [],
      omitted: { referenceEntries: 0, evidence: 0, fullEntries: 0 },
      inputTokens: 0,
    }
  },
  parseOutput(text) {
    try {
      return JSON.parse(text)
    } catch {
      return { error: 'invalid-json' }
    }
  },
}

const lesson = {
  op: 'upsert',
  kind: 'memory',
  id: 'build-first',
  title: 'Build first',
  content: 'Run pnpm build before the tests.',
  applicability: 'session',
  evidenceIds: ['e1'],
}
const skill = (id: string, workflowRun: string, over: Record<string, unknown> = {}) => ({
  op: 'upsert',
  kind: 'skill',
  id,
  title: 'Ship it in stages',
  content: 'Use when a change needs research, then a build.',
  applicability: 'session',
  evidenceIds: ['e1'],
  workflowRun,
  ...over,
})
const planOf = (...edits: Record<string, unknown>[]) =>
  JSON.stringify({
    summary: 'Keep what worked.',
    rationale: 'It worked.',
    expectedOutcome: 'Reuse it.',
    edits,
    confirmations: [],
    evidenceIds: ['e1'],
  })

function provider(plans: string[]) {
  const base = fakeProvider([textTurn('answer')])
  const queue = [...plans]
  const p: Provider = {
    ...base,
    models: () => [plannerModel],
    async *infer(request: RequestBody, options) {
      if (request.route !== 'rsi') {
        yield* base.infer(request, options)
        return
      }
      yield sentFor(request)
      yield { type: 'text_delta', delta: queue.shift() ?? '' }
      yield {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        credits: 0.001,
        creditSource: 'gateway',
      } as InferenceEvent
      yield { type: 'done', reason: 'stop' }
    },
  }
  return p
}

type Answer = WorkflowRunView | 'not-found' | 'not-completed'

async function open(o: {
  plans: string[]
  runs?: Record<string, Answer> | false
  read?: () => Promise<Answer>
}) {
  const asked: string[] = []
  const runs: Record<string, Answer> = o.runs === false ? {} : { [DONE]: VIEW, ...o.runs }
  const workflowRuns: RefinementWorkflowRuns = {
    read: async (at, id) => {
      asked.push(`${at.key}:${id}`)
      return o.read ? o.read() : (runs[id] ?? 'not-found')
    },
  }
  const sw = { enabled: true, mode: 'manual' as const, revision: 'r1' }
  const refinement: RefinementDeps = {
    settings: () => ({ ...sw }),
    planner: () => planner,
    target,
    ...(o.runs === false ? {} : { workflowRuns }),
  }
  const opened = await openSession({
    provider: provider(o.plans),
    refinement,
    refinementEnabled: () => sw.enabled,
  })
  const s = opened.session
  const say = async (text: string) => {
    await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return s.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  const facade = refinementFacade(s)
  const state = (runId: string) => s.state.refinementRuns.get(runId)
  const plan = async () => {
    await say('ship it')
    const out = (await facade.request({ kind: 'manual', seq: s.lastSeq })) as { runId?: string }
    if (!out.runId) throw new Error(`no run: ${JSON.stringify(out)}`)
    return out.runId
  }
  const entries = () =>
    [...s.state.registers.harnessEntries.values()].map((cell) => cell.value as HarnessEntry)
  return { ...opened, s, asked, say, facade, state, plan, entries }
}

describe('a skill edit that names a workflow run', () => {
  it('is applied when the run is finished, and the entry carries the run id', async () => {
    const t = await open({ plans: [planOf(skill('ship-flow', DONE))] })
    const id = await t.plan()
    await vi.waitFor(() => expect(t.state(id)?.state).toBe('applied'))
    expect(t.entries()).toEqual([
      expect.objectContaining({ kind: 'skill', id: 'ship-flow', workflowRun: DONE }),
    ])
    expect(t.asked.every((entry) => entry.endsWith(`:${DONE}`))).toBe(true)
    await t.s.close()
  })

  it('is dropped alone when the run is not in this session: the other edits stay', async () => {
    const t = await open({ plans: [planOf(skill('ship-flow', 'elsewhere'), lesson)] })
    const id = await t.plan()
    await vi.waitFor(() => expect(t.state(id)?.state).toBe('applied'))
    expect(t.entries().map((e) => `${e.kind}/${e.id}`)).toEqual(['memory/build-first'])
    await t.s.close()
  })

  it('is dropped alone when the run did not finish', async () => {
    const t = await open({
      plans: [planOf(skill('ship-flow', 'half'), lesson)],
      runs: { half: 'not-completed' },
    })
    const id = await t.plan()
    await vi.waitFor(() => expect(t.state(id)?.state).toBe('applied'))
    expect(t.entries().map((e) => `${e.kind}/${e.id}`)).toEqual(['memory/build-first'])
    await t.s.close()
  })

  it('refuses a plan with nothing else left, naming why', async () => {
    const gone = await open({ plans: [planOf(skill('ship-flow', 'elsewhere'))] })
    const a = await gone.plan()
    await vi.waitFor(() => expect(gone.state(a)?.state).toBe('rejected'))
    expect(gone.state(a)).toMatchObject({ reason: 'workflow-run-unavailable', detail: 'skill/ship-flow' })
    expect(ofType(await gone.s.scan({ toSeq: gone.s.lastSeq }), 'harness/entry')).toHaveLength(0)
    await gone.s.close()
    const half = await open({
      plans: [planOf(skill('ship-flow', 'half'))],
      runs: { half: 'not-completed' },
    })
    const b = await half.plan()
    await vi.waitFor(() => expect(half.state(b)?.state).toBe('rejected'))
    expect(half.state(b)).toMatchObject({ reason: 'workflow-run-not-completed', detail: 'skill/ship-flow' })
    await half.s.close()
  })

  it('is unavailable where the host offers no run records', async () => {
    const t = await open({ plans: [planOf(skill('ship-flow', DONE))], runs: false })
    const id = await t.plan()
    await vi.waitFor(() => expect(t.state(id)?.state).toBe('rejected'))
    expect(t.state(id)).toMatchObject({ reason: 'workflow-run-unavailable' })
    await t.s.close()
  })

  it('is refused whole by the run check when the edit is not a plain skill edit', async () => {
    // Another kind, or a run beside a bound resource: the plan is not valid at all.
    for (const bad of [
      skill('ship-flow', DONE, { kind: 'memory' }),
      skill('ship-flow', DONE, { reference: 'skill:x@rev1' }),
      skill('ship-flow', 'two words'),
    ]) {
      const t = await open({ plans: [planOf(bad)] })
      const id = await t.plan()
      await vi.waitFor(() => expect(t.state(id)?.state).toBe('rejected'))
      expect(t.state(id)).toMatchObject({ reason: 'invalid-output', detail: 'invalid-shape: edits[0]' })
      await t.s.close()
    }
  })

  it('reads each run once however many edits name it, and a read that fails or hangs is unavailable', async () => {
    const t = await open({ plans: [] })
    const edit = (id: string) => ({ op: 'upsert', kind: 'skill' as const, id, workflowRun: DONE })
    expect(await unavailableWorkflowRuns(t.s, [edit('a'), edit('b')])).toEqual([])
    expect(t.asked).toHaveLength(1)
    await t.s.close()

    const broken = await open({
      plans: [],
      read: () => Promise.reject(new Error('boom')),
    })
    expect(
      await unavailableWorkflowRuns(broken.s, [{ op: 'upsert', kind: 'skill', id: 'a', workflowRun: DONE }]),
    ).toEqual([{ key: 'skill/a', reason: 'workflow-run-unavailable' }])
    await broken.s.close()

    vi.useFakeTimers()
    try {
      const slow = await open({ plans: [], read: () => new Promise<Answer>(() => undefined) })
      const pending = unavailableWorkflowRuns(slow.s, [
        { op: 'upsert', kind: 'skill', id: 'a', workflowRun: DONE },
      ])
      await vi.advanceTimersByTimeAsync(WORKFLOW_RUN_LOOKUP_MS + 1)
      expect(await pending).toEqual([{ key: 'skill/a', reason: 'workflow-run-unavailable' }])
      await slow.s.close()
    } finally {
      vi.useRealTimers()
    }
  })
})
