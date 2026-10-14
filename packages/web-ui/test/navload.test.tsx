/** @vitest-environment happy-dom */
import { act, createElement, Fragment, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearResources,
  invalidateResource,
  Loadable,
  mountRegion,
  PushPage,
  PushStack,
  searchParamRoute,
  TopProgress,
  trackPageRequest,
  usePushStack,
  useResource,
} from '../src/index.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  clearResources()
  vi.useRealTimers()
})
function render(element: ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  act(() => {
    cleanups.push(mountRegion(host, element as Parameters<typeof mountRegion>[1]))
  })
  return host
}
const q = (host: Element, selector: string) => host.querySelector<HTMLElement>(selector)
const click = (element: Element | null) => act(() => (element as HTMLElement).click())

function Opener({ id }: { id: string }) {
  const nav = usePushStack()
  return createElement(
    'button',
    { type: 'button', 'data-testid': `open-${id}`, onClick: () => nav.open(id) },
    id,
  )
}
function Replacer({ id }: { id: string }) {
  const nav = usePushStack()
  return createElement(
    'button',
    { type: 'button', 'data-testid': `replace-${id}`, onClick: () => nav.replace(id) },
    id,
  )
}
function Pages({ route = false }: { route?: boolean }) {
  return createElement(
    PushStack,
    {
      rootTitle: 'Agent FDE',
      historyKey: 'navloadTest',
      ...(route ? { route: searchParamRoute('view') } : {}),
    },
    createElement('p', { 'data-testid': 'root' }, 'gallery'),
    createElement(Opener, { id: 'crm' }),
    createElement(
      PushPage,
      { id: 'crm', title: 'CRM 跟进' },
      createElement('p', { 'data-testid': 'crm-body' }, 'crm'),
      createElement(Opener, { id: 'edit' }),
      createElement(Replacer, { id: 'done' }),
    ),
    createElement(
      PushPage,
      { id: 'edit', title: '编辑' },
      createElement('p', { 'data-testid': 'edit-body' }, 'e'),
    ),
    createElement(
      PushPage,
      { id: 'done', title: '完成' },
      createElement('p', { 'data-testid': 'done-body' }, 'd'),
    ),
  )
}

describe('push pages', () => {
  beforeEach(() => history.replaceState(null, '', '/'))

  it('opens in place with back and a breadcrumb, and the root keeps its state', async () => {
    const host = render(createElement(Pages))
    click(q(host, '[data-testid="open-crm"]'))
    expect(q(host, '[data-testid="root"]')?.closest('[hidden]')).not.toBeNull()
    expect(q(host, '[data-testid="crm-body"]')).not.toBeNull()
    expect(q(host, '[data-testid="push-header"] h2')?.textContent).toBe('CRM 跟进')
    expect(q(host, '[data-testid="push-crumb-0"]')?.textContent).toBe('Agent FDE')
    click(q(host, '[data-testid="open-edit"]'))
    expect([...host.querySelectorAll('.agh-push-crumbs li')].map((item) => item.textContent)).toEqual([
      'Agent FDE',
      'CRM 跟进',
      '编辑',
    ])
    // A crumb returns to its level; the root crumb to the page itself.
    click(q(host, '[data-testid="push-crumb-1"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="push-header"] h2')?.textContent).toBe('CRM 跟进'))
    click(q(host, '[data-testid="push-back"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="root"]')?.closest('[hidden]')).toBeNull())
    expect(q(host, '[data-testid="push-header"]')).toBeNull()
  })

  it('leaves a page with the browser back button', async () => {
    const host = render(createElement(Pages))
    click(q(host, '[data-testid="open-crm"]'))
    expect(history.state?.navloadTest).toBe(1)
    act(() => {
      history.replaceState({ navloadTest: 0 }, '')
      window.dispatchEvent(new PopStateEvent('popstate', { state: { navloadTest: 0 } }))
    })
    expect(q(host, '[data-testid="crm-body"]')).toBeNull()
  })

  it('opens what the address names, writes each level to it and follows a back step', () => {
    history.replaceState(null, '', '/?page=agents&view=crm/edit')
    const host = render(createElement(Pages, { route: true }))
    expect(q(host, '[data-testid="edit-body"]')).not.toBeNull()
    // Other parameters are left alone.
    click(q(host, '[data-testid="push-back"]'))
    expect(location.search).toBe('?page=agents&view=crm')
    click(q(host, '[data-testid="open-edit"]'))
    expect(location.search).toBe('?page=agents&view=crm/edit')
    act(() => {
      history.replaceState(null, '', '/?page=agents')
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }))
    })
    expect(q(host, '[data-testid="root"]')?.closest('[hidden]')).toBeNull()
  })

  it('keeps a level that holds a slash as one level', () => {
    const route = searchParamRoute('view')
    history.replaceState(null, '', route.href(['plugin:@agnes/plugin-helper', 'edit']))
    expect(location.search).toBe('?view=plugin%3A%40agnes%2Fplugin-helper/edit')
    expect(route.read()).toEqual(['plugin:@agnes/plugin-helper', 'edit'])
  })

  it('swaps the top page for the next step of a flow without a new history entry', () => {
    const host = render(createElement(Pages, { route: true }))
    click(q(host, '[data-testid="open-crm"]'))
    const length = history.length
    click(q(host, '[data-testid="replace-done"]'))
    expect(history.length).toBe(length)
    expect(location.search).toBe('?view=done')
    expect(q(host, '[data-testid="done-body"]')).not.toBeNull()
    expect([...host.querySelectorAll('.agh-push-crumbs li')].map((item) => item.textContent)).toEqual([
      'Agent FDE',
      '完成',
    ])
  })
})

function Reader({ name, read }: { name: string; read: () => Promise<string> }) {
  const state = useResource(name, read)
  return createElement(
    Loadable,
    {
      loading: state.loading,
      error: state.error,
      hasData: state.data !== undefined,
      onRetry: state.reload,
      shape: 'rows',
    },
    createElement('p', { 'data-testid': 'content' }, state.data),
  )
}

describe('loading', () => {
  it('shows nothing for 200 ms, then a placeholder, and says it is still loading after 3 s', async () => {
    vi.useFakeTimers()
    const host = render(createElement(Reader, { name: 'slow', read: () => new Promise<string>(() => {}) }))
    expect(q(host, '[data-testid="loadable-placeholder"]')).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(200))
    expect(q(host, '[data-testid="loadable-placeholder"]')?.dataset.shape).toBe('rows')
    expect(q(host, '.agh-loadable-status')?.dataset.slow).toBeUndefined()
    await act(async () => vi.advanceTimersByTimeAsync(2800))
    expect(q(host, '.agh-loadable-status')?.textContent).toBe('Still loading…')
  })

  it('shows a cached read at once and refreshes it behind', async () => {
    let value = 'first'
    const read = vi.fn(async () => value)
    const first = render(createElement(Reader, { name: 'agents:list', read }))
    await vi.waitFor(() => expect(q(first, '[data-testid="content"]')?.textContent).toBe('first'))
    for (const cleanup of cleanups.splice(0)) cleanup()
    value = 'second'
    const again = render(createElement(Reader, { name: 'agents:list', read }))
    // No placeholder and no wait: the cached value is there on the first render.
    expect(q(again, '[data-testid="content"]')?.textContent).toBe('first')
    expect(q(again, '[data-testid="content"]')?.closest('[data-fade]')).toBeNull()
    await vi.waitFor(() => expect(q(again, '[data-testid="content"]')?.textContent).toBe('second'))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('reads again after a write invalidates the key, and shares one read between readers', async () => {
    let value = 'a'
    const read = vi.fn(async () => value)
    const host = render(
      createElement(
        Fragment,
        null,
        createElement(Reader, { name: 'plugins:list', read }),
        createElement(Reader, { name: 'plugins:list', read }),
      ),
    )
    await vi.waitFor(() => expect(host.querySelectorAll('[data-testid="content"]')[1]?.textContent).toBe('a'))
    expect(read).toHaveBeenCalledTimes(1)
    value = 'b'
    act(() => invalidateResource('plugins'))
    await vi.waitFor(() => expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('b'))
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps what it showed when a refresh fails, with the reason and 重试', async () => {
    let fail = false
    const read = vi.fn(async () => {
      if (fail) throw new Error('backend unavailable')
      return 'kept'
    })
    const host = render(createElement(Reader, { name: 'automation', read }))
    await vi.waitFor(() => expect(q(host, '[data-testid="content"]')?.textContent).toBe('kept'))
    fail = true
    act(() => invalidateResource('automation'))
    await vi.waitFor(() =>
      expect(q(host, '[data-testid="loadable-error"]')?.textContent).toContain('backend unavailable'),
    )
    expect(q(host, '[data-testid="content"]')?.textContent).toBe('kept')
    fail = false
    click(q(host, '[data-testid="loadable-retry"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="loadable-error"]')).toBeNull())
  })

  it('runs the top progress bar while a page-level request is in flight', async () => {
    const host = render(createElement(TopProgress))
    const bar = q(host, '[data-testid="top-progress"]')
    expect(bar?.dataset.active).toBeUndefined()
    let finish!: () => void
    const work = trackPageRequest(new Promise<void>((resolve) => (finish = resolve)))
    await vi.waitFor(() => expect(bar?.dataset.active).toBe('true'))
    finish()
    await act(async () => work)
    await vi.waitFor(() => expect(bar?.dataset.active).toBeUndefined())
  })
})
