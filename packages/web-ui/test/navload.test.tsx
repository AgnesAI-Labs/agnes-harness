/** @vitest-environment happy-dom */
import { act, createElement, Fragment, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearResources,
  invalidateResource,
  Loadable,
  mountRegion,
  PushCrumbs,
  PushPage,
  PushStack,
  searchParamRoute,
  setResource,
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
function Finisher() {
  const nav = usePushStack()
  return createElement(
    'button',
    { type: 'button', 'data-testid': 'finish', onClick: () => nav.finish() },
    'Finish',
  )
}
function Pages({
  route = false,
  historyKey = 'navloadTest',
  routeParam = 'view',
}: {
  route?: boolean
  historyKey?: string
  routeParam?: string
}) {
  return createElement(
    PushStack,
    {
      rootTitle: 'Agent FDE',
      historyKey,
      ...(route ? { route: searchParamRoute(routeParam) } : {}),
    },
    createElement('p', { 'data-testid': 'root' }, 'gallery'),
    createElement(Opener, { id: 'crm' }),
    createElement(
      PushPage,
      { id: 'crm', title: 'CRM 跟进' },
      createElement('p', { 'data-testid': 'crm-body' }, 'crm'),
      createElement(Opener, { id: 'edit' }),
      createElement(Replacer, { id: 'done' }),
      createElement(Finisher),
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

  it.each(['finish', 'cancel', 'browser-back', 'host-route'])(
    'review: root breadcrumb skips intervening settings history (%s)',
    async (exit) => {
      history.replaceState(null, '', '/?page=agents')
      const host = render(createElement(Pages, { route: true }))
      click(q(host, '[data-testid="open-crm"]'))
      const settings = render(
        createElement(Pages, { route: true, historyKey: 'settingsTest', routeParam: 'settings' }),
      )
      click(q(settings, '[data-testid="open-crm"]'))
      if (exit === 'finish') click(q(settings, '[data-testid="finish"]'))
      else if (exit === 'cancel') click(q(settings, '[data-testid="push-back"]'))
      else if (exit === 'browser-back') history.back()
      else history.pushState(null, '', '/?page=agents&view=crm')
      await vi.waitFor(() => expect(location.search).toBe('?page=agents&view=crm'))
      click(q(host, '[data-testid="open-edit"]'))
      click(q(host, '[data-testid="push-back"]'))
      await vi.waitFor(() => expect(location.search).toBe('?page=agents&view=crm'))
      history.forward()
      await vi.waitFor(() => {
        expect(location.search).toBe('?page=agents&view=crm/edit')
        expect(q(host, '[data-testid="edit-body"]')).not.toBeNull()
      })
      click(q(host, '[data-testid="push-crumb-0"]'))
      await vi.waitFor(() => expect(location.search).toBe('?page=agents'))
      expect(q(host, '[data-testid="push-header"]')).toBeNull()
    },
  )

  it('opens in place with the breadcrumb as the way back, and the root keeps its state', async () => {
    const host = render(createElement(Pages, { route: true }))
    click(q(host, '[data-testid="open-crm"]'))
    expect(q(host, '[data-testid="root"]')?.closest('[hidden]')).not.toBeNull()
    expect(q(host, '[data-testid="crm-body"]')).not.toBeNull()
    expect(q(host, '[data-testid="push-header"] h2')?.textContent).toBe('CRM 跟进')
    // Two levels: 「Agent FDE › CRM 跟进」, no leading ‹. The parent is the back control; no separate 返回.
    const back = q(host, '[data-testid="push-back"]')
    expect(back?.textContent).toBe('Agent FDE')
    expect(back?.querySelector('svg')).toBeNull()
    expect(back?.getAttribute('aria-label')).toBe('Back to Agent FDE')
    expect(host.querySelectorAll('[data-testid="push-header"] button')).toHaveLength(1)
    click(q(host, '[data-testid="open-edit"]'))
    // Three levels: 「Agent FDE › CRM 跟进 › 编辑」. Nothing leads the trail; the direct parent goes back.
    expect([...host.querySelectorAll('.agh-push-crumbs li')].map((item) => item.textContent)).toEqual([
      'Agent FDE',
      'CRM 跟进',
      '编辑',
    ])
    expect(q(host, '[data-testid="push-crumb-0"]')?.firstElementChild).toBeNull()
    expect(q(host, '[data-testid="push-back"]')?.textContent).toBe('CRM 跟进')
    expect(q(host, '[data-testid="push-back"]')?.querySelector('svg')).toBeNull()
    expect(q(host, '[data-testid="push-back"]')?.getAttribute('aria-label')).toBe('Back to CRM 跟进')
    click(q(host, '[data-testid="push-back"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="push-header"] h2')?.textContent).toBe('CRM 跟进'))
    // Any earlier level jumps straight to it: the root crumb returns to the page itself.
    click(q(host, '[data-testid="open-edit"]'))
    click(q(host, '[data-testid="push-crumb-0"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="root"]')?.closest('[hidden]')).toBeNull())
    expect(q(host, '[data-testid="push-header"]')).toBeNull()
    expect(location.search).toBe('')
    history.forward()
    await vi.waitFor(() => {
      expect(location.search).toBe('?view=crm')
      expect(q(host, '[data-testid="crm-body"]')).not.toBeNull()
    })
    history.forward()
    await vi.waitFor(() => {
      expect(location.search).toBe('?view=crm/edit')
      expect(q(host, '[data-testid="edit-body"]')).not.toBeNull()
    })
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
    click(q(host, '[data-testid="open-crm"]'))
    // Another host entry breaks ownership, even without an address route.
    history.pushState(null, '')
    click(q(host, '[data-testid="push-back"]'))
    expect(q(host, '[data-testid="push-header"]')).toBeNull()
    click(q(host, '[data-testid="open-crm"]'))
    click(q(host, '[data-testid="push-back"]'))
    await vi.waitFor(() => expect(q(host, '[data-testid="push-header"]')).toBeNull())
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
    // A completed settings frame leaves its own history entry at this same plugin address.
    const settings = render(
      createElement(Pages, { route: true, historyKey: 'settingsTest', routeParam: 'settings' }),
    )
    click(q(settings, '[data-testid="open-crm"]'))
    click(q(settings, '[data-testid="finish"]'))
    expect(q(settings, '[data-testid="push-header"]')).toBeNull()
    click(q(host, '[data-testid="push-back"]'))
    expect(location.search).toBe('?page=agents&view=crm')
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
    // Another page opens settings without changing the underlying detail route.
    const settings = searchParamRoute('settings')
    history.replaceState(null, '', settings.href(['security', 'auto-review']))
    expect(settings.read()).toEqual(['security', 'auto-review'])
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
    value = 'third'
    await act(async () => window.dispatchEvent(new Event('focus')))
    await vi.waitFor(() => expect(q(again, '[data-testid="content"]')?.textContent).toBe('third'))
    value = 'fourth'
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    await vi.waitFor(() => expect(q(again, '[data-testid="content"]')?.textContent).toBe('fourth'))
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
    act(() => window.dispatchEvent(new Event('focus')))
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

describe('startup check notice', () => {
  it('floats clear of headers: under the top bar when wide, along the bottom when narrow', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const css = readFileSync(resolve(__dirname, '../src/tokens.css'), 'utf8')
    const groups = readFileSync(resolve(__dirname, '../src/doctor-groups.css'), 'utf8')
    expect(groups).toMatch(
      /@container \(max-width: 560px\) \{[\s\S]*?\.agnes-doctor-footer-actions \{[^}]*flex-wrap: wrap;[^}]*flex-basis: 100%;/,
    )
    expect(css).toMatch(/\.agnes-doctor-notice \{\s*position: fixed;\s*top: 3\.5rem;/)
    expect(css).toMatch(
      /@media \(max-width: 900px\) \{\s*\.agnes-doctor-notice \{\s*top: auto;[^}]*bottom: max\(1rem, env\(safe-area-inset-bottom\)\);/,
    )
  })
})

describe('the breadcrumb on its own', () => {
  it('leads back from a view without a page header, keeps a host id, and has a fallback with no level above', () => {
    const back = vi.fn()
    const host = render(
      createElement(PushCrumbs, {
        title: 'pkg-a',
        crumbs: ['Candidates'],
        backTestId: 'candidate-back',
        backId: 'settings-back',
        onBack: back,
      }),
    )
    const crumb = q(host, '[data-testid="candidate-back"]')
    expect(crumb?.id).toBe('settings-back')
    expect(crumb?.getAttribute('aria-label')).toBe('Back to Candidates')
    expect(crumb?.querySelector('svg')).toBeNull()
    expect(host.textContent).toBe('Candidatespkg-a')
    click(crumb)
    expect(back).toHaveBeenCalledOnce()
    const disabled = render(
      createElement(PushCrumbs, { title: 'x', crumbs: [], disabled: true, onBack: back }),
    )
    // Nothing named above: the way back still shows, as 「返回」.
    expect(q(disabled, '[data-testid="push-back"]')?.textContent).toBe('Back')
    expect((q(disabled, '[data-testid="push-back"]') as HTMLButtonElement).disabled).toBe(true)
  })
})
it.each(['success', 'failure'])(
  'keeps a committed write when an older read ends with %s',
  async (outcome) => {
    let resolve!: (value: string) => void
    let reject!: (error: Error) => void
    const read = () =>
      new Promise<string>((yes, no) => {
        resolve = yes
        reject = no
      })
    const host = render(createElement(Reader, { name: 'settings:commit', read }))
    act(() => setResource('settings:commit', 'saved'))
    await act(async () => (outcome === 'success' ? resolve('old') : reject(new Error('old failure'))))
    expect(q(host, '[data-testid="content"]')?.textContent).toBe('saved')
    expect(q(host, '[data-testid="loadable-error"]')).toBeNull()
  },
)
