import { performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import { createFixture } from './package-load/fixture.js'
import { assertBudget, budgets, measure, type Sample } from './package-load/metrics.js'
import { assertTamperRefused, runPackageLoad } from './package-load/run.js'

it('executes the real package-load benchmark path at smoke scale and refuses warm/fresh tampering', async () => {
  const f = await createFixture({ packages: 1, files: 1, bytesPerFile: 32 })
  try {
    const { results } = await runPackageLoad(f, 0)
    expect(Object.keys(results).sort()).toEqual(
      Object.keys(budgets)
        .filter((key) => key !== 'surfaceChanged')
        .sort(),
    )
    for (const sample of Object.values(results)) {
      expect(sample.wallMs).toBeGreaterThan(0)
      expect(sample.loopLagMs).toBeGreaterThan(0)
      expect(sample.peakRssMiB).toBeGreaterThan(0)
    }
    await assertTamperRefused(f)
  } finally {
    await f.close()
  }
})

it('fails each budget dimension and nonfinite/missing measurements instead of only logging them', () => {
  const sample: Sample = { wallMs: 1, loopLagMs: 1, peakRssMiB: 100, rssGrowthMiB: 0 }
  expect(() => assertBudget('prepareCold', sample)).not.toThrow()
  for (const key of Object.keys(sample) as (keyof Sample)[]) {
    for (const value of [100_000, Number.NaN, Number.POSITIVE_INFINITY, -1, undefined])
      expect(() => assertBudget('prepareCold', { ...sample, [key]: value } as Sample)).toThrow(key)
  }
  expect(() => assertBudget('surfaceChanged', { ...sample, wallMs: 1001 })).toThrow('surfaceChanged.wallMs')
})

it('records a synchronous final segment and releases its probe on success and failure', async () => {
  vi.useFakeTimers()
  const now = vi.spyOn(performance, 'now')
  try {
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(40).mockReturnValueOnce(40)
    const { value, sample } = await measure(async () => 'loaded')
    expect(value).toBe('loaded')
    expect(sample.wallMs).toBe(40)
    expect(sample.loopLagMs).toBe(40)
    expect(vi.getTimerCount()).toBe(0)
    await expect(
      measure(async () => {
        throw new Error('refused')
      }),
    ).rejects.toThrow('refused')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    now.mockRestore()
    vi.useRealTimers()
  }
})
