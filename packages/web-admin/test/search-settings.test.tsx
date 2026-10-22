/** @vitest-environment happy-dom */
import { PushStack } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsCatalog } from '../src/settings/locales.js'
import { SearchPanel } from '../src/settings/search.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string) => settingsCatalog.en[key] ?? settingsCatalog['zh-CN'][key] ?? key
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})

const brave = {
  id: 'brave',
  label: 'Brave',
  needsKey: true,
  enabled: false,
  endpoint: 'https://api.search.brave.com',
  maxResults: 5,
  timeoutMs: 15000,
  ratePerMinute: 30,
  secretRef: 'secret://search/brave',
  secretConfigured: false,
  isDefault: false,
  ready: false,
}
const status = {
  version: 1,
  configured: false,
  invalid: false,
  defaultProvider: null,
  providers: ['brave', 'tavily', 'exa', 'perplexity', 'searxng'].map((id) => ({
    ...brave,
    id,
    label: id,
    secretRef: `secret://search/${id}`,
    needsKey: id !== 'searxng',
    endpoint: id === 'searxng' ? '' : brave.endpoint,
  })),
}

it('shows the unconfigured state and saves a key without rendering it again', async () => {
  const key = 'ui-search-key-value'
  let saved = false
  let refuseProbe = true
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST')
      return Response.json(
        refuseProbe
          ? { ok: false }
          : {
              ok: true,
              results: [
                { title: 'Fixture result', url: 'https://example.test/result', snippet: 'Synthetic result' },
              ],
            },
      )
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { apiKey?: string; provider?: { id?: string } }
      expect(body.apiKey).toBe(key)
      expect(body.provider?.id).toBe('brave')
      saved = true
      return Response.json({
        ...status,
        configured: true,
        defaultProvider: 'brave',
        providers: status.providers.map((row) =>
          row.id === 'brave'
            ? { ...row, enabled: true, secretConfigured: true, isDefault: true, ready: true }
            : row,
        ),
      })
    }
    return Response.json(saved ? { ...status, configured: true, defaultProvider: 'brave' } : status)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(
        PushStack,
        { rootTitle: 'Plugins' },
        createElement(SearchPanel, { t, canSave: true, fetcher }),
      ),
    )
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="search-add"]')?.click())
  // Adding a service is a page over 网页搜索, with 返回 and where it sits.
  expect(document.querySelector('[data-testid="push-page-search-engine"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="push-header"]')?.textContent).toContain('Plugins')
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="push-back"]')?.click())
  expect(document.querySelector('[data-testid="push-page-search-engine"]')).toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="search-add"]')?.click())
  const panel = document.body
  expect(panel.querySelector<HTMLInputElement>('[data-testid="search-endpoint"]')?.value).toBe(
    'https://api.search.brave.com',
  )
  expect(panel.querySelector('[data-testid="search-empty"]')?.textContent).toContain('No search service')
  // A service that was never set up is chosen in the dialog; the page lists only what is in use.
  expect(panel.querySelector('[data-testid="search-provider-brave"]')).toBeNull()
  expect(
    [...panel.querySelectorAll<HTMLOptionElement>('[data-testid="search-edit-provider"] option')].map(
      (option) => option.value,
    ),
  ).toEqual(['brave', 'tavily', 'exa', 'perplexity', 'searxng'])
  expect(panel.querySelector<HTMLElement>('[data-testid="search-technical"]')?.dataset.open).toBe('false')
  expect(settingsCatalog.en.searchApiKeyHint).not.toContain('secret://')
  expect(panel.querySelector('[data-testid="search-secret-exa"]')?.textContent).toContain(
    'secret://search/exa',
  )
  const input = panel.querySelector<HTMLInputElement>('[data-testid="search-api-key"]')
  if (!input) throw new Error('missing key field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const count = panel.querySelector<HTMLInputElement>('[data-testid="search-max-results"]')
  expect(count?.type).toBe('text')
  expect(count?.inputMode).toBe('numeric')
  await act(async () => {
    setter?.call(count, '2.5')
    count?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="search-save"]')?.click())
  expect(saved).toBe(false)
  expect(panel.querySelector('#search-max-results-error')?.textContent).toContain('whole number from 1 to 10')
  expect(count?.getAttribute('aria-invalid')).toBe('true')
  expect(count?.getAttribute('aria-describedby')).toBe('search-max-results-error')
  expect(document.activeElement).toBe(count)
  await act(async () => {
    setter?.call(count, '5')
    count?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    setter?.call(input, key)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    panel.querySelector<HTMLButtonElement>('[data-testid="search-save"]')?.click()
  })
  expect(panel.querySelector('[data-testid="search-provider-brave"]')).not.toBeNull()
  expect(panel.querySelector('[data-testid="search-enabled-brave"]')?.getAttribute('role')).toBe('switch')
  expect(panel.querySelector('[data-testid="search-enabled-brave"]')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(count?.getAttribute('aria-invalid')).toBeNull()
  expect(saved).toBe(true)
  expect(host.textContent).not.toContain(key)
  expect(panel.querySelector('[data-testid="search-api-key"]')?.getAttribute('value') ?? '').not.toContain(
    key,
  )
  expect(settingsCatalog['zh-CN'].searchEmpty).toContain('尚未配置')
  const query = panel.querySelector<HTMLInputElement>('[data-testid="search-test-query"]')
  await act(async () => {
    setter?.call(query, 'fixture')
    query?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.click())
  expect(panel.querySelector('[data-testid="search-test-error"]')?.textContent).toMatch(
    /Search failed.*\d+ ms/,
  )
  expect(panel.querySelector('[data-testid="search-test-error"]')?.textContent).not.toContain('saved')
  refuseProbe = false
  await act(async () => panel.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.click())
  expect(panel.querySelector('[data-testid="search-test-error"]')).toBeNull()
  expect(panel.querySelector('[data-testid="search-notice"]')?.textContent).toMatch(/Test passed.*\d+ ms/)
  expect(panel.querySelector('[data-testid="search-test-result"] a')?.getAttribute('href')).toBe(
    'https://example.test/result',
  )
})

it('offers an explicit default action for a ready service and opens the saved settings from its row', async () => {
  const ready = { ...brave, enabled: true, ready: true, secretConfigured: true }
  let refuseDefault = true
  let current = { ...status, defaultProvider: null as string | null, providers: [ready] }
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      if (refuseDefault) throw new Error('offline')
      expect(body.defaultProvider).toBe('brave')
      expect(body.provider.enabled).toBe(true)
      current = {
        ...current,
        configured: true,
        defaultProvider: 'brave',
        providers: [{ ...ready, isDefault: true }],
      }
    }
    return Response.json(current)
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        PushStack,
        { rootTitle: 'Plugins' },
        createElement(SearchPanel, { t, canSave: true, fetcher }),
      ),
    ),
  )
  expect(host.querySelector('[data-testid="search-empty"]')).toBeNull()
  expect(host.querySelector('[data-testid="search-needs-default"]')?.textContent).toContain('default')
  expect(host.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.disabled).toBe(true)
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="search-set-default-brave"]')?.click(),
  )
  expect(host.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.disabled).toBe(true)
  expect(host.querySelector('[data-testid="search-error"]')).not.toBeNull()
  refuseDefault = false
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="search-set-default-brave"]')?.click(),
  )
  expect(host.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.disabled).toBe(false)
  expect(host.querySelector('[data-testid="search-needs-default"]')).toBeNull()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="search-provider-brave"] h3 button')?.click(),
  )
  expect(document.querySelector('[data-testid="search-editor-enabled"]')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(document.querySelector('[data-testid="search-editor-default"]')?.getAttribute('aria-checked')).toBe(
    'true',
  )
})

it.each([
  { name: 'the default service', target: 'searxng', expected: null },
  { name: 'a non-default service', target: 'brave', expected: 'searxng' },
])('disabling $name from its row sends a default the daemon accepts', async ({ target, expected }) => {
  const ready = { ...brave, enabled: true, ready: true, secretConfigured: true }
  const searxng = {
    ...ready,
    id: 'searxng',
    needsKey: false,
    endpoint: 'http://127.0.0.1:1',
    isDefault: true,
  }
  const current = { ...status, configured: true, defaultProvider: 'searxng', providers: [ready, searxng] }
  const bodies: Array<{ defaultProvider: string | null; provider: { id: string; enabled: boolean } }> = []
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      // The daemon refuses a default that is not enabled (providerReady).
      if (body.defaultProvider === body.provider.id && !body.provider.enabled)
        return Response.json({ ok: false, code: 'SEARCH_INVALID' }, { status: 400 })
    }
    return Response.json(current)
  })
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  roots.push(root)
  await act(async () =>
    root.render(
      createElement(
        PushStack,
        { rootTitle: 'Search' },
        createElement(SearchPanel, { t, canSave: true, fetcher }),
      ),
    ),
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>(`[data-testid="search-enabled-${target}"]`)?.click(),
  )
  expect(bodies).toHaveLength(1)
  expect(bodies[0]?.provider).toMatchObject({ id: target, enabled: false })
  expect(bodies[0]?.defaultProvider).toBe(expected)
  expect(host.querySelector('[data-testid="search-error"]')).toBeNull()
})

it.each(['saved', 'failed'] as const)(
  'discards a stale search probe %s after the transport changes',
  async (outcome) => {
    let finish!: (response: Response) => void
    const first: typeof fetch = async (_url, init) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : Response.json({ ...status, configured: true, defaultProvider: 'brave' })
    const next: typeof fetch = async () =>
      Response.json({ ...status, configured: true, defaultProvider: 'brave' })
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    roots.push(root)
    const draw = (fetcher: typeof fetch) =>
      act(async () =>
        root.render(
          createElement(
            PushStack,
            { rootTitle: 'Search' },
            createElement(SearchPanel, { t, canSave: true, fetcher }),
          ),
        ),
      )
    await draw(first)
    await act(async () => {
      const input = host.querySelector<HTMLInputElement>('[data-testid="search-test-query"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'synthetic query',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="search-test"]')?.click())
    expect(finish).toBeTypeOf('function')
    await draw(next)
    await act(async () =>
      finish(
        outcome === 'saved'
          ? Response.json({
              ok: true,
              results: [{ title: 'Old result', url: 'https://example.test/old', snippet: '' }],
            })
          : Response.json({}, { status: 500 }),
      ),
    )
    expect(host.textContent).not.toContain('Old result')
    expect(host.querySelector('[data-testid="search-test-error"]')).toBeNull()
    expect(host.querySelector('[data-testid="search-notice"]')).toBeNull()
  },
)
