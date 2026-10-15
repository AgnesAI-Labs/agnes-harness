/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { onPageHide } from '../src/app/global-events.js'
import { AppNotice, appNotice } from '../src/app-notices.js'

it('offers the next step beside a notice and drops it when the next notice arrives', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(AppNotice)))
  const use = vi.fn()
  await act(async () => {
    appNotice.setText('Fixed when this session started.')
    appNotice.offer({ label: 'Use it in a new session', run: use })
  })
  const action = host.querySelector<HTMLButtonElement>('[data-testid="notice-action"]')
  expect(host.querySelector('#notice')?.textContent).toContain('Fixed when this session started.')
  expect(action?.textContent).toBe('Use it in a new session')
  await act(async () => action?.click())
  expect(use).toHaveBeenCalledTimes(1)
  await act(async () => appNotice.setText('Saved.'))
  expect(host.querySelector('[data-testid="notice-action"]')).toBeNull()
  await act(async () => {
    appNotice.offerMany([
      { label: 'Retry stop', run: use },
      { label: 'Force end', run: use },
    ])
  })
  expect(
    [...host.querySelectorAll('[data-testid="notice-stop-action"]')].map((node) => node.textContent),
  ).toEqual(['Retry stop', 'Force end'])
  await act(async () => appNotice.setText('Stopped.'))
  expect(host.querySelector('[data-testid="notice-stop-action"]')).toBeNull()
  await act(async () => root.unmount())
  host.remove()
})

it('expires transient errors while preserving actionable notices and clears errors on pagehide', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(createElement(AppNotice))
      appNotice.setText('Repair required')
      appNotice.repair(() => {})
      appNotice.error('First transient error')
      appNotice.error('Second transient error')
    })
    expect(document.querySelectorAll('.agh-notification')).toHaveLength(2)
    await act(async () => vi.advanceTimersByTimeAsync(6000))
    expect(document.querySelectorAll('.agh-notification')).toHaveLength(0)
    expect(host.querySelector('#notice')?.textContent).toContain('Repair required')
    expect(host.querySelector('[data-testid="credential-repair"]')).not.toBeNull()
    await act(async () => appNotice.error('Before navigation'))
    const teardown = vi.fn()
    onPageHide(teardown)
    const cached = new Event('pagehide')
    Object.defineProperty(cached, 'persisted', { value: true })
    await act(async () => window.dispatchEvent(cached))
    expect(teardown).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.agh-notification')).toHaveLength(0)
    window.dispatchEvent(new Event('pageshow'))
    await act(async () => appNotice.error('After restore'))
    expect(document.querySelector('.agh-notification')?.textContent).toContain('After restore')
    const close = document.querySelector<HTMLButtonElement>('.agh-notification button')
    expect(close?.getAttribute('aria-label')).toBeTruthy()
    await act(async () => close?.click())
    expect(document.querySelector('.agh-notification')).toBeNull()
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(new Event('pagehide'))
    expect(teardown).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  }
})
