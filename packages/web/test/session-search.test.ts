/** @vitest-environment happy-dom */

import { expect, it } from 'vitest'
import { groupSessionHits, isSessionSearchShortcut, snippetParts } from '../src/session-search.js'

const hit = (sessionId: string, snippet: string, title = `Session ${sessionId}`) => ({
  sessionId,
  title,
  workspace: '/work/app',
  snippet,
  ts: '2026-10-14T00:00:00Z',
})

it('groups hits by session in first-hit order and keeps two distinct lines per session', () => {
  const groups = groupSessionHits([
    hit('a', 'first [refund]'),
    hit('b', 'other [refund]'),
    hit('a', 'first [refund]'),
    hit('a', 'second [refund]'),
    hit('a', 'third [refund]'),
  ])
  expect(groups.map((group) => group.sessionId)).toEqual(['a', 'b'])
  expect(groups[0]).toMatchObject({
    title: 'Session a',
    workspace: '/work/app',
    snippets: ['first [refund]', 'second [refund]'],
    matches: 4,
  })
  expect(groups[1]?.matches).toBe(1)
})

it('splits a snippet into matched and plain runs', () => {
  expect(snippetParts('…ask about the [refund] window, then [refund] it')).toEqual([
    { text: '…ask about the ', match: false },
    { text: 'refund', match: true },
    { text: ' window, then ', match: false },
    { text: 'refund', match: true },
    { text: ' it', match: false },
  ])
  expect(snippetParts('no match here')).toEqual([{ text: 'no match here', match: false }])
  expect(snippetParts('empty [] stays')).toEqual([{ text: 'empty [] stays', match: false }])
})

it('opens on the platform chord only', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
  expect(isSessionSearchShortcut(key({ key: 'k', metaKey: true }))).toBe(true)
  expect(isSessionSearchShortcut(key({ key: 'K', ctrlKey: true }))).toBe(true)
  expect(isSessionSearchShortcut(key({ key: 'k' }))).toBe(false)
  expect(isSessionSearchShortcut(key({ key: 'k', metaKey: true, shiftKey: true }))).toBe(false)
  expect(isSessionSearchShortcut(key({ key: 'k', ctrlKey: true, altKey: true }))).toBe(false)
})

it('isolates pagination from later queries and closing, and permits retry after a page fails', async () => {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SessionSearch } = await import('../src/session-search.js')
  const { vi } = await import('vitest')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  const required = <T>(value: T | null | undefined): T => {
    if (value == null) throw new Error('Missing search control or request')
    return value
  }
  const pending: {
    input: import('../src/session-search.js').SessionSearchInput
    signal: AbortSignal
    resolve(page: import('../src/session-search.js').SessionSearchPage): void
    reject(error: Error): void
  }[] = []
  const request: import('../src/session-search.js').SessionSearchRequest = (input, signal) =>
    new Promise((resolve, reject) => pending.push({ input, signal, resolve, reject }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (open: boolean) =>
    act(async () =>
      root.render(
        createElement(SessionSearch, {
          open,
          t: (key: string) => key,
          recent: [],
          titleOf: () => undefined,
          request,
          onOpen: () => undefined,
          onClose: () => undefined,
        }),
      ),
    )
  const type = async (value: string) => {
    await act(async () => {
      const input = required(document.querySelector<HTMLInputElement>('[data-testid="session-search-input"]'))
      required(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set).call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
  }
  const more = () =>
    required(document.querySelector<HTMLButtonElement>('[data-testid="session-search-more"]'))
  const results = () => required(document.querySelector('[data-testid="session-search-results"]')).textContent
  try {
    await render(true)
    await type('first')
    await act(async () => required(pending[0]).resolve({ items: [hit('first', 'first')], next: 'page-2' }))
    await act(async () => more().click())
    expect(more().disabled).toBe(true)
    await type('second')
    expect(required(pending[1]).signal.aborted).toBe(true)
    await act(async () => {
      required(pending[2]).resolve({ items: [hit('second', 'second')], next: 'second-2' })
      required(pending[1]).resolve({ items: [hit('stale', 'stale')], next: 'stale-3' })
    })
    expect(results()).toContain('Session second')
    expect(results()).not.toContain('stale')
    await act(async () => more().click())
    await act(async () => required(pending[3]).reject(new Error('offline')))
    expect(document.body.textContent).toContain('home.search.unavailable')
    expect(more().disabled).toBe(false)
    await act(async () => more().click())
    expect(required(pending[4]).input).toMatchObject({ query: 'second', cursor: 'second-2' })
    await act(async () => required(pending[4]).resolve({ items: [hit('last', 'last')], next: 'second-3' }))
    expect(results()).toContain('Session last')
    await act(async () => more().click())
    await render(false)
    expect(required(pending[5]).signal.aborted).toBe(true)
    await act(async () => required(pending[5]).resolve({ items: [hit('closed', 'closed')] }))
    await render(true)
    expect(results()).not.toContain('closed')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  }
})

it('caps the empty-query list at eight and names both the recent count and the sidebar total', async () => {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { SessionSearch } = await import('../src/session-search.js')
  const { webLocaleCatalog } = await import('@agnes/web-foundation/locale-catalog')
  const { vi } = await import('vitest')
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  const translate = (locale: 'en' | 'zh-CN') => {
    const dictionary = webLocaleCatalog[locale] as Record<string, string>
    return (key: string, vars?: Readonly<Record<string, string | number>>) =>
      (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
        vars && Object.hasOwn(vars, name) ? String(vars[name]) : match,
      )
  }
  const recent = Array.from({ length: 10 }, (_, index) => ({
    sessionId: `recent-${index}`,
    title: `Recent ${index}`,
    workspace: '/work/app',
  }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = (locale: 'en' | 'zh-CN', total?: number) =>
    act(async () =>
      root.render(
        createElement(SessionSearch, {
          open: true,
          t: translate(locale),
          recent,
          total,
          titleOf: () => undefined,
          request: async () => ({
            items: [
              {
                sessionId: 'matched',
                title: 'Matched session',
                workspace: '/work/app',
                snippet: 'refund [refund]',
                ts: '2026-10-14T00:00:00Z',
              },
            ],
          }),
          onOpen: () => undefined,
          onClose: () => undefined,
        }),
      ),
    )
  const type = async (value: string) => {
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="session-search-input"]')
      if (!input) throw new Error('Missing search input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180)
    })
  }
  const label = () => document.querySelector('.session-search-label')?.textContent
  const totalLine = () => document.querySelector('[data-testid="session-search-total"]')?.textContent
  try {
    await render('zh-CN', 21)
    expect(document.querySelectorAll('[data-testid="session-search-option"]')).toHaveLength(8)
    expect(label()).toBe('最近 8 个会话')
    expect(totalLine()).toBe('侧栏共 21 个会话')
    await render('en', 21)
    expect(label()).toBe('Recent 8 sessions')
    expect(totalLine()).toBe('21 sessions in the sidebar')
    await render('en')
    expect(label()).toBe('Recent 8 sessions')
    expect(document.querySelector('[data-testid="session-search-total"]')).toBeNull()
    // A query switches the panel to indexed results, so the sidebar note would mix two counts.
    await render('en', 21)
    await type('refund')
    expect(document.querySelectorAll('[data-testid="session-search-option"]')).toHaveLength(1)
    expect(document.querySelector('[data-testid="session-search-results"]')?.textContent).toContain(
      'Matched session',
    )
    expect(document.querySelector('.session-search-label')).toBeNull()
    expect(document.querySelector('[data-testid="session-search-total"]')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  }
})
