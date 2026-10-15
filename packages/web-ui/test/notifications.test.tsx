/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Notifications } from '../src/index.js'

let root: ReturnType<typeof createRoot>
let host: HTMLDivElement
beforeEach(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  document.body.replaceChildren()
})
it('keeps each error independently dismissible and expires older errors without resetting them', async () => {
  const dismiss = vi.fn()
  const render = (items: { id: number; message: string }[]) =>
    act(async () =>
      root.render(createElement(Notifications, { items, onDismiss: dismiss, closeLabel: '关闭通知' })),
    )
  await render([{ id: 1, message: 'First error' }])
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  await render([
    { id: 1, message: 'First error' },
    { id: 2, message: 'Second error' },
  ])
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2)
  const buttons = document.querySelectorAll<HTMLButtonElement>('[aria-label="关闭通知"]')
  await act(async () => buttons[1]?.click())
  expect(dismiss).toHaveBeenCalledWith(2)
  await act(async () => vi.advanceTimersByTimeAsync(3000))
  expect(dismiss).toHaveBeenCalledWith(1)
  await render([])
  dismiss.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  expect(dismiss).not.toHaveBeenCalled()
})
it('clears errors on pagehide, supports another error after BFCache restore, and releases timers on unmount', async () => {
  const dismiss = vi.fn()
  const render = (id: number) =>
    act(async () =>
      root.render(
        createElement(Notifications, {
          items: [{ id, message: 'Failed' }],
          onDismiss: dismiss,
          closeLabel: 'Dismiss notification',
        }),
      ),
    )
  await render(1)
  await act(async () => window.dispatchEvent(new Event('pagehide')))
  expect(dismiss).toHaveBeenCalledWith(1)
  window.dispatchEvent(new Event('pageshow'))
  await render(2)
  await act(async () => window.dispatchEvent(new Event('pagehide')))
  expect(dismiss).toHaveBeenCalledWith(2)
  await act(async () => root.render(null))
  dismiss.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(6000))
  window.dispatchEvent(new Event('pagehide'))
  expect(dismiss).not.toHaveBeenCalled()
})
