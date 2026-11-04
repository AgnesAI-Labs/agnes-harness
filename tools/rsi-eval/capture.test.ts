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
  it('is the difference of the means with a seeded 95% interval', () => {
    const d = runsInterval([24, 26, 25], [14, 16, 15], { seed: 7 })
    expect(d?.estimate).toBe(10)
    expect(d?.ci95[0]).toBeGreaterThan(5)
    expect(d?.ci95[1]).toBeLessThan(15)
    expect(runsInterval([24, 26, 25], [14, 16, 15], { seed: 7 })).toEqual(d)
  })
  it('does not exist for fewer than two runs on a side', () => {
    expect(runsInterval([24], [14, 16], {})).toBeNull()
    expect(runsInterval([24, 25], [14], {})).toBeNull()
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
