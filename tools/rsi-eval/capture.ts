// The capture rate: how much of what a hand-written lesson saves the second session, refinement saves.
//
// For one cost measure (requests, tokens or dollars of the second session), per task: `off` is the
// plain run, `oracle` is `off` plus the task's own lesson written to memory before the second session,
// `on` is refinement. The lesson is the most a saved experience could give, so
//
//   capture rate = sum over tasks (off - on) / sum over tasks (off - oracle)
//
// over the tasks where the lesson does save something. A sum of differences, not a mean of per-task
// ratios: a task whose `off - oracle` is near 0 would make its own ratio unstable. The exclusion looks at
// `off - oracle` only, never at `on`.
//
// Two things keep the number honest:
//
// - Which tasks have headroom is decided on runs other than the ones the sums use, when such runs are
//   given (`headroom` of a task: the pilot's `off` and `oracle` runs). Deciding on the same `off` runs
//   that the numerator then sums selects tasks whose `off` runs happened to be expensive and inflates the
//   rate. Without separate runs the same runs do both, and `headroomSource` says so: the rate is then
//   optimistic when the headroom is small.
// - The rate always comes with its numerator, its denominator, the task count and an interval from
//   resampling tasks and the runs within each arm (inclusion decided again inside every resample).
//   With 3 runs per arm the interval is wide, which is the true picture.
import { type Diff, mulberry32, pairedTaskBootstrap } from './stats.js'

export type ArmValues = { off: number[]; on: number[]; oracle: number[] }
/** `headroom`: other `off` and `oracle` runs of the task, used only to decide whether it has headroom. */
export type TaskValues = ArmValues & {
  taskId: string
  headroom?: { off: number[]; oracle: number[] }
}
export type CaptureOptions = { resamples?: number; seed?: number }

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length

/** Two-sided 95% points of Student's t by degrees of freedom; a fractional df takes the next lower row. */
const T95: readonly (readonly [number, number])[] = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [30, 2.042],
  [60, 2.0],
]
const tPoint = (df: number): number => {
  if (df >= 120) return 1.96
  let point = T95[0]?.[1] as number
  for (const [d, t] of T95) if (d <= df) point = t
  return point
}

const variance = (values: number[]): number => {
  const m = mean(values)
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1)
}

/**
 * `mean(a) - mean(b)` with a 95% interval: Welch's t interval for two sets of runs. It needs two runs on
 * each side; with fewer there is no interval and the result is null. With 3 runs per arm the interval is
 * wide (about 2.8 standard errors each way), as the evidence is.
 */
export const runsInterval = (
  a: number[],
  b: number[],
): { estimate: number; ci95: [number, number] } | null => {
  if (a.length < 2 || b.length < 2) return null
  const estimate = mean(a) - mean(b)
  const va = variance(a) / a.length
  const vb = variance(b) / b.length
  const se = Math.sqrt(va + vb)
  if (se === 0) return { estimate, ci95: [estimate, estimate] }
  const df = se ** 4 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1))
  const half = tPoint(Math.floor(df)) * se
  return { estimate, ci95: [estimate - half, estimate + half] }
}

type Judged = {
  included: string[]
  noHeadroom: string[]
  tooFewRuns: string[]
  noOnRuns: string[]
  numerator: number
  denominator: number
  /** Means over the included tasks. */
  includedMeans: { off: number | null; on: number | null; oracle: number | null }
}

const judge = (tasks: TaskValues[]): Judged => {
  const out: Judged = {
    included: [],
    noHeadroom: [],
    tooFewRuns: [],
    noOnRuns: [],
    numerator: 0,
    denominator: 0,
    includedMeans: { off: null, on: null, oracle: null },
  }
  const kept: TaskValues[] = []
  for (const t of tasks) {
    const basis = t.headroom ?? { off: t.off, oracle: t.oracle }
    const headroom = runsInterval(basis.off, basis.oracle)
    if (!headroom) {
      out.tooFewRuns.push(t.taskId)
      continue
    }
    if (!(headroom.ci95[0] > 0)) {
      out.noHeadroom.push(t.taskId)
      continue
    }
    if (t.on.length === 0 || t.off.length === 0 || t.oracle.length === 0) {
      out.noOnRuns.push(t.taskId)
      continue
    }
    out.included.push(t.taskId)
    kept.push(t)
    out.numerator += mean(t.off) - mean(t.on)
    out.denominator += mean(t.off) - mean(t.oracle)
  }
  if (kept.length > 0)
    out.includedMeans = {
      off: mean(kept.map((t) => mean(t.off))),
      on: mean(kept.map((t) => mean(t.on))),
      oracle: mean(kept.map((t) => mean(t.oracle))),
    }
  return out
}

export type CaptureResult = {
  /** Mean over tasks of the task's mean, per arm, over every task with runs of that arm; null when none. */
  means: { off: number | null; on: number | null; oracle: number | null }
  /** Paired over tasks that have runs of both arms. */
  offMinusOn: Diff
  offMinusOracle: Diff
  capture: {
    /** numerator / denominator; null when no task is left or the denominator is not above 0. */
    rate: number | null
    /** sum over the included tasks of (mean off - mean on) */
    numerator: number
    /** sum over the included tasks of (mean off - mean oracle) */
    denominator: number
    /** 95% interval of the rate from resampling tasks and runs; null when too few resamples had a rate. */
    ci95: [number, number] | null
    resamples: number
    /** Resamples in which some task had headroom and the denominator was above 0. */
    validResamples: number
    /** `separate`: headroom was decided on other runs than the sums use. `same-runs`: on the same ones; the rate is then optimistic. */
    headroomSource: 'separate' | 'same-runs'
    /** Means over the included tasks only, as against `means` over every task. */
    includedMeans: { off: number | null; on: number | null; oracle: number | null }
    included: string[]
    /** `off - oracle` does not lie above 0 (its interval includes 0, or oracle cost more). */
    noHeadroom: string[]
    /** Fewer than two `off` or two `oracle` runs to decide headroom on: no interval, so no verdict. */
    tooFewRuns: string[]
    /** Has headroom but no `on` run. */
    noOnRuns: string[]
  }
}

const armMean = (tasks: TaskValues[], arm: keyof ArmValues): number | null => {
  const means = tasks.filter((t) => t[arm].length > 0).map((t) => mean(t[arm]))
  return means.length === 0 ? null : mean(means)
}

const redraw = (values: number[], random: () => number): number[] =>
  values.map(() => values[Math.floor(random() * values.length)] as number)

export const captureMetric = (tasks: TaskValues[], options: CaptureOptions = {}): CaptureResult => {
  const paired = (a: keyof ArmValues, b: keyof ArmValues): Diff =>
    // The bootstrap's difference is `on - off` of the names it is given; ours is a minus b.
    pairedTaskBootstrap(
      tasks.map((t) => ({ taskId: t.taskId, on: t[a], off: t[b] })),
      options.resamples,
      options.seed,
    )
  const judged = judge(tasks)
  const ratio = (j: Judged): number | null =>
    j.included.length > 0 && j.denominator > 0 ? j.numerator / j.denominator : null

  // Resample tasks, and within each task the runs of each arm (and of the headroom set), then decide
  // headroom and compute the rate again in every resample.
  const resamples = options.resamples ?? 10000
  const random = mulberry32(options.seed ?? 1)
  const rates: number[] = []
  if (tasks.length > 0) {
    for (let i = 0; i < resamples; i++) {
      const drawn: TaskValues[] = tasks.map((_, k) => {
        const t = tasks[Math.floor(random() * tasks.length)] as TaskValues
        return {
          taskId: `${t.taskId}#${k}`,
          off: redraw(t.off, random),
          on: redraw(t.on, random),
          oracle: redraw(t.oracle, random),
          ...(t.headroom
            ? {
                headroom: { off: redraw(t.headroom.off, random), oracle: redraw(t.headroom.oracle, random) },
              }
            : {}),
        }
      })
      const r = ratio(judge(drawn))
      if (r !== null) rates.push(r)
    }
  }
  rates.sort((x, y) => x - y)
  const at = (p: number): number => rates[Math.min(rates.length - 1, Math.floor(p * rates.length))] as number
  const ci95: [number, number] | null =
    rates.length >= Math.max(1, resamples / 10) ? [at(0.025), at(0.975)] : null

  return {
    means: { off: armMean(tasks, 'off'), on: armMean(tasks, 'on'), oracle: armMean(tasks, 'oracle') },
    offMinusOn: paired('off', 'on'),
    offMinusOracle: paired('off', 'oracle'),
    capture: {
      rate: ratio(judged),
      numerator: judged.numerator,
      denominator: judged.denominator,
      ci95,
      resamples,
      validResamples: rates.length,
      headroomSource: tasks.some((t) => t.headroom !== undefined) ? 'separate' : 'same-runs',
      includedMeans: judged.includedMeans,
      included: judged.included,
      noHeadroom: judged.noHeadroom,
      tooFewRuns: judged.tooFewRuns,
      noOnRuns: judged.noOnRuns,
    },
  }
}
