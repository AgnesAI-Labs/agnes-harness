import { PerformanceObserver, performance } from 'node:perf_hooks'

export const dataset: Readonly<{ packages: number; files: number; bytesPerFile: number; runs: number }> =
  Object.freeze({ packages: 20, files: 200, bytesPerFile: 1024, runs: 3 })

// Conservative serial-runner ceilings, not performance claims. Change only with reviewed evidence.
export const budgets = Object.freeze({
  inventoryCold: 10_000,
  inventoryWarm: 10_000,
  snapshotsCold: 10_000,
  snapshotsWarm: 10_000,
  prepareCold: 15_000,
  prepareWarm: 10_000,
  readonlyCold: 10_000,
  readonlyWarm: 10_000,
  surfaceChanged: 1_000,
})
export type Stage = keyof typeof budgets
export type Sample = Readonly<{
  wallMs: number
  loopLagMs: number
  peakRssMiB: number
  rssGrowthMiB: number
  /** Reported beside loopLagMs, not budgeted: the longest and total garbage-collection pause. */
  gcMaxMs: number
  gcTotalMs: number
}>
export const resourceBudget = Object.freeze({ loopLagMs: 250, peakRssMiB: 1536, rssGrowthMiB: 256 })

/** Includes the final synchronous segment even if the timer never got a chance to run. */
export async function measure<T>(work: () => Promise<T>): Promise<{ value: T; sample: Sample }> {
  const startRss = process.memoryUsage().rss
  let peakRss = startRss
  let last = performance.now()
  let loopLagMs = 0
  const observe = () => {
    const now = performance.now()
    loopLagMs = Math.max(loopLagMs, now - last)
    last = now
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }
  const probe = setInterval(observe, 1)
  // A loop-lag spike is either this stage's synchronous work or a collector pause; record both.
  const pauses: number[] = []
  const collector = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) pauses.push(entry.duration)
  })
  collector.observe({ entryTypes: ['gc'] })
  const start = performance.now()
  try {
    const value = await work()
    const wallMs = performance.now() - start
    observe()
    for (const entry of collector.takeRecords()) pauses.push(entry.duration)
    return {
      value,
      sample: {
        wallMs,
        loopLagMs,
        // maxRSS is KiB on Node's supported platforms; includes setup/import high water too.
        peakRssMiB: Math.max(peakRss / 1024 / 1024, process.resourceUsage().maxRSS / 1024),
        rssGrowthMiB: Math.max(0, peakRss - startRss) / 1024 / 1024,
        gcMaxMs: Math.max(0, ...pauses),
        gcTotalMs: pauses.reduce((sum, pause) => sum + pause, 0),
      },
    }
  } finally {
    clearInterval(probe)
    collector.disconnect()
  }
}

/** Reject missing/invalid measurements as well as every individual over-budget run. */
export function assertBudget(stage: Stage, sample: Sample): void {
  const limits = { wallMs: budgets[stage], ...resourceBudget }
  for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
    const value = sample[key]
    if (!Number.isFinite(value) || value < 0 || value > limits[key])
      throw new Error(`${stage}.${key}: ${value} exceeds or invalidates budget ${limits[key]}`)
  }
}
