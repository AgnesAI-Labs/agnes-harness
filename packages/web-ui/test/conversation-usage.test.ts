/** @vitest-environment happy-dom */
import type { UsageView } from '@agnes/protocol'
import { act, createElement, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationUsage } from '../src/conversation/usage.js'
import { zhT } from './locale.js'

const usage: UsageView = {
  totals: { input: 9999, output: 500, cacheRead: 6000, cacheWrite: 0, reasoning: 20 },
  cost: { usdMicros: 125, source: 'estimated', subscription: false },
  credits: { amount: 0.000206, source: 'gateway', complete: true },
  context: { tokens: 1500, window: 128000, autoCompact: true, source: 'estimated' },
  model: { route: 'private-route', id: '<img src=x> **model**', thinking: 'high', maxTokens: 8192 },
}
let host: HTMLElement
let root: Root
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('section')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  vi.restoreAllMocks()
})
async function render(value: UsageView | undefined, connected = true) {
  await act(async () =>
    root.render(
      createElement(StrictMode, null, createElement(ConversationUsage, { usage: value, connected, t: zhT })),
    ),
  )
}
const rows = () =>
  [...host.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent])

it('renders only actual context fields with the existing ring, values and labels', async () => {
  await render(usage)
  // The gauge shows the share; the full reading is the tooltip and the accessible name.
  expect(host.querySelector('.usage-percent')?.textContent).toBe('1%')
  expect(host.querySelector('.usage-summary-label')?.textContent).toBe('上下文约 1.5K / 128.0K · 1.2%')
  expect(host.querySelector<HTMLElement>('.agh-disclosure-summary')?.title).toBe(
    '上下文约 1.5K / 128.0K · 1.2%. 上下文占用为后台估算。',
  )
  expect(host.querySelector<HTMLElement>('.agh-disclosure-summary')?.getAttribute('aria-label')).toBe(
    '查看上下文约 1.5K / 128.0K · 1.2%. 上下文占用为后台估算。',
  )
  expect(host.querySelector<HTMLElement>('.usage-ring')?.style.getPropertyValue('--usage-pct')).toBe('1.2%')
  expect(host.querySelector<HTMLElement>('.usage-bar > span')?.style.width).toBe('1.2%')
  expect(host.querySelector('.usage-note')).toBeNull()
  expect(host.querySelector('.usage-popover')?.textContent).not.toContain('后台估算')
  expect(rows()).toEqual([
    ['上下文占用', '1,500 Token'],
    ['模型窗口', '128,000 Token'],
    ['最大输出上限', '8,192 Token'],
    ['自动整理上下文', '已启用'],
  ])
  for (const forbidden of ['9,999', '0.000206', '$', 'private-route', 'model', '缓存命中', '累计'])
    expect(host.textContent).not.toContain(forbidden)
  expect(host.querySelector('img,script,a')).toBeNull()
})

it('preserves disclosure, rows, expansion and real focus through snapshots and connection changes', async () => {
  await render(usage)
  const details = required(host.querySelector<HTMLElement>('.agh-disclosure'))
  const summary = required(host.querySelector<HTMLElement>('.agh-disclosure-summary'))
  const firstRow = host.querySelector('dt')
  await act(async () => summary.click())
  summary.focus()
  for (const connected of [false, false, true]) {
    await render({ ...usage, context: { ...usage.context, tokens: 100000 } }, connected)
    expect(host.querySelector<HTMLElement>('.agh-disclosure')).toBe(details)
    expect(host.querySelector<HTMLElement>('.agh-disclosure-summary')).toBe(summary)
    expect(host.querySelector('dt')).toBe(firstRow)
    expect(details.dataset.open).toBe('true')
    expect(document.activeElement).toBe(summary)
    expect(host.textContent?.includes('上次同步')).toBe(!connected)
    expect(details.dataset.pressure).toBe('medium')
  }
})

it('closes on outside click or Escape, keeps inside clicks, and removes the owned listener on unmount', async () => {
  const added = vi.spyOn(document, 'addEventListener')
  const removed = vi.spyOn(document, 'removeEventListener')
  await render(usage)
  const details = required(host.querySelector<HTMLElement>('.agh-disclosure'))
  const summary = required(host.querySelector<HTMLElement>('.agh-disclosure-summary'))
  expect(summary.getAttribute('aria-expanded')).toBe('false')
  await act(async () => summary.click())
  expect(summary.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(summary.getAttribute('aria-controls') ?? '')?.hidden).toBe(false)
  await act(async () => required(host.querySelector<HTMLElement>('.usage-popover')).click())
  expect(details.dataset.open).toBe('true')
  const outside = document.createElement('button')
  document.body.append(outside)
  await act(async () => outside.click())
  expect(details.dataset.open).toBe('false')
  await act(async () => summary.click())
  await act(async () => {
    summary.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  expect(details.dataset.open).toBe('false')
  expect(document.activeElement).toBe(summary)
  await act(async () => summary.click())
  await act(async () => root.render(null))
  const clicks = added.mock.calls.filter(([event]) => event === 'click')
  expect(clicks.length).toBeGreaterThan(0)
  for (const [, listener] of clicks)
    expect(removed.mock.calls.some(([event, callback]) => event === 'click' && callback === listener)).toBe(
      true,
    )
})

it('clears missing usage and restarts closed with current fields for another session', async () => {
  await render(usage)
  const details = required(host.querySelector<HTMLElement>('.agh-disclosure'))
  await act(async () => required(host.querySelector<HTMLElement>('.agh-disclosure-summary')).click())
  expect(details.dataset.open).toBe('true')
  await render(undefined)
  expect(details.dataset.open).toBe('false')
  expect(host.querySelector<HTMLElement>('.agh-disclosure-summary')?.textContent).toBe('')
  expect(rows()).toEqual([])
  expect(host.querySelector<HTMLElement>('.usage-ring')?.style.getPropertyValue('--usage-pct')).toBe('0%')
  await render({
    ...usage,
    context: { ...usage.context, tokens: 0, autoCompact: false },
    model: { route: 'other', id: 'other', thinking: 'off' },
  })
  expect(host.querySelector<HTMLElement>('.agh-disclosure')).toBe(details)
  expect(details.dataset.open).toBe('false')
  expect(rows()).toEqual([
    ['上下文占用', '0 Token'],
    ['模型窗口', '128,000 Token'],
    ['自动整理上下文', '未启用'],
  ])
  expect(host.textContent).not.toContain('8,192')
})

it('shows truthful over-window numbers while capping the ring and bar', async () => {
  await render({ ...usage, context: { ...usage.context, tokens: 256000 } })
  expect(host.querySelector('.usage-context-value')?.textContent).toBe('200.0%')
  expect(host.querySelector<HTMLElement>('.usage-ring')?.style.getPropertyValue('--usage-pct')).toBe('100%')
  expect(host.querySelector<HTMLElement>('.usage-bar > span')?.style.width).toBe('100%')
  expect(host.querySelector<HTMLElement>('.agh-disclosure')?.dataset.pressure).toBe('high')
})

function required<T>(value: T | null): T {
  if (value === null) throw new Error('missing fixture element')
  return value
}
