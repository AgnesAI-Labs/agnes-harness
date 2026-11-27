/** @vitest-environment happy-dom */
import { homeNavigation } from '@agnes/web-client'
import { appLocaleCatalog } from '@agnes/web-foundation/locales/app'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ClientReconciler } from '../src/client-modules/reconcile.js'
import { beginClientUiPreparation, ClientUiPreparation } from '../src/client-ui-preparation.js'
import { createPreparationTiming, measurePreparation } from '../src/preparation-timing.js'

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
})

it.each(['en', 'zh-CN'] as const)(
  'shows one %s waiting state without an input and retries until both admitted surfaces mount',
  async (language) => {
    homeNavigation.close()
    document.documentElement.lang = language
    const state = beginClientUiPreparation()
    const host = document.createElement('div')
    const root = createRoot(host)
    const invalidation = vi.fn(async () => {
      state.mounted('conversation', true)
      state.mounted('composer', true)
    })
    const underlying = {
      reconcileNow: async () => {},
      invalidate: invalidation,
      reload: async () => {},
      retirePending() {},
      subscribe: () => () => {},
      snapshot: () => new Map(),
    } satisfies ClientReconciler
    const reconciler = state.track(underlying, {
      available: () => true,
      list: async () => ({ revision: '', modules: [], statuses: [] }),
    })
    try {
      await act(async () => root.render(createElement(ClientUiPreparation)))
      expect(host.querySelectorAll('[role="status"]')).toHaveLength(1)
      expect(host.querySelector('textarea, input, .skeleton')).toBeNull()
      expect(host.querySelector('#send')).toBeNull()
      expect(host.textContent).toContain(appLocaleCatalog[language]?.['app.uiPreparation.loading'])
      expect(host.textContent).toContain(appLocaleCatalog[language]?.['app.uiPreparation.hint'])
      await act(async () => state.mounted('conversation', true))
      expect(host.querySelectorAll('[data-client-ui-preparation]')).toHaveLength(1)
      await act(async () => reconciler.reconcileNow())
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(host.textContent).toContain(appLocaleCatalog[language]?.['app.uiPreparation.failed'])
      await act(async () => host.querySelector<HTMLButtonElement>('button')?.click())
      expect(invalidation).toHaveBeenCalled()
      expect(host.querySelector('[data-client-ui-preparation]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      state.dispose()
    }
  },
)

it('late mounts and disposal from an old runtime cannot make the next backend appear ready', async () => {
  const old = beginClientUiPreparation()
  const current = beginClientUiPreparation()
  const rootHost = document.createElement('div')
  const root = createRoot(rootHost)
  try {
    await act(async () => {
      root.render(createElement(ClientUiPreparation))
      old.mounted('conversation', true)
      old.mounted('composer', true)
      old.dispose()
    })
    expect(rootHost.querySelector('[role="status"]')).not.toBeNull()
    await act(async () => current.mounted('composer', true))
    expect(rootHost.querySelector('[role="status"]')).not.toBeNull()
    await act(async () => current.mounted('conversation', true))
    expect(rootHost.querySelector('[data-client-ui-preparation]')).toBeNull()
    expect(rootHost.querySelector('textarea')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    current.dispose()
  }
})

it('records bounded stage timings once without recording an error payload or affecting the operation', () => {
  let clock = 10
  const write = vi.fn()
  const timer = createPreparationTiming(() => clock, write)
  const end = timer('client_roster')
  clock = 35
  end('error')
  end()
  expect(write.mock.calls).toEqual([
    [{ stage: 'client_roster', span: 1, phase: 'start', atMs: 10 }],
    [{ stage: 'client_roster', span: 1, phase: 'end', atMs: 35, durationMs: 25, outcome: 'error' }],
  ])
  const unavailable = createPreparationTiming(
    () => clock,
    () => {
      throw new Error('logging unavailable')
    },
  )
  expect(() => unavailable('composer_mount')()).not.toThrow()
  let reads = 0
  const badClock = createPreparationTiming(() => {
    if (reads++) throw new Error('clock unavailable')
    return 10
  }, write)
  expect(() => badClock('profile')()).not.toThrow()
})

it('cloud stage logs preserve operation failures without logging their payload', async () => {
  const before = location.href
  history.replaceState(null, '', '/?remote=https%3A%2F%2Fcloud.example.invalid')
  const log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const error = new Error('synthetic private payload')
  try {
    await expect(
      measurePreparation('profile', async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(log.mock.calls).toContainEqual([
      'AGH_WEB_STARTUP',
      expect.objectContaining({ stage: 'profile', phase: 'end', outcome: 'error' }),
    ])
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message)
  } finally {
    log.mockRestore()
    history.replaceState(null, '', before)
  }
})
