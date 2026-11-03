import type { InferenceEvent, Provider, RequestBody } from '@agnes/protocol'
import { expect, vi } from 'vitest'
import { entryKey } from '../../src/refine/apply.js'
import { refinementFacade } from '../../src/refinement/facade.js'
import type { RefinementDeps } from '../../src/refinement/scheduler.js'
import type { TaskScope } from '../../src/refinement/task-scope.js'
import type { PlannerEntry, PlannerEvidence, RefinementPlanner } from '../../src/refinement/types.js'
import { ToolRegistry } from '../../src/registry/tools.js'
import { fakeProvider, sentFor, textTurn } from './fake-provider.js'
import { actor, openSession, readTool } from './open-session.js'
import { record } from './side-call-session.js'

/**
 * A session with refinement on, a scripted planner and a task-scope reader, for tests that plan and
 * apply refinements end to end.
 */

export const plannerModel = record({
  id: 'planner',
  route: 'rsi',
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
})
export const target = { route: 'rsi', model: 'planner' }

/** A verbatim part of the first request, long enough to grant session level. */
export const QUOTE = 'read file b, not a'
export const REQUEST = `first task: ${QUOTE}`
export const BODY = 'The file to read is b; a does not exist.'

export type Seen = {
  evidence: readonly PlannerEvidence[]
  entries: readonly PlannerEntry[]
  activeGoal: boolean
}
export type Answer = (seen: Seen) => unknown

export const output = (o: { edits?: unknown[]; confirmations?: unknown[]; evidenceIds?: string[] }) => ({
  summary: 'A lesson.',
  rationale: 'The evidence shows it.',
  expectedOutcome: 'Fewer failures.',
  edits: o.edits ?? [],
  confirmations: o.confirmations ?? [],
  evidenceIds: o.evidenceIds ?? [],
})
export const upsert = (id: string, over: Record<string, unknown> = {}) => ({
  op: 'upsert',
  kind: 'memory',
  id,
  title: id,
  content: `${BODY} (${id})`,
  applicability: 'session',
  evidenceIds: ['e1'],
  ...over,
})
export const ids = (seen: Seen, pick: (e: PlannerEvidence) => boolean) =>
  seen.evidence.filter(pick).map((e) => e.id)

/**
 * A session whose conversation answers from `scripts` and whose planner answers each planning call
 * with the next of `answers`, built from what it was shown. The reads fail and succeed in the order
 * of `reads`. The task-scope reader answers `goal.current`.
 */
export async function open(
  o: {
    answers?: Answer[]
    scripts?: InferenceEvent[][]
    reads?: boolean[]
    taskScope?: boolean
    /** More tools, by name, answering in order (false: a failed result). */
    tools?: Record<string, boolean[]>
  } = {},
) {
  /** The task the reader reports; `unreadable` makes the read fail. */
  const goal: { current: TaskScope | null | 'unreadable' } = { current: null }
  const answers = [...(o.answers ?? [])]
  let seen: Seen = { evidence: [], entries: [], activeGoal: false }
  const planner: RefinementPlanner = {
    buildPrompt(snapshot, entries, guidance) {
      seen = { evidence: snapshot.items, entries, activeGoal: guidance.activeGoal }
      const text = JSON.stringify({ guidance, entries, evidence: snapshot.items })
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
    parseOutput: (text) => JSON.parse(text),
  }
  const base = fakeProvider(o.scripts ?? [textTurn('answer')])
  const provider: Provider = {
    ...base,
    models: () => [plannerModel],
    async *infer(request: RequestBody, options) {
      if (request.route !== 'rsi') {
        yield* base.infer(request, options)
        return
      }
      yield sentFor(request)
      const answer = answers.shift()
      yield { type: 'text_delta', delta: JSON.stringify(answer ? answer(seen) : output({})) }
      yield {
        type: 'usage',
        tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        credits: 0.001,
        creditSource: 'gateway',
      } as InferenceEvent
      yield { type: 'done', reason: 'stop' }
    },
  }
  const reads = [...(o.reads ?? [])]
  const registry = new ToolRegistry()
  registry.add(
    readTool(async (args) =>
      reads.shift() === false
        ? { content: [{ type: 'text' as const, text: 'ENOENT: no such file' }], isError: true }
        : { content: [{ type: 'text' as const, text: `contents of ${JSON.stringify(args)}` }] },
    ),
    { source: 'agnes/tools-core', trust: 'builtin' },
  )
  for (const [name, results] of Object.entries(o.tools ?? {}))
    registry.add(
      {
        ...(readTool(async (args) =>
          results.shift() === false
            ? { content: [{ type: 'text' as const, text: 'not found' }], isError: true }
            : { content: [{ type: 'text' as const, text: `${BODY} ${JSON.stringify(args)}` }] },
        ) as object),
        name,
      } as never,
      { source: 'agnes/tools-core', trust: 'builtin' },
    )
  const refinement: RefinementDeps = {
    settings: () => ({ enabled: true, mode: 'auto', revision: 'r1' }),
    planner: () => planner,
    target,
    ...(o.taskScope === false
      ? {}
      : {
          taskScope: () => {
            if (goal.current === 'unreadable') throw new Error('the goal cannot be read')
            return goal.current
          },
        }),
  }
  const opened = await openSession({ provider, registry, refinement, refinementEnabled: () => true })
  const s = opened.session
  const facade = refinementFacade(s)
  const say = async (text: string) => {
    await s.enqueue('next-turn', { content: [{ type: 'text', text }], actor })
    return s.run({ until: 'turn-end', signal: new AbortController().signal })
  }
  /** Plans and applies one manual request for the work so far, and returns how the run ended. */
  const refine = async () => {
    const outcome = await facade.request({ kind: 'manual', seq: s.lastSeq })
    const runId = (outcome as { runId?: string }).runId as string
    expect(runId, JSON.stringify(outcome)).toBeTruthy()
    await vi.waitFor(() =>
      expect(['applied', 'no-op', 'rejected', 'cancelled']).toContain(
        s.state.refinementRuns.get(runId)?.state,
      ),
    )
    return s.state.refinementRuns.get(runId)
  }
  const rows = () => s.scan({ toSeq: s.lastSeq })
  const meta = (id: string) => s.state.refinementEntryMeta.get(entryKey({ kind: 'memory', id }))
  const entries = () => [...s.state.registers.harnessEntries.values()].map((cell) => cell.value.id)
  const lastRequest = () => JSON.stringify(base.requests.at(-1) ?? null)
  return { ...opened, goal, say, refine, rows, meta, entries, lastRequest, requests: base.requests }
}

export const activeGoal: TaskScope = { id: 'goal-1', revision: 1, phase: 'active' }
