import { afterEach, expect, it, vi } from 'vitest'
import { defaultPrewarm } from '../../src/runtime/profile/default-prewarm.js'

afterEach(() => vi.useRealTimers())

it('defers behind foreground work, coalesces changes and prepares the latest input', async () => {
  vi.useFakeTimers()
  let busy = true
  let input = 'boot'
  const ready: string[] = []
  const warm = defaultPrewarm({
    busy: () => busy,
    prepare: async () => {
      ready.push(input)
    },
    diagnostic() {},
  })
  warm.invalidate()
  await vi.advanceTimersByTimeAsync(1000)
  expect(ready).toEqual([])
  input = 'updated'
  warm.invalidate()
  busy = false
  await vi.advanceTimersByTimeAsync(100)
  expect(ready).toEqual(['updated'])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(ready).toEqual(['updated'])
  warm.close()
})

it('reports a failure without retaining it and schedules a change made during preparation', async () => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const diagnostics: { outcome: string; rssBefore: number; rssAfter: number }[] = []
  let fail = true
  const warm = defaultPrewarm({
    busy: () => false,
    prepare: async () => {
      if (fail) {
        await gate
        fail = false
        throw new Error('synthetic preparation failure')
      }
    },
    diagnostic: (detail) => {
      diagnostics.push(detail)
    },
  })
  warm.invalidate()
  await vi.advanceTimersByTimeAsync(100)
  warm.invalidate()
  release()
  await vi.advanceTimersByTimeAsync(100)
  expect(diagnostics.map(({ outcome }) => outcome)).toEqual(['failed', 'ready'])
  for (const detail of diagnostics) {
    expect(detail.rssBefore).toBeGreaterThan(0)
    expect(detail.rssAfter).toBeGreaterThan(0)
  }
  warm.close()
})

it.each([false, true])(
  'cancels scheduled work and suppresses completion after close (running=%s)',
  async (running) => {
    vi.useFakeTimers()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let state = 'scheduled'
    const reports: string[] = []
    const warm = defaultPrewarm({
      busy: () => false,
      prepare: async () => {
        state = 'running'
        await gate
        state = 'drained'
      },
      diagnostic: ({ outcome }) => {
        reports.push(outcome)
      },
    })
    warm.invalidate()
    if (running) await vi.advanceTimersByTimeAsync(100)
    warm.close()
    release()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state).toBe(running ? 'drained' : 'scheduled')
    expect(reports).toEqual([])
  },
)
