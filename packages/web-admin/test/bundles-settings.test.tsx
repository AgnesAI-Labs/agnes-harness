/** @vitest-environment happy-dom */
import { installFeedbackSink, type OperationFeedback, SettingsSubpageFrame } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  afterEach,
  expect,
  afterEach as feedbackAfterEach,
  beforeEach as feedbackBeforeEach,
  it,
  vi,
} from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { BundlesPanel, reorder } from '../src/admin/plugins/bundles-panel.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
})
const t = (key: string, vars?: Record<string, string | number>) =>
  (pluginAdminLocaleCatalog.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? name))

function api(bundles: string[], catalog: Record<string, unknown>[]) {
  const saves: unknown[] = []
  const value = {
    bundles: vi.fn(async () => ({ revision: 3, bundles, effect: 'restart-required', catalog })),
    composition: vi.fn(async () => ({})),
    list: vi.fn(async () => ({
      packages: [
        {
          id: '@agnes-fde/support-triage',
          version: '1.1.0',
          metadata: { displayName: 'Support triage', locales: { 'zh-CN': { displayName: '客服分流示例' } } },
        },
      ],
    })),
    saveBundles: vi.fn(async (input: unknown) => {
      saves.push(input)
    }),
  }
  return { api: value as unknown as PluginAdminApi, saves }
}
async function mount(client: PluginAdminApi) {
  const host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () =>
    root?.render(
      createElement(
        SettingsSubpageFrame,
        { header: null },
        createElement(BundlesPanel, { api: client, canSave: true, t }),
      ),
    ),
  )
  await act(async () => {})
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="settings-drill-bundles"]')?.click(),
  )
  return host
}

it('names business agents from the catalog or their package, falls back to a small ID, and reorders by handle', async () => {
  const { api: client, saves } = api(
    ['@agnes-fde/gone#gone'],
    [
      {
        id: '@agnes-fde/finance-reconcile#finance-reconcile',
        sourcePackage: '@agnes-fde/finance-reconcile',
        displayName: 'Reconciliation',
        version: '1.0.0',
      },
      { id: '@agnes-fde/support-triage#support-triage', sourcePackage: '@agnes-fde/support-triage' },
      { id: '@acme/raw#raw', sourcePackage: '@acme/raw' },
    ],
  )
  const host = await mount(client)
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-bundle="${id}"]`)!
  // The catalog's name, then the installed package's name and version; never the raw ID as a title.
  expect(
    row('@agnes-fde/finance-reconcile#finance-reconcile').querySelector('[data-testid="bundle-name"]')
      ?.textContent,
  ).toBe('Reconciliation')
  expect(row('@agnes-fde/finance-reconcile#finance-reconcile').textContent).toContain('1.0.0')
  expect(
    row('@agnes-fde/support-triage#support-triage').querySelector('[data-testid="bundle-name"]')?.textContent,
  ).toBe('Support triage')
  expect(row('@agnes-fde/support-triage#support-triage').textContent).toContain('1.1.0')
  const raw = row('@acme/raw#raw').querySelector('[data-testid="bundle-name"]')
  expect(raw?.tagName).toBe('CODE')
  expect(raw?.className).toContain('agnes-settings-id')
  // An agent whose plugin is gone is marked and can be turned off to remove it.
  expect(row('@agnes-fde/gone#gone').textContent).toContain('Unavailable')
  // Full combination identifiers stay copyable behind an explicitly named, closed disclosure.
  const details = row('@agnes-fde/finance-reconcile#finance-reconcile').querySelector<HTMLElement>(
    '.agnes-settings-technical',
  )
  const toggleDetails = details?.querySelector<HTMLButtonElement>(':scope > button')
  if (!details || !toggleDetails) throw new Error('combination technical details missing')
  expect(toggleDetails.textContent).toContain('Technical details')
  expect(toggleDetails.getAttribute('aria-expanded')).toBe('false')
  await act(async () => toggleDetails.click())
  expect(toggleDetails.getAttribute('aria-expanded')).toBe('true')
  expect(details.textContent).toContain('@agnes-fde/finance-reconcile#finance-reconcile')
  expect(
    details.querySelector('[data-copy]') ?? details.querySelector('button[aria-label="Copy technical ID"]'),
  ).not.toBeNull()
  // Every row has a handle; it moves only agents that are on, and only when there are two or more.
  expect(host.querySelectorAll('[data-testid="bundle-drag"]')).toHaveLength(4)
  const toggle = (id: string) =>
    act(async () => row(id).querySelector<HTMLElement>('.switch, [role="switch"]')?.click())
  await toggle('@agnes-fde/gone#gone')
  await toggle('@agnes-fde/finance-reconcile#finance-reconcile')
  await toggle('@agnes-fde/support-triage#support-triage')
  const handle = row('@agnes-fde/support-triage#support-triage').querySelector<HTMLButtonElement>(
    '[data-testid="bundle-drag"]',
  )
  expect(handle?.disabled).toBe(false)
  await act(async () =>
    handle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })),
  )
  const apply = host.querySelector<HTMLButtonElement>('[data-testid="bundles-save"]')
  expect(apply?.textContent).toBe('Save (restart required)')
  await act(async () => apply?.click())
  expect(saves).toEqual([
    {
      revision: 3,
      bundles: ['@agnes-fde/support-triage#support-triage', '@agnes-fde/finance-reconcile#finance-reconcile'],
    },
  ])
  // The page cannot restart the service itself, and says so.
  expect(feedbackResults.at(-1)).toMatchObject({
    scope: 'bundles',
    outcome: 'success',
    effect: { kind: 'restart-required' },
  })
  expect(feedbackResults.at(-1)?.effect?.message).toContain('daemon stop')
  expect(reorder(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
})

it('keeps a confirmed save distinct from a failed refresh', async () => {
  const { api: client } = api([], [{ id: '@acme/agent#agent' }])
  const host = await mount(client)
  await act(async () => host.querySelector<HTMLElement>('[role="switch"]')?.click())
  vi.mocked(client.bundles).mockRejectedValueOnce(new Error('refresh unavailable'))
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="bundles-save"]')?.click())
  expect(feedbackResults).toHaveLength(1)
  expect(feedbackResults[0]).toMatchObject({ outcome: 'success', effect: { kind: 'restart-required' } })
  expect(host.textContent).toContain('Combinations saved. The latest view could not be loaded.')
  expect(host.textContent).not.toContain('Combinations were not saved.')
})

it('sends an empty list to plugin management', async () => {
  const host = await mount(api([], []).api)
  const empty = host.querySelector('[data-testid="bundles-empty"]')
  expect(empty?.textContent).toContain('No agents yet')
  expect(empty?.querySelector('a')?.getAttribute('href')).toBe('/?page=plugins')
})

const feedbackResults: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
feedbackBeforeEach(() => {
  feedbackResults.length = 0
  releaseFeedback = installFeedbackSink({ publish: (value) => feedbackResults.push(value), resolve() {} })
})
feedbackAfterEach(() => releaseFeedback?.())
