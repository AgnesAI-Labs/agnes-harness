/** @vitest-environment happy-dom */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { type HistoryPageResult, HistorySearchPanel } from '../src/settings/history.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

const t = (key: string) =>
  ({
    historyHelp: 'Search titles and message text.',
    historyQuery: 'Message text',
    historyTitle: 'Title',
    historyWorkspace: 'Workspace',
    historySubmit: 'Search',
    historyEmpty: 'No matching sessions.',
    historyUnavailable: 'History search is unavailable.',
    historyNext: 'Next page',
    historyCapped: 'Results are capped.',
  })[key] ?? key

async function mount(search: (input: unknown) => Promise<HistoryPageResult>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(createElement(HistorySearchPanel, { t, search })))
  return host
}

function setInput(host: HTMLElement, testId: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`)
  if (!input) throw new Error(`missing ${testId}`)
  input.value = value
}

it('filters history and pages without searching before submit', async () => {
  const pages: HistoryPageResult[] = [
    {
      items: [
        { sessionId: 's1', title: 'Bridge notes', workspace: '/work/a', snippet: 'alpha bridge', ts: '1' },
      ],
      next: 'cursor-2',
    },
    { items: [{ sessionId: 's2', title: 'Later', workspace: '/work/a', snippet: 'next page', ts: '2' }] },
  ]
  const search = vi.fn(async () => pages.shift() ?? { items: [] })
  const host = await mount(search)
  expect(search).not.toHaveBeenCalled()
  setInput(host, 'history-search-query', 'alpha bridge')
  setInput(host, 'history-search-title', 'Bridge')
  setInput(host, 'history-search-workspace', '/work/a')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="history-search-submit"]')?.click(),
  )
  expect(search).toHaveBeenCalledWith({ query: 'alpha bridge', title: 'Bridge', workspace: '/work/a' })
  expect(host.querySelector('[data-testid="history-hit"]')?.textContent).toContain('Bridge notes')
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="history-search-next"]')?.click())
  expect(search).toHaveBeenLastCalledWith({
    query: 'alpha bridge',
    title: 'Bridge',
    workspace: '/work/a',
    cursor: 'cursor-2',
  })
  expect(host.querySelector('[data-testid="history-hit"]')?.textContent).toContain('Later')
  expect(host.querySelector('[data-testid="history-search-next"]')).toBeNull()
})

it('shows an empty result and a failure without leaving the page', async () => {
  const search = vi.fn(async () => ({ items: [] }))
  const host = await mount(search)
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="history-search-submit"]')?.click(),
  )
  expect(host.querySelector('[data-testid="history-search-status"]')?.textContent).toContain(
    'No matching sessions.',
  )
  search.mockRejectedValueOnce(new Error('down'))
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="history-search-submit"]')?.click(),
  )
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('History search is unavailable.')
})
