/** @vitest-environment happy-dom */
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
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
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
    root.render(createElement(SearchPanel, { t, canSave: true, fetcher }))
  })
  await vi.waitFor(() => {
    expect(host.querySelector<HTMLInputElement>('[data-testid="search-endpoint"]')?.value).toBe(
      'https://api.search.brave.com',
    )
  })
  expect(host.querySelector('[data-testid="search-empty"]')?.textContent).toContain('No search provider')
  expect(host.querySelector('[data-testid="search-provider-brave"]')).not.toBeNull()
  expect(host.querySelector<HTMLDetailsElement>('[data-testid="search-technical-exa"]')?.open).toBe(false)
  expect(host.querySelector('[data-testid="search-technical-exa"]')?.hasAttribute('data-compact')).toBe(true)
  expect(settingsCatalog.en.searchApiKeyHint).not.toContain('secret://')
  expect(host.querySelector('[data-testid="search-secret-exa"]')?.textContent).toContain(
    'secret://search/exa',
  )
  const input = host.querySelector<HTMLInputElement>('[data-testid="search-api-key"]')
  if (!input) throw new Error('missing key field')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  const count = host.querySelector<HTMLInputElement>('[data-testid="search-max-results"]')
  expect(count?.type).toBe('text')
  expect(count?.inputMode).toBe('numeric')
  await act(async () => {
    setter?.call(count, '2.5')
    count?.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="search-save"]')?.click())
  expect(saved).toBe(false)
  expect(host.querySelector('#search-max-results-error')?.textContent).toContain('whole number from 1 to 10')
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
    host.querySelector<HTMLInputElement>('[data-testid="search-enabled"]')?.click()
    host.querySelector<HTMLInputElement>('[data-testid="search-make-default"]')?.click()
  })
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="search-save"]')?.click()
  })
  expect(host.querySelector('[data-testid="search-enabled"]')?.getAttribute('role')).toBe('switch')
  expect(host.querySelector('[data-testid="search-enabled"]')?.getAttribute('aria-checked')).toBe('true')
  expect(count?.getAttribute('aria-invalid')).toBeNull()
  expect(saved).toBe(true)
  expect(host.textContent).not.toContain(key)
  expect(host.querySelector('[data-testid="search-api-key"]')?.getAttribute('value') ?? '').not.toContain(key)
  expect(settingsCatalog['zh-CN'].searchEmpty).toContain('尚未配置')
})
