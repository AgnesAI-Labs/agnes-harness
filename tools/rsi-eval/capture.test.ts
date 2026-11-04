import { describe, expect, it } from 'vitest'
import { captureMetric, runsInterval, type TaskValues } from './capture.js'

// Arithmetic on small sets of second-session request counts (the magnitudes are those of the first
// evaluation's second sessions, 15 to 25 requests). There are no recorded oracle runs yet, so these
// sets stand for the three arms; the point is the rule, not the numbers.
const task = (taskId: string, off: number[], on: number[], oracle: number[]): TaskValues => ({
  taskId,
  off,
  on,
  oracle,
})

const savings = [
  task('a', [24, 26, 25], [24, 26, 25], [14, 16, 15]),
  task('b', [20, 22, 21], [20, 22, 21], [12, 14, 13]),
]

describe('the interval of a difference of two sets of runs', () => {
  it('is the difference of the means with a Welch t interval, wide for three runs a side', () => {
    const d = runsInterval([24, 26, 25], [14, 16, 15])
    expect(d?.estimate).toBe(10)
    // Each side has variance 1, so se = sqrt(2/3) and about 4 degrees of freedom: t = 2.776.
    const half = 2.776 * Math.sqrt(2 / 3)
    expect(d?.ci95[0]).toBeCloseTo(10 - half, 6)
    expect(d?.ci95[1]).toBeCloseTo(10 + half, 6)
  })
  it('is a point when the runs of both sides do not vary', () => {
    expect(runsInterval([20, 20, 20], [19, 19, 19])).toEqual({ estimate: 1, ci95: [1, 1] })
  })
  it('does not exist for fewer than two runs on a side', () => {
    expect(runsInterval([24], [14, 16])).toBeNull()
    expect(runsInterval([24, 25], [14])).toBeNull()
  })
})

describe('the capture rate comes with its parts and its uncertainty', () => {
  const some = [
    task('a', [24, 26, 25], [19, 21, 20], [14, 16, 15]),
    task('b', [20, 22, 21], [19, 21, 20], [12, 14, 13]),
  ]

  it('gives the numerator, the denominator, the task count and an interval of the ratio', () => {
    const r = captureMetric(some, { resamples: 400, seed: 5 })
    expect(r.capture.numerator).toBeCloseTo(6, 12)
    expect(r.capture.denominator).toBeCloseTo(18, 12)
    expect(r.capture.rate).toBeCloseTo(6 / 18, 12)
    expect(r.capture.included).toEqual(['a', 'b'])
    const ci = r.capture.ci95
    expect(ci).not.toBeNull()
    expect(ci?.[0]).toBeLessThan(6 / 18)
    expect(ci?.[1]).toBeGreaterThan(6 / 18)
    expect(r.capture.validResamples).toBeGreaterThan(0)
    // The same input gives the same interval.
    expect(captureMetric(some, { resamples: 400, seed: 5 }).capture.ci95).toEqual(ci)
  })

  it('has no interval when no resample has a task with headroom', () => {
    const r = captureMetric([task('flat', [20, 22, 21], [10, 10, 10], [21, 20, 22])], { resamples: 100 })
    expect(r.capture).toMatchObject({ rate: null, ci95: null })
  })

  it('says which runs decided headroom, and takes the decision from the other runs when it is given', () => {
    // On the sums' own runs, task `lucky` looks like it has headroom (oracle far below off) ...
    const lucky = task('lucky', [30, 31, 29], [30, 31, 29], [20, 21, 19])
    const same = captureMetric([...some, lucky])
    expect(same.capture.headroomSource).toBe('same-runs')
    expect(same.capture.included).toContain('lucky')
    // ... but the pilot's runs of that task show none: it is left out, and a task the pilot confirms stays.
    const separate = captureMetric([
      { ...(some[0] as TaskValues), headroom: { off: [25, 24, 26], oracle: [15, 14, 16] } },
      { ...lucky, headroom: { off: [20, 21, 19], oracle: [20, 19, 21] } },
    ])
    expect(separate.capture.headroomSource).toBe('separate')
    expect(separate.capture.included).toEqual(['a'])
    expect(separate.capture.noHeadroom).toEqual(['lucky'])
    // The sums still use the runs of the full run only.
    expect(separate.capture.numerator).toBeCloseTo(5, 12)
  })

  it('cannot judge a task with fewer than two pilot runs, and says so', () => {
    const r = captureMetric([{ ...(some[0] as TaskValues), headroom: { off: [25], oracle: [15, 14] } }])
    expect(r.capture.tooFewRuns).toEqual(['a'])
  })

  it('reports means over the included tasks next to the means over every task', () => {
    const flat = task('flat', [50, 52, 51], [50, 52, 51], [51, 50, 52])
    const r = captureMetric([...some, flat])
    expect(r.means.off).toBeCloseTo((25 + 21 + 51) / 3, 12)
    expect(r.capture.includedMeans).toEqual({ off: 23, on: 20, oracle: 14 })
  })
})

describe('the capture rate', () => {
  it('is 0 when refinement costs what the plain run costs', () => {
    const r = captureMetric(savings)
    expect(r.capture.rate).toBe(0)
    expect(r.capture.included).toEqual(['a', 'b'])
  })

  it('is 1 when refinement costs what the hand-written lesson costs', () => {
    const r = captureMetric(savings.map((t) => ({ ...t, on: t.oracle })))
    expect(r.capture.rate).toBe(1)
  })

  it('is the sum of the savings over the sum of the ceilings, not a mean of ratios', () => {
    // a: off 25, on 20, oracle 15 -> 5 of 10. b: off 21, on 20, oracle 13 -> 1 of 8. Sum: 6 of 18.
    const r = captureMetric([
      task('a', [24, 26, 25], [19, 21, 20], [14, 16, 15]),
      task('b', [20, 22, 21], [19, 21, 20], [12, 14, 13]),
    ])
    expect(r.capture.rate).toBeCloseTo(6 / 18, 12)
  })

  it('leaves out a task whose hand-written lesson saves nothing, and counts it', () => {
    const flat = task('flat', [20, 22, 21], [10, 10, 10], [21, 20, 22])
    const r = captureMetric([...savings, flat])
    expect(r.capture.noHeadroom).toEqual(['flat'])
    expect(r.capture.included).toEqual(['a', 'b'])
    // The excluded task's own `on` (a big saving) does not enter the rate.
    expect(r.capture.rate).toBe(0)
  })

  it('leaves out a task where the lesson costs more than the plain run', () => {
    const worse = task('worse', [10, 11, 10], [10, 11, 10], [30, 32, 31])
    expect(captureMetric([...savings, worse]).capture.noHeadroom).toEqual(['worse'])
  })

  it('gives no rate when no task has headroom, and does not call it a pass', () => {
    const r = captureMetric([task('flat', [20, 22, 21], [10, 10, 10], [21, 20, 22])])
    expect(r.capture).toMatchObject({ rate: null, included: [], noHeadroom: ['flat'] })
  })

  it('cannot judge headroom from fewer than two runs of off or oracle', () => {
    const r = captureMetric([task('thin', [20], [20, 21], [10, 11]), task('thin2', [20, 21], [20], [10])])
    expect(r.capture.tooFewRuns).toEqual(['thin', 'thin2'])
    expect(r.capture.rate).toBeNull()
  })

  it('leaves out a task with headroom but no refinement run', () => {
    const r = captureMetric([...savings, task('lone', [20, 22, 21], [], [12, 14, 13])])
    expect(r.capture.noOnRuns).toEqual(['lone'])
    expect(r.capture.included).toEqual(['a', 'b'])
  })

  it('reports each arm and the two differences, off minus the other arm', () => {
    const r = captureMetric(savings, { seed: 3 })
    expect(r.means).toEqual({ off: 23, on: 23, oracle: 14 })
    expect(r.offMinusOn.estimate).toBe(0)
    expect(r.offMinusOracle.estimate).toBe(9)
    expect(r.offMinusOracle.tasks).toBe(2)
    expect(r.offMinusOracle.ci95[0]).toBeGreaterThan(0)
  })
})
