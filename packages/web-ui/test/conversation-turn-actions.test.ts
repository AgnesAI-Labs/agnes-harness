/** @vitest-environment happy-dom */
import type { UITurn } from '@agnes/protocol'
import { ConversationTurnActions } from '@agnes/web-ui/assistant-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

let host: HTMLDivElement
let root: Root
let clipboardDescriptor: PropertyDescriptor | undefined
let execDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
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
  return Array.from(host.querySelectorAll('dl dt')).map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ])
}

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
  const details = required<HTMLDetailsElement>('details.turn-usage')
  const summary = required<HTMLElement>('summary')
  const list = required<HTMLElement>('dl')
  expect(summary.textContent).toContain(model)
  expect(summary.textContent).toContain('继承历史')
  expect(rows()).toEqual([
    ['输入 Token', '1,234'],
    ['输出 Token', '0'],
    ['缓存读取 / 写入', '600 / 0'],
    ['费用', '$0.000125 · 估算 · 订阅 · 已知部分'],
    ['额度', '0 credits · 网关记录 · 部分'],
    ['用时', '3.0 秒'],
  ])
  expect(host.querySelector('img, strong')).toBeNull()
  details.open = true
  summary.focus()
  await render({
    turn: { ...current, finalModel: 'final', durationMs: 4000 },
    finalText: 'answer',
    settled: true,
  })
  expect(required('details.turn-usage')).toBe(details)
  expect(required('summary')).toBe(summary)
  expect(required('dl')).toBe(list)
  expect(details.open).toBe(true)
  expect(document.activeElement).toBe(summary)
  expect(summary.textContent).toContain('final')
  expect(rows()).toContainEqual(['用时', '4.0 秒'])
  await render({ turn: turn('one'), finalText: 'answer', settled: true })
  expect(rows()).toHaveLength(3)
  expect(host.textContent).not.toContain('$')
})

it('dismisses only its own usage on an outside click, retaining inside clicks and process disclosure', async () => {
  await render({ turn: turn(), finalText: 'answer', settled: true })
  const details = required<HTMLDetailsElement>('details.turn-usage')
  const process = document.createElement('details')
  process.open = true
  document.body.append(process)
  details.open = true
  required<HTMLElement>('dl').click()
  expect(details.open).toBe(true)
  document.body.click()
  expect(details.open).toBe(false)
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
  await act(async () => copy.click())
  expect(required('.turn-feedback').textContent).toBe('已复制')
  const selection = document.getSelection()
  const range = document.createRange()
  range.selectNodeContents(copy)
  selection?.removeAllRanges()
  selection?.addRange(range)
  copy.focus()
  await act(async () => copy.click())
  expect(required('.turn-feedback').textContent).toBe('已复制')
  expect(execCommand).toHaveBeenCalledWith('copy')
  expect(document.activeElement).toBe(copy)
  expect(selection?.rangeCount).toBe(1)
  expect(document.querySelector('textarea')).toBeNull()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
  await act(async () => copy.click())
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
  await act(async () => fork.click())
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
  expect(required('summary').textContent).toBe('second')
  expect(rows()).toEqual([
    ['输入 Token', '0'],
    ['输出 Token', '0'],
    ['缓存读取 / 写入', '0 / 0'],
  ])
  await render({ turn: { ...base, finalModel: 'final' }, finalText: 'answer', settled: true })
  expect(required('summary').textContent).toBe('final')
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
    current: null as import('@agnes/web-ui/assistant-ui').ConversationTurnFeedback | null,
  }
  await render({ turn: turn(), finalText: 'answer', settled: true, feedbackRef })
  const details = required<HTMLDetailsElement>('details.turn-usage')
  const ownedClick = add.mock.calls.find(([event]) => event === 'click')?.[1]
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
  details.open = true
  document.body.click()
  expect(details.open).toBe(true)
  add.mockRestore()
  remove.mockRestore()
})

it('keeps timed feedback independent across mounted turns', async () => {
  vi.useFakeTimers()
  const first = { current: null as import('@agnes/web-ui/assistant-ui').ConversationTurnFeedback | null }
  const second = { current: null as import('@agnes/web-ui/assistant-ui').ConversationTurnFeedback | null }
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

it('uses a supplied disclosure binding without adding its own outside-click listener', async () => {
  const add = vi.spyOn(document, 'addEventListener')
  const bindAutoDismiss = vi.fn()
  await render({ turn: turn(), finalText: 'answer', settled: true, bindAutoDismiss })
  const details = required<HTMLDetailsElement>('details.turn-usage')
  expect(bindAutoDismiss).toHaveBeenCalledExactlyOnceWith(details)
  expect(add.mock.calls.filter(([event]) => event === 'click')).toHaveLength(0)
  add.mockRestore()
})
