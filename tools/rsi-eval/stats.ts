// Paired bootstrap over tasks. Pure and deterministic: a seeded generator, no I/O.

export type Diff = { estimate: number; ci95: [number, number]; tasks: number; excludedRuns: number }

/** Small seeded generator; the same seed always yields the same sequence in [0, 1). */
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length

/**
 * Per-task difference is mean(on) - mean(off). Callers who want "off - on" pass the arrays swapped.
 * `null` entries are runs whose metric is undefined (for example a session that never hit the trap):
 * they are left out of the means and counted in `excludedRuns`. A task needs at least one defined value
 * on each side to be paired. Tasks are resampled with replacement; the interval is the 2.5th and 97.5th
 * percentile of the resampled mean difference.
 */
export const pairedTaskBootstrap = (
  perTask: { taskId: string; on: (number | null)[]; off: (number | null)[] }[],
  resamples = 10000,
  seed = 1,
): Diff => {
  let excludedRuns = 0
  const diffs: number[] = []
  for (const task of perTask) {
    const on = task.on.filter((v): v is number => v !== null)
    const off = task.off.filter((v): v is number => v !== null)
    excludedRuns += task.on.length - on.length + (task.off.length - off.length)
    if (on.length > 0 && off.length > 0) diffs.push(mean(on) - mean(off))
  }
  const first = diffs[0]
  if (first === undefined) {
    return { estimate: Number.NaN, ci95: [Number.NaN, Number.NaN], tasks: 0, excludedRuns }
  }
  // Identical differences resample to themselves; skip the loop so rounding cannot widen the interval.
  if (diffs.every((d) => Math.abs(d - first) < 1e-12)) {
    return { estimate: first, ci95: [first, first], tasks: diffs.length, excludedRuns }
  }
  const random = mulberry32(seed)
  const n = diffs.length
  const means: number[] = []
  for (let i = 0; i < resamples; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) sum += diffs[Math.floor(random() * n)] as number
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const at = (p: number): number => means[Math.min(means.length - 1, Math.floor(p * means.length))] as number
  return { estimate: mean(diffs), ci95: [at(0.025), at(0.975)], tasks: n, excludedRuns }
}
