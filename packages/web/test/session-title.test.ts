import { afterEach, expect, it, vi } from 'vitest'
import { createTitleRefresh, sessionTitle } from '../src/session-title.js'

afterEach(() => vi.useRealTimers())
it('retains a persisted title across new transcript renders and does not split emoji', () => {
  expect(sessionTitle('正式标题', '不同的第一条消息')).toBe('正式标题')
  expect(sessionTitle(undefined, '😀'.repeat(70))).toBe('😀'.repeat(56))
  expect(sessionTitle(undefined)).toBe('新任务')
})
it('bounds refreshes, prevents duplicate loops, and cancels all timers on close', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => false)
  const titles = createTitleRefresh(read, { intervalMs: 10, attempts: 3 })
  titles.start('one')
  titles.start('one')
  await vi.runAllTimersAsync()
  expect(read).toHaveBeenCalledTimes(3)
  titles.start('one')
  await vi.runAllTimersAsync()
  expect(read).toHaveBeenCalledTimes(3)
  titles.start('two')
  await vi.advanceTimersByTimeAsync(0)
  titles.close()
  await vi.runAllTimersAsync()
  expect(read).toHaveBeenCalledTimes(4)
})
