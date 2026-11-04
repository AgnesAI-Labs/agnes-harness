import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reachedMilestones, ruleForgetting, runStatus } from './long-report.js'
import { progressOf, sessionCostOfLedger, toRunRecord } from './metrics.js'
import { buildReport } from './report.js'
import { defaultTasksDir, loadSuite } from './suite.js'
import type { EvalTask, PromptProgress, RunOutcome, RunRecord, SessionCost } from './types.js'

// Ledgers are trimmed rows of the first evaluation's runs (fixtures/real): cross-01's off run, first
// session (tool calls, cost rows, turn ends), and cross-03's off run, both sessions (prompts, tool calls and
// their results: the trap was hit twice in the first session and not in the second).
const real = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'real', name), 'utf8')
const suite = loadSuite(defaultTasksDir)
const byId = (id: string) => suite.find((t) => t.id === id) as EvalTask

describe('what a session had spent at the end of each prompt', () => {
  const text = real('progress.cross-01.off-s1.jsonl')
  // The runner records when each prompt's turn ended; here, the real turn ends of the run.
  const ends = text
    .split('\n')
    .filter((line) => line.includes('"type": "turn/end"'))
    .map((line) => (JSON.parse(line) as { ts: string }).ts)
  const task = byId('cross-01-build-subdir')
  const outcome = (milestones: boolean): RunOutcome => ({
    runId: 'cross-01-build-subdir.off.r1',
    system: 'agh',
    sessions: [],
    checks: [
      { session: 0, prompt: 0, passed: true },
      { session: 0, prompt: 1, passed: false },
    ],
    prompts: ends.map((endedAt, prompt) => ({ session: 0, prompt, endedAt, reason: 'completed' })),
    ...(milestones ? {} : {}),
  })

  it('counts the tool calls, requests, tokens and dollars of the ledger up to each prompt end', () => {
    // Summed outside this code from the same rows.
    expect(progressOf(task, outcome(false), [text])).toEqual([
      {
        session: 0,
        prompt: 0,
        toolCalls: 8,
        requests: 7,
        tokens: 49_103,
        cost: 0.004539,
        mainRequests: 7,
        mainCost: 0.004539,
      },
      {
        session: 0,
        prompt: 1,
        toolCalls: 10,
        requests: 11,
        tokens: 74_115,
        cost: 0.006759,
        mainRequests: 11,
        mainCost: 0.006759,
      },
      {
        session: 0,
        prompt: 2,
        toolCalls: 12,
        requests: 14,
        tokens: 99_766,
        cost: 0.008932,
        mainRequests: 14,
        mainCost: 0.008932,
      },
    ])
  })

  it('carries the milestone and whether its checks passed', () => {
    const staged: EvalTask = {
      ...task,
      sessions: [
        {
          prompts: (task.sessions[0]?.prompts ?? []).map((p, i) =>
            i < 2 ? { ...p, milestone: `stage ${i + 1}` } : p,
          ),
        },
        ...task.sessions.slice(1),
      ],
    }
    const progress = progressOf(staged, outcome(true), [text])
    expect(progress.map((p) => [p.milestone, p.passed])).toEqual([
      ['stage 1', true],
      ['stage 2', false],
      [undefined, undefined],
    ])
  })
})

describe('rule forgetting', () => {
  const task = byId('cross-03-latin1-menus')
  const files: Record<string, string> = {
    's1.jsonl': real('trap.cross-03.off-s1.jsonl'),
    's2.jsonl': real('trap.cross-03.off-s2.jsonl'),
  }
  const outcome: RunOutcome = {
    runId: 'cross-03-latin1-menus.off.r1',
    system: 'agh',
    sessions: [
      { exitCode: 0, timedOut: false, stdoutFile: 'a', sessionFiles: ['s1.jsonl'] },
      { exitCode: 0, timedOut: false, stdoutFile: 'b', sessionFiles: ['s2.jsonl'] },
    ],
    checks: [],
  }
  const record = (read: Record<string, string> = files) =>
    toRunRecord(task, outcome, new Map(), { system: 'agh', readFile: (path) => read[path] ?? '' })

  it('finds the first hit and the hit that came back later in the same session, and none in the second', () => {
    const r = record()
    expect(r.trapEvents).toEqual([
      { session: 0, hits: [104, 433], compactions: [] },
      { session: 1, hits: [], compactions: [] },
    ])
    expect(ruleForgetting(r)).toEqual({
      run: 'cross-03-latin1-menus.off.r1',
      arm: 'off',
      firstHitSession: 0,
      againSameSession: 1,
      againAfterCompaction: 0,
      againInSession2: 0,
    })
  })

  it('tells a hit after a compaction apart', () => {
    // The real rows with one compaction row put between the two hits.
    const compaction = JSON.stringify({
      seq: 300,
      ts: '2026-11-04T01:40:00.000Z',
      type: 'x/core/compaction-end',
      lane: 'main',
      origin: 'system',
      data: {},
    })
    const lines = (files['s1.jsonl'] as string).split('\n')
    const at = lines.findIndex((line) => line.includes('"seq": 433'))
    const withCompaction = [...lines.slice(0, at), compaction, ...lines.slice(at)].join('\n')
    expect(ruleForgetting(record({ ...files, 's1.jsonl': withCompaction }))).toMatchObject({
      againSameSession: 1,
      againAfterCompaction: 1,
    })
  })

  it('is printed per arm and per off run in the report', () => {
    const { markdown, json } = buildReport([record()], { resamples: 50 })
    expect(markdown).toContain('### Rule forgetting')
    expect(markdown).toContain('| cross-03-latin1-menus.off.r1 | session 1 | 1 | 0 | 0 |')
    expect(
      (json as { systems: { agh: { ruleForgetting: { byArm: object } } } }).systems.agh.ruleForgetting.byArm,
    ).toEqual({
      off: {
        runs: 1,
        firstHit: 1,
        againSameSession: 1,
        againAfterCompaction: 0,
        withSecondSession: 1,
        againInSession2: 0,
      },
    })
  })
})

// Records for the report sections. Their figures are those of the real progress above; only the rules of
// the sections are under test (which runs enter, where a curve stops, what is listed apart).
const point = (prompt: number, requests: number, cost: number, passed: boolean): PromptProgress => ({
  session: 0,
  prompt,
  toolCalls: requests,
  requests,
  tokens: requests * 7000,
  cost,
  mainRequests: requests,
  mainCost: cost,
  milestone: `stage ${prompt + 1}`,
  passed,
})
const cost = (requests: number, usd: number): SessionCost => ({
  requests,
  tokens: requests * 7000,
  cost: usd,
  lowerBound: false,
  refinement: { requests: 0, tokens: 0, cost: 0 },
})
const record = (setting: RunRecord['setting'], rep: number, over: Partial<RunRecord> = {}): RunRecord => ({
  system: 'agh',
  taskId: 'long-a',
  category: 'long',
  setting,
  rep,
  exit: 'ok',
  windows: [0, 1, 2].map((prompt) => ({ session: 0, prompt, ran: true, trapHit: false, checksPassed: true })),
  refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
  harnessLookups: 0,
  compactions: 0,
  usage: { requests: 0, unknown: 0, tokens: 0, costUsd: 0 },
  progress: [point(0, 7, 0.004539, true), point(1, 11, 0.006759, true), point(2, 14, 0.008932, true)],
  sessionCosts: [cost(14, 0.008932)],
  ...over,
})

describe('milestone curves and capped runs', () => {
  const finished = record('off', 1)
  const stopped = record('off', 2, {
    exit: 'error',
    progress: [point(0, 9, 0.006, true), point(1, 13, 0.009, false)],
    sessionCosts: [cost(13, 0.009)],
  })
  const capped = record('on', 1, {
    exit: 'error',
    capped: { maxRequests: 12, session: 0, prompt: 1 },
    progress: [point(0, 8, 0.005, true), { ...point(1, 12, 0.008, false) }],
    sessionCosts: [cost(12, 0.008)],
  })
  const records = [finished, stopped, capped, record('on', 2)]

  it('stops each curve where its run stopped, and says how', () => {
    expect([finished, stopped, capped].map(runStatus)).toEqual(['completed', 'milestone-failed', 'capped'])
    expect(reachedMilestones(stopped).map((p) => p.milestone)).toEqual(['stage 1'])
    expect(reachedMilestones(finished).map((p) => [p.requests, p.cost])).toEqual([
      [7, 0.004539],
      [11, 0.006759],
      [14, 0.008932],
    ])
  })

  it('reports per arm how many runs reached each milestone and the medians of those that did, and one point per run', () => {
    const { json, markdown } = buildReport(records, { resamples: 50 })
    type Cell = { milestone: string; reached: number; of: number; medianRequests: number | null }
    const m = (
      json as {
        systems: {
          agh: {
            milestones: {
              tasks: {
                byArm: Record<string, Cell[]>
                runs: { run: string; reached: number; status: string; total: { requests: number } }[]
              }[]
            }
          }
        }
      }
    ).systems.agh.milestones
    const off = m.tasks[0]?.byArm.off ?? []
    expect(off.map((c) => [c.milestone, c.reached, c.of, c.medianRequests])).toEqual([
      ['stage 1', 2, 2, 8],
      ['stage 2', 1, 2, 11],
      ['stage 3', 1, 2, 14],
    ])
    expect(m.tasks[0]?.runs.map((r) => [r.run, r.reached, r.status, r.total.requests])).toEqual([
      ['long-a.off.r1', 3, 'completed', 14],
      ['long-a.off.r2', 1, 'milestone-failed', 13],
      ['long-a.on.r1', 1, 'capped', 12],
      ['long-a.on.r2', 3, 'completed', 14],
    ])
    expect(markdown).toContain('### Milestones')
    expect(markdown).toContain('| long-a.off.r2 | milestone-failed | 9 req, $0.0060 | - | - |')
  })

  it('lists capped runs apart and keeps them out of every mean', () => {
    const { json, markdown } = buildReport(records, { resamples: 50 })
    const agh = (
      json as {
        systems: { agh: { runs: { on: number; off: number }; capped: { byArm: Record<string, number> } } }
      }
    ).systems.agh
    expect(agh.runs).toEqual({ on: 1, off: 2 })
    expect(agh.capped.byArm).toMatchObject({ on: 1, off: 0 })
    expect(markdown).toContain('| long-a.on.r1 | 12 | session 1, prompt 2 | 1 |')
  })
})

describe('the frozen arm in the report', () => {
  // The second-session costs of the real cross-01 runs (fixtures/real), standing for the three arms.
  const off = sessionCostOfLedger(real('session-cost.cross-01.off-s2.jsonl'))
  const on = sessionCostOfLedger(real('session-cost.cross-01.on-s2.jsonl'))
  const two = (
    setting: RunRecord['setting'],
    rep: number,
    second: SessionCost,
    over: Partial<RunRecord> = {},
  ): RunRecord => ({
    ...record(setting, rep),
    taskId: 'cross-a',
    category: 'cross-session',
    windows: [0, 1].flatMap((session) =>
      [0, 1, 2].map((prompt) => ({ session, prompt, ran: true, trapHit: false, checksPassed: true })),
    ),
    sessionCosts: [cost(20, 0.01), second],
    progress: [],
    ...over,
  })
  const records = [
    two('off', 1, off),
    two('off', 2, off),
    two(
      'frozen',
      1,
      { ...off, requests: 12, cost: 0.007 },
      {
        frozenFrom: {
          runId: 'cross-a.on.r1',
          paragraphs: { fixture: 3 },
          skills: { fixture: ['add_part_and_build'] },
          userSections: 0,
        },
      },
    ),
    two('frozen', 2, { ...off, requests: 14, cost: 0.008 }),
    two('oracle', 1, { ...on, requests: 10, cost: 0.006 }),
    // A frozen run that failed a check: left out.
    two('frozen', 3, { ...off, requests: 2, cost: 0.001 }, { exit: 'error' }),
  ]

  it('compares frozen with off and oracle per session and for the whole run, over completed sessions', () => {
    const { json, markdown } = buildReport(records, { resamples: 100 })
    type Scope = {
      scope: string
      requests: { mean: Record<string, number | null>; offMinusFrozen: { estimate: number | null } }
    }
    const f = (
      json as {
        systems: {
          agh: { frozen: { scopes: Scope[]; leftOut: Record<string, number>; runs: Record<string, number> } }
        }
      }
    ).systems.agh.frozen
    expect(f.runs).toEqual({ off: 2, frozen: 3, oracle: 1 })
    expect(f.leftOut).toEqual({ off: 0, frozen: 1, oracle: 0 })
    const second = f.scopes.find((s) => s.scope === 'session 2')
    expect(second?.requests.mean).toEqual({ off: 17, frozen: 13, oracle: 10 })
    expect(second?.requests.offMinusFrozen.estimate).toBe(4)
    expect(f.scopes.map((s) => s.scope)).toEqual(['session 1', 'session 2', 'whole run'])
    expect(markdown).toContain('### Frozen lessons on a fresh run')
    expect(markdown).toContain('3 memory paragraphs, 0 user memory sections, skills: add_part_and_build')
  })

  it('is absent without frozen runs', () => {
    expect(buildReport(records.filter((r) => r.setting !== 'frozen')).markdown).not.toContain(
      'Frozen lessons',
    )
  })
})
