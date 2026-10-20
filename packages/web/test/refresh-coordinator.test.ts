import { afterEach, expect, it, vi } from 'vitest'
import { coalesceBurst, createRefreshCoordinator } from '../src/refresh-coordinator.js'

afterEach(() => vi.useRealTimers())

it('does not poll and only refreshes visible mounted views on change notifications', async () => {
  vi.useFakeTimers()
  let visible = true
  let connected = true
  let mounted = false
  let shown = 0
  const coordinator = createRefreshCoordinator({
    canRefresh: () => mounted && visible && connected,
    refresh: async () => {
      shown++
    },
  })
  await vi.advanceTimersByTimeAsync(9_999)
  expect(shown).toBe(0)
  await vi.advanceTimersByTimeAsync(50_001)
  expect(shown).toBe(0)
  await coordinator.request()
  expect(shown).toBe(0)
  mounted = true
  visible = false
  await coordinator.request()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(0)
  visible = true
  connected = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(0)
  connected = true
  await coordinator.request()
  expect(shown).toBe(1)
  coordinator.stop()
  await coordinator.request()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(1)
})

it.each([false, true])('applies post-save state after an in-flight read (first fails=%s)', async (fails) => {
  vi.useFakeTimers()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let stored = 'old'
  let shown = ''
  let reads = 0
  const coordinator = createRefreshCoordinator({
    canRefresh: () => true,
    refresh: async () => {
      const value = stored
      if (++reads === 1) {
        await gate
        if (fails) throw new Error('read failed')
      }
      shown = value
    },
  })
  const first = coordinator.request()
  await vi.advanceTimersByTimeAsync(5_000)
  stored = 'saved'
  const saved = coordinator.request()
  const duplicate = coordinator.request()
  release()
  await Promise.all([first, saved, duplicate])
  expect(shown).toBe('saved')
  expect(reads).toBe(2)
  coordinator.stop()
})

it('runs once per burst, never drops a later request, and cancels a pending run on stop', async () => {
  vi.useFakeTimers()
  let runs = 0
  const burst = coalesceBurst(() => {
    runs++
  }, 100)
  burst.request()
  await vi.advanceTimersByTimeAsync(40)
  burst.request()
  burst.request()
  await vi.advanceTimersByTimeAsync(59)
  expect(runs).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(runs).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(runs).toBe(1)
  burst.request()
  await vi.advanceTimersByTimeAsync(100)
  expect(runs).toBe(2)
  burst.request()
  burst.stop()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(runs).toBe(2)
})
