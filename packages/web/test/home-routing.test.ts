/** @vitest-environment happy-dom */

import { META_KEY, rpcError } from '@agnes/protocol'
import { type Client, JsonRpcError } from '@agnes/sdk/browser'
import { homeNavigation } from '@agnes/web-client'
import { afterEach, expect, it, vi } from 'vitest'
import { installBackendFrameBridge } from '../src/backends/frame-bridge.js'
import * as frameContext from '../src/backends/frame-context.js'
import { bindHomeRouting } from '../src/pages/host.js'

afterEach(() => {
  vi.useRealTimers()
  homeNavigation.close()
  history.replaceState(null, '', '/')
})

it.each(['supported', 'old', 'mismatch', 'local'] as const)(
  'negotiates display labels and caches an exact old-parameter downgrade (%s)',
  async (mode) => {
    vi.useFakeTimers()
    const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({
      parentOrigin: location.origin,
      ...(mode === 'local' ? {} : { remote: 'http://cloud.test:8443' }),
    })
    const publish = vi.spyOn(window.parent, 'postMessage')
    const list = vi.fn(async (params: { includePromptTitles?: boolean }) => {
      if (mode === 'mismatch' && params.includePromptTitles)
        throw new JsonRpcError(
          rpcError('INVALID_PARAMS', {
            code: 'UNKNOWN_KEY',
            key: 'includePromptTitles',
            path: '/includePromptTitles',
          }),
        )
      return { items: [] }
    })
    const client = {
      initialize: async () => ({
        capabilities: { _meta: { [META_KEY]: { sessionPromptTitles: mode !== 'old' } } },
      }),
      on: () => () => {},
      session: { list, activity: async () => ({ items: [] }) },
    } as unknown as Client
    const stop = installBackendFrameBridge(client)
    try {
      window.dispatchEvent(new CustomEvent('agnes:backend-frame-ready'))
      await vi.waitFor(() =>
        expect(
          publish.mock.calls.some(([message]) => message.kind === 'state' && message.snapshot.connected),
        ).toBe(true),
      )
      expect(list.mock.calls.map(([params]) => params.includePromptTitles)).toEqual(
        mode === 'mismatch' ? [true, undefined] : [mode === 'supported' ? true : undefined],
      )
      await vi.advanceTimersByTimeAsync(2000)
      expect(list.mock.calls.at(-1)?.[0].includePromptTitles).toBe(mode === 'supported' ? true : undefined)
      expect(list).toHaveBeenCalledTimes(mode === 'mismatch' ? 3 : 2)
    } finally {
      stop()
      publish.mockRestore()
      frame.mockRestore()
    }
  },
)

it.each([
  rpcError('CAPABILITY_DENIED'),
  rpcError('INVALID_PARAMS', { code: 'UNKNOWN_KEY', key: 'limit', path: '/limit' }),
  rpcError('INVALID_PARAMS', { code: 'TYPE', key: 'includePromptTitles', path: '/includePromptTitles' }),
])('does not downgrade unrelated display-list errors ($data.code)', async (failure) => {
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({
    parentOrigin: location.origin,
    remote: 'http://cloud.test:8443',
  })
  const publish = vi.spyOn(window.parent, 'postMessage')
  const list = vi.fn(async () => {
    throw new JsonRpcError(failure)
  })
  const client = {
    initialize: async () => ({ capabilities: { _meta: { [META_KEY]: { sessionPromptTitles: true } } } }),
    on: () => () => {},
    session: { list, activity: async () => ({ items: [] }) },
  } as unknown as Client
  const stop = installBackendFrameBridge(client)
  try {
    window.dispatchEvent(new CustomEvent('agnes:backend-frame-ready'))
    await vi.waitFor(() =>
      expect(publish.mock.calls.some(([message]) => message.kind === 'state' && message.snapshot.error)).toBe(
        true,
      ),
    )
    expect(list).toHaveBeenCalledTimes(1)
  } finally {
    stop()
    publish.mockRestore()
    frame.mockRestore()
  }
})

it('does not start a display-list read when disposed during capability negotiation', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const initialize = vi.fn(async () => {
    await gate
    return { capabilities: {} }
  })
  const list = vi.fn(async () => ({ items: [] }))
  const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({ parentOrigin: location.origin })
  const stop = installBackendFrameBridge({
    initialize,
    on: () => () => {},
    session: { list },
  } as unknown as Client)
  try {
    window.dispatchEvent(new CustomEvent('agnes:backend-frame-ready'))
    expect(initialize).toHaveBeenCalledTimes(1)
    stop()
    release()
    await initialize.mock.results[0]?.value
    expect(list).not.toHaveBeenCalled()
  } finally {
    stop()
    release()
    frame.mockRestore()
  }
})

it.each([undefined, 'http://cloud.test:8443'])(
  'returns from every sidebar page to a session through the backend bridge (remote=%s)',
  (remote) => {
    const url = new URL('/?session=current&workspaceId=w', location.origin)
    if (remote) url.searchParams.set('remote', remote)
    history.replaceState(null, '', url)
    const frame = vi.spyOn(frameContext, 'backendFrame').mockReturnValue({ parentOrigin: location.origin })
    const stopRouting = bindHomeRouting()
    const client = {
      initialize: async () => ({ capabilities: {} }),
      on: () => () => {},
      session: { list: async () => ({ items: [] }), activity: async () => ({ items: [] }) },
    } as unknown as Client
    const stopBridge = installBackendFrameBridge(client)
    try {
      window.dispatchEvent(new CustomEvent('agnes:backend-frame-ready'))
      for (const page of ['plugins', 'agents', 'automation', 'mhs', 'fixture#overview']) {
        const sessionId = page === 'agents' ? 'another' : 'current'
        if (page.includes('#')) homeNavigation.openRef(page, { tab: 'details' })
        else homeNavigation.open(page, { tab: 'details' })
        expect(homeNavigation.getSnapshot()).toBeDefined()
        window.dispatchEvent(
          new MessageEvent('message', {
            origin: location.origin,
            source: window.parent,
            data: {
              type: 'agh.backend.command/v1',
              commandId: crypto.randomUUID(),
              kind: 'session',
              sessionId,
            },
          }),
        )
        expect(homeNavigation.getSnapshot()).toBeUndefined()
        const params = new URLSearchParams(location.search)
        expect(params.get('session')).toBe(sessionId)
        expect(params.get('workspaceId')).toBe('w')
        expect(params.get('remote')).toBe(remote ?? null)
        for (const key of ['page', 'pagePackage', 'tab']) expect(params.has(key)).toBe(false)
      }
    } finally {
      stopBridge()
      stopRouting()
      frame.mockRestore()
    }
  },
)

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

it('a plugin home page cannot call managedInput.decide through HomePageData.call', async () => {
  const { Context } = await import('@agnes/cordis')
  const { homeEntries, LocaleService } = await import('@agnes/web-client')
  const { createDocumentLocaleSource } = await import('@agnes/web-ui')
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { HomePageHost } = await import('../src/pages/host.js')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const ctx = new Context()
  const locale = new LocaleService(ctx, 'en')
  const source = createDocumentLocaleSource({})
  const host = document.createElement('main')
  document.body.append(host)
  const root = createRoot(host)
  const sent: string[] = []
  const send = async <T>(method: string): Promise<T> => {
    sent.push(method)
    return { ok: true } as T
  }
  const outcomes: unknown[] = []
  function PluginPage({ context }: { context: import('@agnes/web-client').UiExtensionContext }) {
    const data = context.data as import('../src/pages/host.js').HomePageData
    if (!outcomes.length)
      for (const call of [data.call, data.channelCall])
        for (const method of ['_agnes/v1/managedInput.decide', '_agnes/v1/session.list'])
          outcomes.push(
            call?.(method, {}).then(
              () => 'sent',
              (error: { data?: { code?: string } }) => error.data?.code,
            ),
          )
    return null
  }
  const remove = homeEntries.registerOwned('@example/plugin', {
    id: 'example.page',
    order: 1,
    icon: 'plug',
    titleKey: 'example',
    component: PluginPage,
  })
  try {
    homeNavigation.openRef('@example/plugin#example.page')
    await act(async () =>
      root.render(
        createElement(HomePageHost, {
          locale,
          source: source.source,
          data: {
            call: send,
            channelCall: send,
            sessionId: () => undefined,
            openSettings: () => undefined,
            startDraft: () => undefined,
          },
          onActive: () => undefined,
        }),
      ),
    )
    expect(await Promise.all(outcomes)).toEqual(['CAPABILITY_DENIED', 'sent', 'CAPABILITY_DENIED', 'sent'])
    expect(sent).toEqual(['_agnes/v1/session.list', '_agnes/v1/session.list'])
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
