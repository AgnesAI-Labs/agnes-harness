/** @vitest-environment happy-dom */
import type { UITurn } from '@agnes/protocol'
import { ConversationTurnActions } from '@agnes/web-ui/conversation'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { callShares, money } from '../src/conversation/turn-usage.js'
import { installFeedbackSink, type OperationFeedback } from '../src/feedback.js'
import { zhT } from './locale.js'

function turn(id = 'turn:one', changes: Partial<UITurn> = {}): UITurn {
  return {
    id,
    turn: 1,
    startSeq: 1,
    endSeq: 2,
    startedAt: '2026-09-22T00:00:00.000Z',
    status: 'completed',
    nodeIds: ['assistant'],
    usage: {
      totals: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: true,
      calls: [],
    },
    inherited: false,
    forkable: true,
    ...changes,
  }
}

const outcomes: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
let host: HTMLDivElement
let root: Root
let clipboardDescriptor: PropertyDescriptor | undefined
let execDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  outcomes.length = 0
  releaseFeedback = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  releaseFeedback?.()
  await act(async () => root.unmount())
  host.remove()
  document.body.replaceChildren()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor)
  else Reflect.deleteProperty(document, 'execCommand')
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(props: Parameters<typeof ConversationTurnActions>[0]) {
  await act(async () => root.render(createElement(ConversationTurnActions, { ...props, t: zhT })))
}
function required<T extends Element>(selector: string): T {
  const element = host.querySelector<T>(selector)
  if (!element) throw new Error(`missing ${selector}`)
  return element
}
function rows() {
  return Array.from(host.querySelectorAll('.turn-usage-tokens dt')).map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ])
}
const text = (selector: string) => host.querySelector(selector)?.textContent

it('gates actions on settlement and available text or fork callback', async () => {
  const state = { turn: turn(), finalText: '', settled: false }
  await render(state)
  expect(required<HTMLElement>('footer').hidden).toBe(true)
  await render({ ...state, settled: true })
  expect(required<HTMLElement>('footer').hidden).toBe(false)
  expect(required<HTMLButtonElement>('[aria-label="复制回答"]').disabled).toBe(true)
  expect(required<HTMLButtonElement>('[aria-label="分支到新聊天"]').disabled).toBe(true)
  await render({ ...state, finalText: 'answer', settled: true, turn: turn('one', { forkable: false }) })
  expect(required<HTMLButtonElement>('[aria-label="复制回答"]').disabled).toBe(false)
  expect(required<HTMLButtonElement>('[aria-label="分支到新聊天"]').hidden).toBe(true)
})

it('shows complete usage facts as text and keeps the disclosure nodes through replay', async () => {
  const model = '<img src=x> **literal**'
  const current = turn('one', {
    endedAt: '2026-09-22T00:00:03.000Z',
    durationMs: 3000,
    inherited: true,
    usage: {
      totals: { input: 1234, output: 0, cacheRead: 600, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [
        {
          id: 'call:1',
          purpose: 'inference',
          model,
          seq: 1,
          creditSource: 'gateway',
          tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        },
      ],
      cost: { usdMicros: 125, source: 'estimated', subscription: true },
      credits: { amount: 0, source: 'gateway', complete: false },
    },
  })
  await render({ turn: current, finalText: 'answer', settled: true })
  const details = required<HTMLElement>('.agh-disclosure.turn-usage')
  const summary = required<HTMLElement>('.turn-meta')
  const list = required<HTMLElement>('[data-testid="turn-usage-panel"]')
  expect(summary.textContent).toContain(model)
  expect(summary.textContent).toContain('继承历史')
  // The bar reads «time · model»; tokens, cost and time are in the panel only.
  expect(summary.textContent).not.toMatch(/输入|输出|\$|用时/)
  // Header: this reply · model · time; the cost large with its source tag, credits beside it.
  expect(text('.turn-usage-head')).toBe(`本次回复${model}用时 3.0 秒`)
  expect(text('.turn-usage-amount')).toBe('$0.000125')
  expect(text('.turn-usage-tag')).toBe('估算 · 订阅 · 已知部分')
  expect(text('.turn-usage-credits')).toBe('0 credits · 网关记录 · 部分')
  expect(rows()).toEqual([
    ['输入', '1,234'],
    ['输出', '0'],
    ['缓存读 / 写', '600 / 0'],
  ])
  expect(document.querySelector('.turn-usage-foot')).toBeNull()
  expect(host.querySelector('img, strong')).toBeNull()
  // One call: no call table, its details one click away.
  expect(host.querySelector('[data-testid="turn-usage-calls"]')).toBeNull()
  expect(text('[data-testid="turn-usage-call-details"]')).toBe('调用细节')
  expect(text('.call-usage .usage-grid')).toContain('输入 Token（不含缓存）1')
  await act(async () => summary.click())
  let left = 380
  summary.getBoundingClientRect = () => new DOMRect(left, 100, 120, 20)
  await act(async () => document.dispatchEvent(new Event('scroll')))
  expect(list.style.left).toBe('156px')
  left = 480
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(list.style.left).toBe('256px')
  summary.focus()
  await render({
    turn: { ...current, finalModel: 'final', durationMs: 4000 },
    finalText: 'answer',
    settled: true,
  })
  expect(required('.agh-disclosure.turn-usage')).toBe(details)
  expect(required('.turn-meta')).toBe(summary)
  expect(required('[data-testid="turn-usage-panel"]')).toBe(list)
  expect(details.dataset.open).toBe('true')
  expect(document.activeElement).toBe(summary)
  expect(summary.textContent).toContain('final')
  expect(text('.turn-usage-took')).toBe('用时 4.0 秒')
  await act(async () => summary.click())
  const closedPosition = list.style.left
  left = 580
  await act(async () => document.dispatchEvent(new Event('scroll')))
  expect(list.style.left).toBe(closedPosition)
  await render({ turn: turn('one'), finalText: 'answer', settled: true })
  // No cache: two cells.
  expect(rows()).toEqual([
    ['输入', '12'],
    ['输出', '4'],
  ])
  expect(required('.turn-meta').textContent).not.toContain('输入')
  expect(host.textContent).not.toContain('$')
})

it('reads «time · model» on the bar and keeps it on one line', async () => {
  await render({
    turn: turn('one', {
      endedAt: '2026-10-14T08:23:00.000Z',
      durationMs: 13_000,
      finalModel: 'deepseek-flash',
    }),
    finalText: 'answer',
    settled: true,
  })
  const facts = required('.turn-meta-facts').textContent ?? ''
  expect(facts).toMatch(/^\d{1,2}:\d{2}( [AP]M)? · deepseek-flash$/)
  expect(required('.turn-meta').textContent).toBe(facts)
  expect(text('.turn-usage-took')).toBe('用时 13 秒')
})

it('dismisses only its own usage on an outside click, retaining inside clicks and process disclosure', async () => {
  await render({ turn: turn(), finalText: 'answer', settled: true })
  const details = required<HTMLElement>('.agh-disclosure.turn-usage')
  const process = document.createElement('details')
  process.open = true
  document.body.append(process)
  await act(async () => required<HTMLElement>('.turn-meta').click())
  await act(async () => required<HTMLElement>('dl').click())
  expect(details.dataset.open).toBe('true')
  await act(async () => document.body.click())
  expect(details.dataset.open).toBe('false')
  expect(process.open).toBe(true)
  process.remove()
})

it('copies through clipboard, reports failure, and uses text-only fallback preserving focus and selection', async () => {
  const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'))
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const execCommand = vi.fn(() => {
    expect(document.querySelector('textarea')?.value).toBe('**plain**')
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
  await render({ turn: turn(), finalText: '**plain**', settled: true })
  const copy = required<HTMLButtonElement>('[aria-label="复制回答"]')
  // The row is laid out by Actions, and each action is still a named button in it.
  expect(copy.closest('.ant-actions')).not.toBeNull()
  expect(copy.dataset.copied).toBeUndefined()
  await act(async () => copy.click())
  expect(required('.turn-feedback').textContent).toBe('')
  expect(outcomes.at(-1)).toMatchObject({ scope: 'clipboard', outcome: 'success', message: '已复制' })
  // The glyph turns into a check while the confirmation is announced.
  expect(copy.dataset.copied).toBe('true')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(copy)
  selection?.removeAllRanges()
  selection?.addRange(range)
  copy.focus()
  await act(async () => copy.click())
  expect(required('.turn-feedback').textContent).toBe('')
  expect(outcomes.at(-1)).toMatchObject({ scope: 'clipboard', outcome: 'success', message: '已复制' })
  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(document.activeElement).toBe(copy)
  expect(selection?.rangeCount).toBe(1)
  expect(document.querySelector('textarea')).toBeNull()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  await act(async () => copy.click())
  expect(copy.dataset.copied).toBeUndefined()
  expect(required('.turn-feedback').textContent).toBe('复制失败')
})

it('keeps fork pending local and allows retry after failure', async () => {
  let rejectFirst: (error: Error) => void = () => undefined
  const onFork = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject
        }),
    )
    .mockResolvedValueOnce(undefined)
  await render({ turn: turn(), finalText: 'answer', settled: true, onFork })
  const fork = required<HTMLButtonElement>('[aria-label="分支到新聊天"]')
  await act(async () => fork.click())
  expect(fork.disabled).toBe(true)
  await act(async () => rejectFirst(new Error('failed')))
  expect(fork.disabled).toBe(false)
  expect(required('.turn-feedback').textContent).toBe('分支失败，请重试。')
  await act(async () => required<HTMLButtonElement>('.agh-banner button').click())
  expect(required('.turn-feedback').textContent).toBe('')
  expect(fork.disabled).toBe(false)
})

it('retires feedback timers and stale clipboard completions when the turn changes or unmounts', async () => {
  let resolveWrite: () => void = () => undefined
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve
        }),
    },
  })
  await render({ turn: turn(), finalText: 'first', settled: true })
  await act(async () => required<HTMLButtonElement>('[aria-label="复制回答"]').click())
  await render({ turn: turn('turn:two'), finalText: 'second', settled: true })
  await act(async () => resolveWrite())
  expect(required('.turn-feedback').textContent).toBe('')
  await act(async () => root.render(null))
  expect(host.querySelector('footer')).toBeNull()
})

it('uses the latest non-adjustment inference model and omits absent costs without losing zero totals', async () => {
  const base = turn('one', {
    usage: {
      totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      reasoningComplete: true,
      billingComplete: false,
      calls: [
        { id: 'one', seq: 1, purpose: 'inference', model: 'first', creditSource: 'gateway' },
        { id: 'two', seq: 2, purpose: 'inference', model: 'second', creditSource: 'gateway' },
        {
          id: 'three',
          seq: 3,
          purpose: 'inference',
          model: 'adjusted',
          creditSource: 'gateway',
          adjustment: { of: 2, delta: 0, reason: 'correction' },
        },
      ],
    },
  })
  await render({ turn: base, finalText: 'answer', settled: true })
  expect(required('.turn-meta').textContent).toBe('second')
  expect(rows()).toEqual([
    ['输入', '0'],
    ['输出', '0'],
  ])
  // Nothing was charged: no cost line and no estimate note.
  expect(host.querySelector('.turn-usage-cost')).toBeNull()
  expect(document.querySelector('.turn-usage-foot')).toBeNull()
  await render({ turn: { ...base, finalModel: 'final' }, finalText: 'answer', settled: true })
  expect(required('.turn-meta').textContent).toBe('final')
})

it('lists several model calls in a table with right-aligned numbers, a cost share and row details', async () => {
  const call = (id: string, seq: number, input: number, output: number, usdMicros: number) => ({
    id,
    seq,
    purpose: 'inference' as const,
    model: 'deepseek-flash',
    creditSource: 'estimated' as const,
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    billing: { usdMicros, source: 'estimated' as const, subscription: false },
    credits: usdMicros / 1e6,
    timing: { ttftMs: 420, durationMs: 1800 },
  })
  await render({
    turn: turn('one', {
      durationMs: 16_000,
      finalModel: 'deepseek-flash',
      usage: {
        totals: { input: 2032, output: 994, cacheRead: 44288, cacheWrite: 0, reasoning: 0 },
        reasoningComplete: true,
        billingComplete: true,
        calls: [
          call('a', 1, 1400, 330, 888),
          { ...call('b', 2, 182, 304, 509), purpose: 'title' },
          call('c', 3, 247, 346, 581),
          call('d', 4, 232, 14, 90),
        ],
        cost: { usdMicros: 2068, source: 'estimated', subscription: false },
        credits: { amount: 0.002068, source: 'estimated', complete: true },
      },
    }),
    finalText: 'answer',
    settled: true,
  })
  expect(text('.turn-usage-head')).toBe('本次回复deepseek-flash用时 16 秒')
  expect(text('.turn-usage-amount')).toBe('$0.002068')
  expect(text('.turn-usage-tag')).toBe('估算')
  // Same source as the cost: credits are a plain note.
  expect(text('.turn-usage-credits')).toBe('0.002068 credits')
  const calls = required<HTMLElement>('[data-testid="turn-usage-calls"]')
  expect(calls.textContent).toBe('4 次模型调用（含 1 次后台标题）点击展开收起')
  const row = (n: number) =>
    Array.from(
      host.querySelectorAll(`[data-testid="turn-call-${n}"] > .agh-disclosure-summary .turn-call-row > span`),
    ).map((cell) => cell.textContent)
  expect(row(1)).toEqual(['1', '1.4K', '330', '$0.000888', ''])
  // Every cost has the total's six decimals.
  expect(row(2)[0]).toBe('标题')
  expect(row(3)[0]).toBe('2')
  expect(row(4)).toEqual(['3', '232', '14', '$0.000090', ''])
  expect(row(1)[3]).toBe('$0.000888')
  // The chevron sits in the same summary as the text, never on a line of its own.
  expect(calls.querySelector('.turn-usage-calls-title > .turn-usage-chevron')).not.toBeNull()
  expect(host.querySelector('[data-testid="turn-call-1"] .turn-call-n > .turn-usage-chevron')).not.toBeNull()
  // The dearest call is a full bar, the others in proportion.
  const width = (n: number) =>
    host.querySelector<HTMLElement>(`[data-testid="turn-call-${n}"] .turn-call-share > i`)?.style.width
  expect([1, 2, 3, 4].map(width)).toEqual(['100%', '57%', '65%', '10%'])
  expect(host.querySelector('[data-testid="turn-call-1"] .turn-call-share')?.getAttribute('aria-label')).toBe(
    '占费用 43%',
  )
  // No repeated «(estimated)» per row.
  expect(
    host.querySelector('[data-testid="turn-call-1"] .agh-disclosure-summary')?.textContent,
  ).not.toContain('估算')
  // A row opens the call's own details, as before.
  const callSummary = host.querySelector<HTMLElement>('[data-testid="turn-call-1"] > .agh-disclosure-summary')
  if (!callSummary) throw new Error('expected call disclosure')
  await act(async () => callSummary.click())
  const details = text('[data-testid="turn-call-1"] .usage-grid') ?? ''
  expect(details).toContain('初始采集后的首次输出等待420 ms')
  expect(details).toContain('1,400')
  // The call's own details print its cost with the panel's precision too.
  expect(details).toContain('$0.000888 · 估算')
})

it('does not publish an old fork failure or unlock a new turn while its fork is pending', async () => {
  let rejectOld: (error: Error) => void = () => undefined
  let resolveNew: () => void = () => undefined
  const onFork = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveNew = resolve
        }),
    )
  await render({ turn: turn('one'), finalText: 'first', settled: true, onFork })
  await act(async () => required<HTMLButtonElement>('[aria-label="分支到新聊天"]').click())
  await render({ turn: turn('two'), finalText: 'second', settled: true, onFork })
  await act(async () => required<HTMLButtonElement>('[aria-label="分支到新聊天"]').click())
  const fork = required<HTMLButtonElement>('[aria-label="分支到新聊天"]')
  expect(fork.disabled).toBe(true)
  await act(async () => rejectOld(new Error('old failure')))
  expect(fork.disabled).toBe(true)
  expect(required('.turn-feedback').textContent).toBe('')
  await act(async () => resolveNew())
  expect(fork.disabled).toBe(false)
})

it('keeps feedback local and retires a timed message and owned click listener', async () => {
  vi.useFakeTimers()
  const add = vi.spyOn(document, 'addEventListener')
  const remove = vi.spyOn(document, 'removeEventListener')
  const feedbackRef = {
    current: null as import('@agnes/web-ui/conversation').ConversationTurnFeedback | null,
  }
  await render({ turn: turn(), finalText: 'answer', settled: true, feedbackRef })
  await act(async () => required<HTMLElement>('.turn-meta').click())
  const ownedClick = add.mock.calls.find(([event]) => event === 'click')?.[1]
  expect(ownedClick).toBeDefined()
  await act(async () => feedbackRef.current?.report('temporary', 1600))
  expect(required('.turn-feedback').textContent).toBe('temporary')
  await act(async () => vi.advanceTimersByTime(1600))
  expect(required('.turn-feedback').textContent).toBe('')
  await act(async () => feedbackRef.current?.report('retired', 1600))
  await act(async () => root.render(null))
  expect(feedbackRef.current).toBeNull()
  expect(remove.mock.calls.some(([event, listener]) => event === 'click' && listener === ownedClick)).toBe(
    true,
  )
  add.mockRestore()
  remove.mockRestore()
})

it('keeps timed feedback independent across mounted turns', async () => {
  vi.useFakeTimers()
  const first = { current: null as import('@agnes/web-ui/conversation').ConversationTurnFeedback | null }
  const second = { current: null as import('@agnes/web-ui/conversation').ConversationTurnFeedback | null }
  const siblingHost = document.createElement('div')
  document.body.append(siblingHost)
  const siblingRoot = createRoot(siblingHost)
  try {
    await render({ turn: turn('first'), finalText: 'first', settled: true, feedbackRef: first })
    await act(async () =>
      siblingRoot.render(
        createElement(ConversationTurnActions, {
          turn: turn('second'),
          finalText: 'second',
          settled: true,
          feedbackRef: second,
        }),
      ),
    )
    await act(async () => {
      first.current?.report('first feedback', 1600)
      second.current?.report('second feedback')
    })
    await act(async () => vi.advanceTimersByTime(1600))
    expect(host.querySelector('.turn-feedback')?.textContent).toBe('')
    expect(siblingHost.querySelector('.turn-feedback')?.textContent).toBe('second feedback')
  } finally {
    await act(async () => siblingRoot.unmount())
    siblingHost.remove()
  }
})

it('listens for outside clicks only while its usage panel is open', async () => {
  const add = vi.spyOn(document, 'addEventListener')
  await render({ turn: turn(), finalText: 'answer', settled: true })
  expect(add.mock.calls.filter(([event]) => event === 'click')).toHaveLength(0)
  await act(async () => required<HTMLElement>('.turn-meta').click())
  expect(add.mock.calls.filter(([event]) => event === 'click')).toHaveLength(1)
  add.mockRestore()
})

it('opens and closes usage without a footer; the bar keeps copy and fork only', async () => {
  await render({
    turn: turn('one', { forkable: true }),
    finalText: 'answer',
    settled: true,
    onFork: async () => {},
  })
  const bar = required<HTMLElement>('.turn-footer')
  const barButtons = Array.from(bar.querySelectorAll('.turn-actions button')).map((button) =>
    button.getAttribute('aria-label'),
  )
  expect(barButtons).toEqual(['复制回答', '分支到新聊天'])
  await act(async () => required<HTMLElement>('.turn-meta').click())
  const usage = required<HTMLElement>('.agh-disclosure.turn-usage')
  expect(usage.dataset.open).toBe('true')
  expect(document.querySelector('.turn-usage-foot')).toBeNull()
  await act(async () => required<HTMLElement>('.turn-meta').click())
  expect(usage.dataset.open).toBe('false')
})

it('compares each call with the dearest one and prints every cost with the same precision', () => {
  const billed = (usdMicros: number) => ({
    billing: { usdMicros, source: 'estimated' as const, subscription: false },
  })
  expect(callShares([billed(414), billed(1390), billed(888), billed(1052)])).toEqual([
    { width: 30, percent: 11 },
    { width: 100, percent: 37 },
    { width: 64, percent: 24 },
    { width: 76, percent: 28 },
  ])
  // Without charges the bars follow credits; with neither they stay empty.
  expect(callShares([{ credits: 1 }, { credits: 4 }])).toEqual([
    { width: 25, percent: 20 },
    { width: 100, percent: 80 },
  ])
  expect(callShares([{}, {}])).toEqual([
    { width: 0, percent: 0 },
    { width: 0, percent: 0 },
  ])
  expect([1390, 414, 90, 3744].map(money)).toEqual(['$0.001390', '$0.000414', '$0.000090', '$0.003744'])
})
