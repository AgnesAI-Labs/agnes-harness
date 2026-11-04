import { describe, expect, it } from 'vitest'
import { buildReport } from './report.js'
import type { RunRecord, SessionCost } from './types.js'

// Records for the report section. Each run's `sessionCosts` stands in for what `sessionCostOfLedger`
// reads from a ledger (tested on real ledgers in session-cost.test.ts); here only the section's rules
// are under test: which runs enter, and what the three arms and the capture rate are.
const cost = (requests: number, lowerBound = false): SessionCost => ({
  requests,
  tokens: requests * 6000,
  cost: requests / 1000,
  lowerBound,
})
const run = (
  taskId: string,
  setting: RunRecord['setting'],
  rep: number,
  sessions: SessionCost[],
  over: Partial<RunRecord> = {},
): RunRecord => ({
  system: 'agh',
  taskId,
  category: 'cross-session',
  setting,
  rep,
  exit: 'ok',
  windows: [],
  refine: { auto: 0, user: 0, self: 0, appliedEdits: 0 },
  harnessLookups: 0,
  compactions: 0,
  usage: { requests: 0, unknown: 0, tokens: 0, costUsd: 0 },
  sessionCosts: sessions,
  ...over,
})

/** Three runs of an arm of one task: the first session always costs 30, the second as given. */
const arm = (
  taskId: string,
  setting: RunRecord['setting'],
  second: number[],
  over: Partial<RunRecord> = {},
) => second.map((requests, i) => run(taskId, setting, i + 1, [cost(30), cost(requests)], over))

type Diff = { estimate: number | null; ci95: [number | null, number | null] }
type Measure = {
  mean: { off: number | null; on: number | null; oracle: number | null }
  offMinusOn: Diff
  offMinusOracle: Diff
  captureRate: number | null
  included: string[]
  noHeadroom: string[]
}
type Second = {
  tasks: number
  runs: { off: number; on: number; oracle: number }
  lowerBoundRuns: number
  measures: Record<'requests' | 'tokens' | 'cost', Measure>
}

const section = (records: RunRecord[]) => {
  const { json, markdown } = buildReport(records, { resamples: 300 })
  const agh = (json as { systems: { agh: { secondSession?: Second } } }).systems.agh
  return { second: agh.secondSession, markdown }
}

describe('the second-session section of the report', () => {
  const records = [
    ...arm('cross-a', 'off', [24, 26, 25]),
    ...arm('cross-a', 'on', [24, 26, 25]),
    ...arm('cross-a', 'oracle', [14, 16, 15]),
    ...arm('cross-b', 'off', [20, 22, 21]),
    ...arm('cross-b', 'on', [20, 22, 21]),
    ...arm('cross-b', 'oracle', [12, 14, 13]),
  ]

  it('reports the three arms side by side, the two differences with intervals, and the capture rate', () => {
    const { second, markdown } = section(records)
    expect(second?.tasks).toBe(2)
    expect(second?.runs).toEqual({ off: 6, on: 6, oracle: 6 })
    expect(second?.measures.requests.mean).toEqual({ off: 23, on: 23, oracle: 14 })
    expect(second?.measures.requests.offMinusOracle.estimate).toBe(9)
    expect(second?.measures.requests.offMinusOracle.ci95[0]).toBeGreaterThan(0)
    expect(second?.measures.requests.offMinusOn.estimate).toBe(0)
    expect(second?.measures.requests.captureRate).toBe(0)
    expect(second?.measures.tokens.mean.off).toBe(23 * 6000)
    expect(markdown).toContain('### 4. Second-session cost and capture rate')
  })

  it('counts a task with no headroom and leaves it out of the rate', () => {
    const flat = [
      ...arm('cross-flat', 'off', [20, 22, 21]),
      ...arm('cross-flat', 'on', [10, 10, 10]),
      ...arm('cross-flat', 'oracle', [21, 20, 22]),
    ]
    const { second, markdown } = section([...records, ...flat])
    expect(second?.measures.requests.noHeadroom).toEqual(['cross-flat'])
    expect(second?.measures.requests.included).toEqual(['cross-a', 'cross-b'])
    expect(second?.measures.requests.captureRate).toBe(0)
    expect(markdown).toContain('No headroom')
    expect(markdown).toContain('cross-flat')
  })

  it('uses the second session only: the first session and the refinement overhead in it do not enter', () => {
    const heavyFirst = records.map((r) => ({
      ...r,
      sessionCosts: [cost(r.setting === 'on' ? 90 : 30), r.sessionCosts?.[1] as SessionCost],
    }))
    expect(section(heavyFirst).second?.measures.requests.captureRate).toBe(0)
  })

  it('has no section for single-session tasks, which have no second session', () => {
    const single = [
      ...['off', 'on'].flatMap((s) =>
        [1, 2, 3].map((rep) => run('dir-a', s as 'on', rep, [cost(30)], { category: 'directory' as const })),
      ),
    ]
    const { second, markdown } = section(single)
    expect(second).toBeUndefined()
    expect(markdown).not.toContain('Second-session')
  })

  it('leaves workflow tasks out', () => {
    const wf = records.map((r) => ({ ...r, category: 'workflow' as const }))
    expect(section(wf).second).toBeUndefined()
  })

  it('says so when the second sessions are lower bounds', () => {
    const bounded = records.map((r) => ({
      ...r,
      sessionCosts: [cost(30), cost(r.sessionCosts?.[1]?.requests ?? 0, true)],
    }))
    const { second, markdown } = section(bounded)
    expect(second?.lowerBoundRuns).toBe(18)
    expect(markdown).toContain('lower bounds')
  })

  it('shows the off/on pair and no capture rate when there are no oracle runs', () => {
    const { second, markdown } = section(records.filter((r) => r.setting !== 'oracle'))
    expect(second?.runs.oracle).toBe(0)
    expect(second?.measures.requests.captureRate).toBeNull()
    expect(second?.measures.requests.mean.oracle).toBeNull()
    expect(markdown).toContain('No oracle runs')
  })

  it('leaves the numbers of the on/off metrics as they were: oracle runs enter none of them', () => {
    const withOracle = buildReport(records, { resamples: 200 }).json as { systems: { agh: object } }
    const without = buildReport(
      records.filter((r) => r.setting !== 'oracle'),
      { resamples: 200 },
    ).json as { systems: { agh: object } }
    const strip = (r: object) => {
      const { secondSession: _s, ...rest } = r as Record<string, unknown>
      return rest
    }
    expect(strip(withOracle.systems.agh)).toEqual(strip(without.systems.agh))
  })
})
