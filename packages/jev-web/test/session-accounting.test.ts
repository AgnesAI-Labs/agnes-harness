/** @vitest-environment happy-dom */
import type {
  ComparisonAccountingFamily,
  ComparisonAccountingTotal,
  SessionAccountingResult,
} from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { afterEach, expect, it, vi } from 'vitest'
import { createJevTranslate } from '../src/jev-locale.js'
import { createSessionAccounting } from '../src/session-accounting.js'

const t = createJevTranslate('zh-CN')

const amount = (value: number | null, missing = 0): ComparisonAccountingTotal => ({
  state: missing ? 'partial' : value === null ? 'unknown' : 'complete',
  value,
  knownSubtotal: value,
  missing,
})
const family = (attempts: number): ComparisonAccountingFamily => ({
  attempts,
  tokens: {
    inputUncached: amount(100),
    cacheRead: amount(300),
    cacheWrite: amount(0),
    inputTotal: amount(400),
    output: amount(20),
    reasoning: amount(0),
  },
  costs: { USD: amount(0.00018) },
  unpricedAttempts: 0,
})

afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

it('shows durable Jev and LLM calls, cache rate and cost while retaining partial unknowns', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div')
  document.body.append(host)
  const reply: SessionAccountingResult = {
    sessionId: 'jev-session',
    runtime: { id: 'jevloop', version: '1' },
    accounting: {
      afterSeq: 0,
      throughSeq: 42,
      state: 'partial',
      issues: ['missing_usage'],
      llm: { ...family(2), costs: { USD: amount(0.00018, 1) } },
      jev: family(3),
      totalCosts: { USD: amount(0.00036, 1) },
    },
  }
  const call = vi.fn(async () => reply)
  const view = createSessionAccounting(host, { call } as unknown as Pick<Client, 'call'>, t)
  view.update('jev-session', 42)
  await vi.advanceTimersByTimeAsync(0)
  expect(call).toHaveBeenCalledWith('_agnes/v1/session.accounting', { sessionId: 'jev-session' })
  const panel = host.querySelector('.jev-session-accounting')
  expect(panel?.textContent).toContain('LLM 2 次 / Jev 3 次')
  expect(panel?.textContent).toContain('缓存命中率75.0%')
  expect(panel?.textContent).toContain('已知小计 0.000180（非总量，缺失 1）')
  expect(panel?.textContent).toContain('子会话未纳入')
  view.update(undefined)
  expect(host.querySelector<HTMLElement>('.jev-session-accounting')?.hidden).toBe(true)
  view.dispose()
  expect(host.querySelector('.jev-session-accounting')).toBeNull()
})
