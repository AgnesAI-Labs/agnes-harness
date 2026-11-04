// The capture rate: how much of what a hand-written lesson saves the second session, refinement saves.
//
// For one cost measure (requests, tokens or dollars of the second session), per task: `off` is the
// plain run, `oracle` is `off` plus the task's own lesson written to memory before the second session,
// `on` is refinement. The lesson is the most a saved experience could give, so
//
//   capture rate = sum over tasks (off - on) / sum over tasks (off - oracle)
//
// over the tasks where the lesson does save something: those whose `off - oracle` 95% interval lies
// above 0. A sum of differences, not a mean of per-task ratios: a task whose `off - oracle` is near 0
// would make its own ratio unstable. The exclusion looks at `off - oracle` only, never at `on`.
import { type Diff, mulberry32, pairedTaskBootstrap } from './stats.js'

export type ArmValues = { off: number[]; on: number[]; oracle: number[] }
export type TaskValues = ArmValues & { taskId: string }
export type CaptureOptions = { resamples?: number; seed?: number }

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length

/**
 * `mean(a) - mean(b)` with a 95% interval from resampling the runs of each side with replacement
 * (seeded). Needs two runs on each side; with fewer there is no interval and the result is null.
 */
export const runsInterval = (
  a: number[],
  b: number[],
  options: CaptureOptions = {},
): { estimate: number; ci95: [number, number] } | null => {
  if (a.length < 2 || b.length < 2) return null
  const resamples = options.resamples ?? 10000
  const random = mulberry32(options.seed ?? 1)
  const draw = (values: number[]): number => {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)] as number
    return sum / values.length
  }
  const diffs: number[] = []
  for (let i = 0; i < resamples; i++) diffs.push(draw(a) - draw(b))
  diffs.sort((x, y) => x - y)
  const at = (p: number): number => diffs[Math.min(diffs.length - 1, Math.floor(p * diffs.length))] as number
  return { estimate: mean(a) - mean(b), ci95: [at(0.025), at(0.975)] }
}

export type CaptureResult = {
  /** Mean over tasks of the task's mean, per arm; null when no task has a run of that arm. */
  means: { off: number | null; on: number | null; oracle: number | null }
  /** Paired over tasks that have runs of both arms. */
  offMinusOn: Diff
  offMinusOracle: Diff
  capture: {
    /** null when no task is left, or the sum of `off - oracle` is not above 0. */
    rate: number | null
    included: string[]
    /** `off - oracle` does not lie above 0 (its interval includes 0, or oracle cost more). */
    noHeadroom: string[]
    /** Fewer than two `off` or two `oracle` runs: no interval, so no verdict on headroom. */
    tooFewRuns: string[]
    /** Has headroom but no `on` run. */
    noOnRuns: string[]
  }
}

const armMean = (tasks: TaskValues[], arm: keyof ArmValues): number | null => {
  const means = tasks.filter((t) => t[arm].length > 0).map((t) => mean(t[arm]))
  return means.length === 0 ? null : mean(means)
}

export const captureMetric = (tasks: TaskValues[], options: CaptureOptions = {}): CaptureResult => {
  const paired = (a: keyof ArmValues, b: keyof ArmValues): Diff =>
    // The bootstrap's difference is `on - off` of the names it is given; ours is a minus b.
    pairedTaskBootstrap(
      tasks.map((t) => ({ taskId: t.taskId, on: t[a], off: t[b] })),
      options.resamples,
      options.seed,
    )
  const included: string[] = []
  const noHeadroom: string[] = []
  const tooFewRuns: string[] = []
  const noOnRuns: string[] = []
  let saved = 0
  let ceiling = 0
  for (const t of tasks) {
    const headroom = runsInterval(t.off, t.oracle, options)
    if (!headroom) {
      tooFewRuns.push(t.taskId)
      continue
    }
    if (!(headroom.ci95[0] > 0)) {
      noHeadroom.push(t.taskId)
      continue
    }
    if (t.on.length === 0) {
      noOnRuns.push(t.taskId)
      continue
    }
    included.push(t.taskId)
    saved += mean(t.off) - mean(t.on)
    ceiling += mean(t.off) - mean(t.oracle)
  }
  return {
    means: { off: armMean(tasks, 'off'), on: armMean(tasks, 'on'), oracle: armMean(tasks, 'oracle') },
    offMinusOn: paired('off', 'on'),
    offMinusOracle: paired('off', 'oracle'),
    capture: {
      rate: included.length > 0 && ceiling > 0 ? saved / ceiling : null,
      included,
      noHeadroom,
      tooFewRuns,
      noOnRuns,
    },
  }
}
