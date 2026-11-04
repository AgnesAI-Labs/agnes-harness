import { describe, expect, it } from 'vitest'
import { mulberry32, pairedTaskBootstrap } from './stats.js'

describe('mulberry32', () => {
  it('is deterministic per seed and stays in [0, 1)', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    const xs = Array.from({ length: 5 }, () => a())
    expect(xs).toEqual(Array.from({ length: 5 }, () => b()))
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(mulberry32(8)()).not.toBe(xs[0])
  })
})

describe('pairedTaskBootstrap', () => {
  const data = [
    { taskId: 't1', on: [0.2, 0.4], off: [0.8, 0.6] },
    { taskId: 't2', on: [0, 0.2], off: [0.4, 0.6] },
    { taskId: 't3', on: [0.5], off: [0.5] },
    { taskId: 't4', on: [0.1, 0.1, 0.1], off: [0.9, 0.7, 0.8] },
  ]

  it('estimates the mean of per-task (on - off) differences', () => {
    const diff = pairedTaskBootstrap(data)
    // per-task diffs: -0.4, -0.4, 0, -0.7 -> mean -0.375
    expect(diff.estimate).toBeCloseTo(-0.375, 10)
    expect(diff.tasks).toBe(4)
    expect(diff.excludedRuns).toBe(0)
    expect(diff.ci95[0]).toBeLessThanOrEqual(diff.estimate)
    expect(diff.ci95[1]).toBeGreaterThanOrEqual(diff.estimate)
    expect(diff.ci95[0]).toBeGreaterThanOrEqual(-0.7)
    expect(diff.ci95[1]).toBeLessThanOrEqual(0)
  })

  it('reproduces the interval for a fixed seed and differs across seeds', () => {
    const one = pairedTaskBootstrap(data, 2000, 42)
    const two = pairedTaskBootstrap(data, 2000, 42)
    expect(two).toEqual(one)
    const other = pairedTaskBootstrap(data, 2000, 43)
    expect(other.estimate).toBe(one.estimate)
    expect(other.ci95).not.toEqual(one.ci95)
  })

  it('pins the interval for known data at the default seed', () => {
    const simple = [
      { taskId: 'a', on: [1], off: [0] },
      { taskId: 'b', on: [2], off: [0] },
      { taskId: 'c', on: [3], off: [0] },
    ]
    const diff = pairedTaskBootstrap(simple)
    expect(diff.estimate).toBe(2)
    // Resampled means of {1,2,3} lie in [1, 3]; the percentile bounds are attained values.
    expect(diff.ci95[0]).toBeGreaterThanOrEqual(1)
    expect(diff.ci95[1]).toBeLessThanOrEqual(3)
    expect(diff.ci95[0]).toBeLessThan(diff.ci95[1])
    expect(pairedTaskBootstrap(simple)).toEqual(diff)
  })

  it('collapses the interval to a single point when every task has the same difference', () => {
    const same = [
      { taskId: 'a', on: [0.1], off: [0.4] },
      { taskId: 'b', on: [0.3, 0.3], off: [0.6, 0.6] },
      { taskId: 'c', on: [0.2], off: [0.5] },
    ]
    const diff = pairedTaskBootstrap(same)
    expect(diff.ci95[0]).toBe(diff.ci95[1])
    expect(diff.ci95[0]).toBeCloseTo(-0.3, 10)
    expect(diff.estimate).toBeCloseTo(-0.3, 10)
  })

  it('counts runs with a null metric as excluded and drops them from the means', () => {
    const diff = pairedTaskBootstrap([
      { taskId: 'a', on: [0.5, null, null], off: [1, 1] },
      { taskId: 'b', on: [null], off: [0.5, null] },
      { taskId: 'c', on: [0.25], off: [0.75] },
    ])
    // task b has no on values left, so it is not paired; its 2 null runs still count as excluded.
    expect(diff.excludedRuns).toBe(4)
    expect(diff.tasks).toBe(2)
    // a: 0.5 - 1 = -0.5, c: 0.25 - 0.75 = -0.5
    expect(diff.estimate).toBeCloseTo(-0.5, 10)
  })

  it('returns an undefined estimate when no task can be paired', () => {
    const diff = pairedTaskBootstrap([{ taskId: 'a', on: [null], off: [1] }])
    expect(diff.tasks).toBe(0)
    expect(Number.isNaN(diff.estimate)).toBe(true)
    expect(diff.excludedRuns).toBe(1)
  })
})
