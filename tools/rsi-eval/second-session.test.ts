import { describe, expect, it } from 'vitest'
import { assertSeparateRuns, buildReport, type ReportOptions } from './report.js'
import type { PromptWindow, RunRecord, SessionCost } from './types.js'

// Records for the report section. Each run's `sessionCosts` stands in for what `sessionCostOfLedger`
// reads from a ledger (tested on real ledgers in session-cost.test.ts); here only the section's rules
// are under test: which runs enter, and what the three arms and the capture rate are.
const cost = (requests: number, review = 0, lowerBound = false): SessionCost => ({
  requests,
  tokens: requests * 6000,
  cost: requests / 1000,
  lowerBound,
  refinement: { requests: review, tokens: review * 6000, cost: review / 1000 },
})
const win = (session: number, prompt: number, over: Partial<PromptWindow> = {}): PromptWindow => ({
  session,
  prompt,
  ran: true,
  trapHit: false,
  checksPassed: true,
  ...over,
})
const windows = (): PromptWindow[] => [0, 1].flatMap((s) => [0, 1, 2].map((p) => win(s, p)))

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
  windows: windows(),
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
  review = 0,
) => second.map((requests, i) => run(taskId, setting, i + 1, [cost(30), cost(requests, review)], over))

type Diff = { estimate: number | null; ci95: [number | null, number | null] }
type Measure = {
  mean: { off: number | null; on: number | null; oracle: number | null }
  offMinusOn: Diff
  offMinusOracle: Diff
  captureRate: number | null
  numerator: number
  denominator: number
  captureCi95: [number, number] | null
  headroomSource: 'separate' | 'same-runs'
  includedMeans: { off: number | null; on: number | null; oracle: number | null }
  included: string[]
  noHeadroom: string[]
}
type Second = {
  tasks: number
  runs: { off: number; on: number; oracle: number }
  leftOut: Record<'off' | 'on' | 'oracle', Record<string, number>>
  lowerBoundRuns: number
  headroomRuns: number | null
  reviewOverhead: { runs: number; requests: number | null; tokens: number | null; cost: number | null }
  measures: Record<'requests' | 'tokens' | 'cost' | 'requestsMain' | 'tokensMain' | 'costMain', Measure>
}

const section = (records: RunRecord[], options: ReportOptions = {}) => {
  const { json, markdown } = buildReport(records, { resamples: 300, ...options })
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

  it('reports the three arms side by side, the two differences with intervals, and the capture rate with its parts', () => {
    const { second, markdown } = section(records)
    expect(second?.tasks).toBe(2)
    expect(second?.runs).toEqual({ off: 6, on: 6, oracle: 6 })
    const m = second?.measures.requests as Measure
    expect(m.mean).toEqual({ off: 23, on: 23, oracle: 14 })
    expect(m.offMinusOracle.estimate).toBe(9)
    expect(m.offMinusOracle.ci95[0]).toBeGreaterThan(0)
    expect(m.offMinusOn.estimate).toBe(0)
    expect(m.captureRate).toBe(0)
    expect(m.numerator).toBe(0)
    expect(m.denominator).toBe(18)
    expect(m.captureCi95).not.toBeNull()
    expect(second?.measures.tokens.mean.off).toBe(23 * 6000)
    expect(markdown).toContain('### 4. Cost after the first session and capture rate')
    // Never a bare number: the parts, the task count and the interval stand next to the rate.
    expect(markdown).toMatch(/0\.000 = 0\.0 \/ 18\.0 over 2 of 2 tasks; 95% CI /)
  })

  it('says that headroom and rate use the same runs, and that the rate is then optimistic', () => {
    const { second, markdown } = section(records)
    expect(second?.measures.requests.headroomSource).toBe('same-runs')
    expect(second?.headroomRuns).toBeNull()
    expect(markdown).toContain('use the SAME off runs')
    expect(markdown).toContain('optimistic')
  })

  it('decides headroom on the pilot runs when they are given, and names how many it used', () => {
    // On this run's own off runs the task `lucky` looks like it has headroom; the pilot's runs say it has none.
    const lucky = [
      ...arm('cross-lucky', 'off', [30, 31, 29]),
      ...arm('cross-lucky', 'on', [30, 31, 29]),
      ...arm('cross-lucky', 'oracle', [20, 21, 19]),
    ]
    const pilot = [
      ...arm('cross-a', 'off', [25, 24, 26]),
      ...arm('cross-a', 'oracle', [15, 14, 16]),
      ...arm('cross-b', 'off', [21, 20, 22]),
      ...arm('cross-b', 'oracle', [13, 12, 14]),
      ...arm('cross-lucky', 'off', [20, 21, 19]),
      ...arm('cross-lucky', 'oracle', [20, 19, 21]),
    ]
    const same = section([...records, ...lucky])
    expect(same.second?.measures.requests.included).toContain('cross-lucky')
    const separate = section([...records, ...lucky], { headroomRecords: pilot })
    const m = separate.second?.measures.requests as Measure
    expect(m.headroomSource).toBe('separate')
    expect(m.included).toEqual(['cross-a', 'cross-b'])
    expect(m.noHeadroom).toEqual(['cross-lucky'])
    expect(separate.second?.headroomRuns).toBe(18)
    expect(separate.markdown).toContain('decided on separate runs')
    expect(separate.markdown).not.toContain('use the SAME off runs')
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
    expect(markdown).toContain('without headroom')
    expect(markdown).toContain('cross-flat')
  })

  it('uses the second session only: the first session and the refinement overhead in it do not enter', () => {
    const heavyFirst = records.map((r) => ({
      ...r,
      sessionCosts: [cost(r.setting === 'on' ? 90 : 30), r.sessionCosts?.[1] as SessionCost],
    }))
    expect(section(heavyFirst).second?.measures.requests.captureRate).toBe(0)
  })

  it('sums every session after the first for a long task of several, and leaves out a run that stopped early', () => {
    // Five sessions in one workspace: what sessions 2 to 5 cost together is what a lesson can change.
    const long = (
      setting: RunRecord['setting'],
      rep: number,
      later: number[],
      over: Partial<RunRecord> = {},
    ) =>
      run('long-a', setting, rep, [cost(30), ...later.map((n) => cost(n))], {
        category: 'long',
        windows: [0, 1, 2, 3, 4].flatMap((s) => [0, 1].map((p) => win(s, p))),
        ...over,
      })
    const runs = [1, 2, 3].flatMap((rep) => [
      long('off', rep, [10, 10, 10, 10 + rep]),
      long('on', rep, [9, 9, 9, 9 + rep]),
      long('oracle', rep, [5, 5, 5, 5 + rep]),
    ])
    // Stopped at a milestone of session 3: sessions 4 and 5 never ran, so it says nothing about the cost.
    const stopped = long('off', 4, [2, 2], {
      exit: 'error',
      windows: [0, 1, 2, 3, 4].flatMap((s) => [0, 1].map((p) => win(s, p, s < 3 ? {} : { ran: false }))),
    })
    const { second } = section([...runs, stopped])
    const m = second?.measures.requests as Measure
    expect(m.mean).toEqual({ off: 42, on: 38, oracle: 22 })
    expect(m.offMinusOracle.estimate).toBe(20)
    expect(m.captureRate).toBeCloseTo(0.2)
    expect(second?.runs).toEqual({ off: 3, on: 3, oracle: 3 })
    expect(second?.leftOut.off['exit-error']).toBe(1)
  })

  it('shows the main-lane figures apart from the review calls of the on arm', () => {
    // On costs 4 more requests in the second session, all of them review calls.
    const withReview = [
      ...arm('cross-a', 'off', [24, 26, 25]),
      ...arm(
        'cross-a',
        'on',
        [24, 26, 25].map((n) => n + 4),
        {},
        4,
      ),
      ...arm('cross-a', 'oracle', [14, 16, 15]),
    ]
    const { second, markdown } = section(withReview)
    expect(second?.measures.requests.mean.on).toBe(29)
    expect(second?.measures.requestsMain.mean.on).toBe(25)
    expect(second?.measures.requestsMain.offMinusOn.estimate).toBe(0)
    expect(second?.measures.requests.offMinusOn.estimate).toBe(-4)
    expect(second?.reviewOverhead).toMatchObject({ runs: 3, requests: 4, tokens: 24000, cost: 0.004 })
    expect(markdown).toContain('Review calls of the on arm')
  })

  it('has no section for single-session tasks, which have no second session', () => {
    const single = [
      ...['off', 'on'].flatMap((s) =>
        [1, 2, 3].map((rep) =>
          run('dir-a', s as 'on', rep, [cost(30)], {
            category: 'directory' as const,
            windows: [win(0, 0), win(0, 1), win(0, 2)],
          }),
        ),
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

  it('keeps out second sessions that failed, timed out or failed a check, and counts them per arm and reason', () => {
    // A cheap, failed `on` run would lower the on mean; a timed-out one would raise it.
    const failed = run('cross-a', 'on', 4, [cost(30), cost(3)], { exit: 'error' })
    const timedOut = run('cross-a', 'on', 5, [cost(30), cost(80)], { exit: 'timeout' })
    const unchecked = run('cross-a', 'oracle', 4, [cost(30), cost(2)], {
      windows: windows().map((w) => (w.session === 1 && w.prompt === 2 ? { ...w, checksPassed: false } : w)),
    })
    const never = run('cross-a', 'off', 4, [cost(30)], { exit: 'error' })
    const noisy = section([...records, failed, timedOut, unchecked, never])
    const clean = section(records)
    expect(noisy.second?.measures).toEqual(clean.second?.measures)
    expect(noisy.second?.runs).toEqual(clean.second?.runs)
    expect(noisy.second?.leftOut.on).toMatchObject({ 'exit-error': 1, timeout: 1 })
    expect(noisy.second?.leftOut.oracle).toMatchObject({ 'checks-failed': 1 })
    expect(noisy.second?.leftOut.off).toMatchObject({ 'never-reached': 1 })
    expect(noisy.markdown).toContain('left out of the means and the rate, per arm')
    expect(noisy.markdown).toContain('1 the run timed out')
  })

  it('says so when the second sessions are lower bounds', () => {
    const bounded = records.map((r) => ({
      ...r,
      sessionCosts: [cost(30), cost(r.sessionCosts?.[1]?.requests ?? 0, 0, true)],
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
      // The two sections that report the oracle arm of their own.
      const { secondSession: _s, firstSessionTrap: _t, ...rest } = r as Record<string, unknown>
      return rest
    }
    expect(strip(withOracle.systems.agh)).toEqual(strip(without.systems.agh))
  })

  it('refuses headroom runs that are runs of the report itself, but not another run with the same id', () => {
    const at = (startedAt: string) => run('cross-a', 'off', 1, [cost(30), cost(25)], { startedAt })
    expect(() =>
      assertSeparateRuns([at('2026-11-05T10:00:00.000Z')], [at('2026-11-05T10:00:00.000Z')]),
    ).toThrow(/both the report's folder and the headroom folder/)
    // The pilot's r1 and the full run's r1 share an id and are different runs.
    expect(() =>
      assertSeparateRuns([at('2026-11-05T10:00:00.000Z')], [at('2026-11-04T09:00:00.000Z')]),
    ).not.toThrow()
  })
})
