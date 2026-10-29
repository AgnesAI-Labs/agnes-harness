/** @vitest-environment happy-dom */
import { fireEvent, getByRole, queryByRole } from '@testing-library/dom'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { topbarLocaleCatalog } from '../src/locales/topbar.js'
import { Topbar, type TopbarHandle } from '../src/topbar.js'

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const start = '2026-10-15T00:00:00Z'
const t = (key: string) => topbarLocaleCatalog['zh-CN'][key] ?? key
let container: HTMLDivElement
let root: Root
let ref: ReturnType<typeof createRef<TopbarHandle>>
let reduce = false
let hover = true
const stop = vi.fn()
const status = () => {
  const element = container.querySelector<HTMLElement>('#status')
  if (!element) throw new Error('Missing status capsule')
  return element
}
const clock = () => container.querySelector('.run-status-time')
const phase = () => {
  const element = container.querySelector('.run-status-phase > span:last-child')
  if (!element) throw new Error('Missing phase')
  return element
}
const update = (text = '生成回复', state = 'running', sessionId = 'one', startedAt = start) =>
  act(() => {
    ref.current?.setStatus(text, state, {
      sessionId,
      startedAt,
      accessibleLabel: state === 'running' ? `正在执行：${text}` : text,
    })
  })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(start))
  reduce = false
  hover = true
  stop.mockClear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('reduced-motion') ? reduce : hover,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  ref = createRef<TopbarHandle>()
  act(() => root.render(<Topbar ref={ref} translate={t} />))
  act(() => ref.current?.setStopAction(stop))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('topbar run-status capsule', () => {
  it('changes the phase and accessible name without putting the clock in the live region', () => {
    update()
    expect(phase().textContent).toBe('生成回复')
    expect(getByRole(container, 'button', { name: '正在执行：生成回复' })).toBeTruthy()
    update('执行工具')
    expect(phase().textContent).toBe('执行工具')
    expect(getByRole(container, 'button', { name: '正在执行：执行工具' })).toBeTruthy()
    const live = getByRole(status(), 'status')
    expect(live.textContent).toBe('正在执行：执行工具')
    expect(live.contains(clock())).toBe(false)
    expect(clock()?.getAttribute('aria-hidden')).toBe('true')
    expect(status().querySelector('.run-status-out')?.textContent).toBe('生成回复')
    act(() => vi.advanceTimersByTime(260))
    expect(status().querySelector('.run-status-out')).toBeNull()
  })

  it('formats elapsed time from the projected start, ticks during approval, and cleans up on idle, switch and unmount', () => {
    vi.setSystemTime(new Date(Date.parse(start) + 59_000))
    update()
    expect(clock()?.textContent).toBe('· 0:59')
    act(() => vi.advanceTimersByTime(1000))
    expect(clock()?.textContent).toBe('· 1:00')
    update('等待你审批', 'approval')
    act(() => vi.advanceTimersByTime(1000))
    expect(clock()?.textContent).toBe('· 1:01')
    vi.setSystemTime(new Date(Date.parse(start) + 3_661_000))
    act(() => vi.advanceTimersByTime(1000))
    expect(clock()?.textContent).toBe('· 1:01:02')
    update('生成回复', 'running', 'two', new Date(Date.now()).toISOString())
    expect(clock()?.textContent).toBe('· 0:00')
    act(() => vi.advanceTimersByTime(1000))
    expect(clock()?.textContent).toBe('· 0:01')
    update('准备就绪', 'idle', 'two')
    expect(clock()).toBeNull()
    act(() => vi.advanceTimersByTime(1000))
    expect(vi.getTimerCount()).toBe(0)
    update()
    act(() => root.unmount())
    expect(vi.getTimerCount()).toBe(0)
    root = createRoot(container)
  })

  it.each([
    ['approval', '等待你审批', true, true],
    ['parked', '等待你审批', true, false],
    ['stopping', '正在停止…', false, false],
    ['failed', '执行失败', false, false],
    ['error', '执行失败', false, false],
    ['blocked', '已阻止', false, false],
    ['not-verified', '未通过校验', false, false],
    ['not-verified', '未能完成校验', false, false],
    ['budget', '预算耗尽', false, false],
    ['max_steps', '达到步数上限', false, false],
    ['idle', '准备就绪', false, false],
    ['done', '已完成', false, false],
  ])('renders %s with its label, clock and stop availability', (state, label, timed, stoppable) => {
    update(label, state)
    expect(status().dataset.state).toBe(state)
    expect(phase().textContent).toBe(label)
    expect(clock() !== null).toBe(timed)
    expect(queryByRole(container, 'button', { name: '停止', hidden: true }) !== null).toBe(stoppable)
    expect(status().classList.contains('run-status-breathe')).toBe(timed)
  })

  it('expands on focus, calls the supplied composer stop action, and collapses with Escape and blur', () => {
    update()
    const toggle = getByRole(container, 'button', { name: '正在执行：生成回复' })
    expect(queryByRole(container, 'button', { name: '停止' })).toBeNull()
    act(() => toggle.focus())
    expect(status().dataset.expanded).toBe('true')
    const button = getByRole(container, 'button', { name: '停止' })
    act(() => button.focus())
    act(() => fireEvent.click(button))
    expect(stop).toHaveBeenCalledOnce()
    act(() => fireEvent.keyDown(button, { key: 'Escape' }))
    expect(status().dataset.expanded).toBe('false')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(toggle)
    expect(queryByRole(container, 'button', { name: '停止' })).toBeNull()
    act(() => toggle.blur())
    act(() => toggle.focus())
    expect(status().dataset.expanded).toBe('true')
    act(() => toggle.blur())
    expect(status().dataset.expanded).toBe('false')
  })

  it('supports hover, touch toggling and session switches without carrying expansion across sessions', () => {
    update()
    act(() => fireEvent.mouseOver(status()))
    expect(status().dataset.expanded).toBe('true')
    act(() => fireEvent.mouseOut(status()))
    expect(status().dataset.expanded).toBe('false')
    hover = false
    const toggle = getByRole(container, 'button', { name: '正在执行：生成回复' })
    act(() => {
      fireEvent.pointerDown(toggle, { pointerType: 'touch' })
      toggle.focus()
      fireEvent.click(toggle)
    })
    expect(status().dataset.expanded).toBe('true')
    act(() => fireEvent.click(toggle))
    expect(status().dataset.expanded).toBe('false')
    act(() => fireEvent.click(toggle))
    update('执行工具', 'running', 'two')
    expect(status().dataset.expanded).toBe('false')
    expect(status().querySelector('.run-status-out')).toBeNull()
  })

  it('leaves no breathing or transition animation classes under reduced motion', () => {
    reduce = true
    update()
    update('执行工具')
    expect(status().classList.contains('run-status-breathe')).toBe(false)
    expect(status().querySelector('.run-status-in, .run-status-out')).toBeNull()
    expect(phase().textContent).toBe('执行工具')
  })
})
