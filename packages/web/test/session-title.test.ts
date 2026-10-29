import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { afterEach, expect, it, vi } from 'vitest'
import { createTitleRefresh, sessionTitle } from '../src/session-title.js'
import { zhT } from './helpers/locale.js'

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

afterEach(() => vi.useRealTimers())
it('retains a persisted title across new transcript renders and does not split emoji', () => {
  expect(sessionTitle('正式标题', '不同的第一条消息')).toBe('正式标题')
  expect(sessionTitle(undefined, '😀'.repeat(70))).toBe('😀'.repeat(56))
  expect(sessionTitle(undefined)).toBe('新任务')
  const request =
    '调查当前对象\n\n' +
    JSON.stringify({
      applicationId: 'acme',
      packageId: 'acme/kit',
      actionId: 'review',
      object: { type: 'ncr', id: 'NCR-018' },
    })
  expect(sessionTitle(undefined, request)).toBe('调查当前对象')
  expect(sessionTitle(Array.from(request).slice(0, 56).join(''), request)).toBe('调查当前对象')
  expect(sessionTitle('已保存的业务标题', request)).toBe('已保存的业务标题')
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
