import { afterEach, expect, it, vi } from 'vitest'
import { createRefreshCoordinator } from '../src/refresh-coordinator.js'

afterEach(() => vi.useRealTimers())

it('polls at the fallback rate, skips hidden/disconnected pages and stops on close', async () => {
  vi.useFakeTimers()
  let visible = true
  let connected = true
  let shown = 0
  const coordinator = createRefreshCoordinator({
    canPoll: () => visible && connected,
    refresh: async () => {
      shown++
    },
  })
  await vi.advanceTimersByTimeAsync(9_999)
  expect(shown).toBe(0)
  await vi.advanceTimersByTimeAsync(50_001)
  expect(shown).toBe(6)
  visible = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(6)
  visible = true
  connected = false
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(6)
  connected = true
  await coordinator.request()
  expect(shown).toBe(7)
  coordinator.stop()
  await coordinator.request()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(shown).toBe(7)
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
    intervalMs: 1_000,
    canPoll: () => true,
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
