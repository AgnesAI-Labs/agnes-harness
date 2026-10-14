/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
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
