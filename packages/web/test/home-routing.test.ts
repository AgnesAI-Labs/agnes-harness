/** @vitest-environment happy-dom */
import { homeNavigation } from '@agnes/web-client'
import { afterEach, expect, it } from 'vitest'
import { bindHomeRouting } from '../src/pages/host.js'

afterEach(() => {
  homeNavigation.close()
  history.replaceState(null, '', '/')
})

it('restores pages and tabs on history traversal without adding entries and preserves session scope', () => {
  history.replaceState({ scope: 1 }, '', '/?page=plugins&tab=skills&session=s&workspaceId=w')
  const stop = bindHomeRouting()
  try {
    expect(homeNavigation.getSnapshot()).toEqual({ id: 'plugins', selection: { tab: 'skills' } })
    const count = history.length
    homeNavigation.open('plugins', { tab: 'mcp' })
    expect(history.length).toBe(count + 1)
    expect(location.search).toBe('?page=plugins&tab=mcp&session=s&workspaceId=w')
    homeNavigation.open('plugins', { tab: 'mcp' })
    expect(history.length).toBe(count + 1)
    // Model the browser's URL change before it dispatches popstate.
    history.replaceState(null, '', '/?page=plugins&tab=skills&session=s&workspaceId=w')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(homeNavigation.getSnapshot()).toEqual({ id: 'plugins', selection: { tab: 'skills' } })
    expect(history.length).toBe(count + 1)
    history.replaceState(null, '', '/?session=s&workspaceId=w')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(homeNavigation.getSnapshot()).toBeUndefined()
    expect(history.length).toBe(count + 1)
    homeNavigation.openRef('a#overview', { tab: 'work' })
    expect(new URL(location.href).searchParams.get('pagePackage')).toBe('a')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(homeNavigation.getSnapshot()).toEqual({
      id: 'overview',
      pageRef: 'a#overview',
      selection: { tab: 'work' },
    })
    homeNavigation.open('overview')
    expect(new URL(location.href).searchParams.get('pagePackage')).toBeNull()
    history.replaceState(null, '', '/?page=third-party')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(homeNavigation.getSnapshot()).toEqual({ id: 'third-party' })
  } finally {
    stop()
  }
  history.replaceState(null, '', '/?page=agents')
  window.dispatchEvent(new PopStateEvent('popstate'))
  expect(homeNavigation.getSnapshot()).toEqual({ id: 'third-party' })
})

it.each(['business-agents', 'business-agent', 'agent-fde', 'fde'])(
  'redirects legacy page %s without losing deep-link context',
  (page) => {
    history.replaceState({ scope: 1 }, '', `/?page=${page}&tab=all&view=agent-acme&session=s`)
    const count = history.length
    const stop = bindHomeRouting()
    try {
      expect(homeNavigation.getSnapshot()).toEqual({ id: 'agents', selection: { tab: 'all' } })
      expect(new URLSearchParams(location.search).get('page')).toBe('agents')
      expect(new URLSearchParams(location.search).get('session')).toBe('s')
      expect(new URLSearchParams(location.search).get('view')).toBe('agent-acme')
      expect(history.length).toBe(count)
      // Qualified plugin pages keep their name and owner, even when the name was a builtin alias.
      history.replaceState(null, '', `/?page=${page}&pagePackage=acme/console&tab=details`)
      window.dispatchEvent(new PopStateEvent('popstate'))
      expect(homeNavigation.getSnapshot()).toEqual({
        id: page,
        pageRef: `acme/console#${page}`,
        selection: { tab: 'details' },
      })
      expect(new URLSearchParams(location.search).get('page')).toBe(page)
    } finally {
      stop()
    }
  },
)

it('replaces the selected registration lifetime on batched plugin reload, and unmounts on removal', async () => {
  const { Context } = await import('@agnes/cordis')
  const { homeEntries, LocaleService } = await import('@agnes/web-client')
  const { createDocumentLocaleSource } = await import('@agnes/web-ui')
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HomePageHost } = await import('../src/pages/host.js')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const ctx = new Context()
  const locale = new LocaleService(ctx, 'en')
  const source = createDocumentLocaleSource({})
  const host = document.createElement('main')
  document.body.append(host)
  const root = createRoot(host)
  function Page() {
    const [count, setCount] = useState(0)
    return createElement('button', { onClick: () => setCount(count + 1) }, String(count))
  }
  const entry = { id: 'test.reload', order: 1, icon: 'plug', titleKey: 'test', component: Page }
  let remove = homeEntries.register(entry)
  let active: string | undefined
  try {
    homeNavigation.open(entry.id)
    await act(async () =>
      root.render(
        createElement(HomePageHost, {
          locale,
          source: source.source,
          data: {
            call: async () => {
              throw new Error('unused')
            },
            sessionId: () => undefined,
            openSettings: () => undefined,
            startDraft: () => undefined,
          },
          onActive: (id) => {
            active = id
          },
        }),
      ),
    )
    await act(async () => host.querySelector('button')?.click())
    expect(host.textContent).toBe('1')
    await act(async () => {
      remove()
      remove = homeEntries.register(entry)
    })
    expect(host.textContent).toBe('0')
    expect(active).toBe(entry.id)
    await act(async () => remove())
    expect(host.textContent).toBe('')
    expect(active).toBeUndefined()
  } finally {
    await act(async () => {
      remove()
      root.unmount()
    })
    source.dispose()
    await ctx.fiber.dispose()
    host.remove()
  }
})
