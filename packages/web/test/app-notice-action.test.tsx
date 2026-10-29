/** @vitest-environment happy-dom */
import { presentationRoles } from '@agnes/web-client'
import { tr } from '@agnes/web-foundation/locale-bridge'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { onPageHide } from '../src/app/global-events.js'
import { AppNotice, appNotice, appReadOnly, ReadOnlyNotice } from '../src/app-notices.js'

it('states a refused record with a warning, its id and its next step', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const recover = vi.fn()
  try {
    await act(async () => {
      root.render(createElement(ReadOnlyNotice))
      appReadOnly.show({
        sessionId: '11111111-2222-4333-8444-555555555555',
        message: { en: 'History failed verification', 'zh-CN': '历史校验失败' },
        actions: [{ id: 'new', onSelect: recover }],
      })
    })
    expect(host.querySelector('[data-tone="warning"]')?.textContent).toContain('History failed verification')
    expect(host.querySelector('.agh-disclosure')?.getAttribute('data-open')).toBe('false')
    expect(host.querySelector('.agh-disclosure-chevron')).not.toBeNull()
    expect(host.querySelector('.agh-disclosure code')?.textContent).toBe(
      '11111111-2222-4333-8444-555555555555',
    )
    await act(async () => host.querySelector<HTMLButtonElement>('[data-read-only-action="new"]')?.click())
    expect(recover).toHaveBeenCalledOnce()
    await act(async () => appReadOnly.clear())
    expect(host.textContent).toBe('')
    await act(async () =>
      appReadOnly.show({
        verificationFailed: true,
        message: {
          en: 'History verification failed. Session sealed.',
          'zh-CN': '历史校验失败，会话已封存。',
        },
        actions: [],
      }),
    )
    expect(host.querySelector('[data-testid="session-history-failed"]')?.textContent).toBe(
      'History verification failed. Session sealed.',
    )
    expect(host.querySelector('[data-tone="warning"]')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
    await act(async () => appReadOnly.clear())
    expect(host.textContent).toBe('')
  } finally {
    await act(async () => {
      appReadOnly.clear()
      root.unmount()
    })
    host.remove()
  }
})

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
  const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  try {
    await act(async () => {
      expect(() =>
        presentationRoles.register(
          'synthetic-owner',
          {
            role: 'synthetic-display',
            mount() {
              throw new Error('file:///private/token=secret')
            },
          },
          { packageId: 'synthetic-ui', revision: 'one' },
        ),
      ).toThrow()
    })
    const failure = host.querySelector('[data-testid=presentation-failure]')
    expect(failure?.textContent).toContain('saved deliverables may still exist')
    expect(failure?.textContent).toContain(
      'synthetic-display · synthetic-ui · mount · PRESENTATION_MOUNT_FAILED',
    )
    expect(failure?.textContent).not.toMatch(/secret|private|file:/)
    await act(async () => failure?.querySelector<HTMLButtonElement>('button')?.click())
    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    reload.mockRestore()
  }
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

it('retranslates retained errors and recovery details when the language changes', async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  document.documentElement.lang = 'en'
  const message = () => tr('app.recovery.openFailed', { detail: 'DIAG-123' })
  try {
    await act(async () => {
      root.render(createElement(AppNotice))
      appNotice.error(message)
      appNotice.recover({ message, error: message, disabled: false, retry() {}, create() {} })
    })
    expect(host.textContent).toContain('Opening the task failed.')
    await act(async () => {
      document.documentElement.lang = 'zh-CN'
    })
    expect(host.querySelector('[data-recovery-message]')?.textContent).toContain('历史任务打开失败。')
    expect(host.querySelector('[data-recovery-error]')?.textContent).toContain('历史任务打开失败。')
    expect(document.querySelector('.agh-notification')?.textContent).toContain('历史任务打开失败。')
    expect(host.textContent).not.toContain('Opening the task failed.')
    expect(host.textContent).toContain('DIAG-123')
    await act(async () => appNotice.setText(message))
    await act(async () => {
      document.documentElement.lang = 'en'
    })
    expect(host.querySelector('#notice')?.textContent).toContain('Opening the task failed.')
  } finally {
    await act(async () => {
      appNotice.clearErrors()
      appNotice.setText('')
      root.unmount()
    })
    document.documentElement.lang = 'en'
    host.remove()
  }
})
