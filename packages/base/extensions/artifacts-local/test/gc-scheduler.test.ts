import { describe, expect, it, vi } from 'vitest'
import { createArtifactGcScheduler } from '../src/gc-scheduler.js'

describe('artifact GC scheduler', () => {
  it('runs immediately, repeats hourly, and never overlaps', async () => {
    vi.useFakeTimers()
    let release: (() => void) | undefined
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const scheduler = createArtifactGcScheduler(run, { intervalMs: 3_600_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(7_200_000)
    expect(run).toHaveBeenCalledOnce()
    release?.()
    await vi.runAllTicks()
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(run).toHaveBeenCalledTimes(2)
    release?.()
    await scheduler.close()
    vi.useRealTimers()
  })
})
