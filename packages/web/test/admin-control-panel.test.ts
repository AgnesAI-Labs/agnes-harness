/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor } from '@agnes/protocol'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginAdminApi } from '../src/admin/plugins/api.js'
import {
  GenerationDrainSummary,
  KindFilter,
  PluginBadges,
  pluginStates,
  SessionDefaultsPanel,
} from '../src/admin/plugins/control-panel.js'
import { pluginAdminLocaleCatalog } from '../src/admin/plugins/locales/admin.js'
import { sessionLoopSelection } from '../src/admin/plugins/session-loop.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string) => pluginAdminLocaleCatalog.en[key] ?? key
const roots: Root[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.replaceChildren()
})
async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(node))
  return host
}
const item = {
  id: '@acme/plugin',
  version: '1.0.0',
  kinds: ['loop', 'ui'],
  desired: 'enabled',
  actual: 'running',
} as PackageInstalledDescriptor

it('shows declared kinds and observable states without guessing draining or restart requirements', async () => {
  const host = await mount(createElement(PluginBadges, { item, t }))
  expect(host.textContent).toContain('Agent Loop')
  expect(host.textContent).toContain('UI')
  expect(pluginStates(item).map((state) => state.key)).toEqual(['installed', 'enabled', 'active'])
  expect(host.textContent).not.toContain('Draining')
  expect(
    pluginStates({ ...item, actual: 'restart-required', draining: true }).map((state) => state.key),
  ).toEqual(['installed', 'enabled', 'draining', 'restart-required'])
  expect(
    pluginStates(item, {
      packageId: item.id,
      revision: undefined,
      phase: 'failed',
      error: { code: 'CLIENT_MODULE_IMPORT_FAILED', message: 'load failure' },
    }).map((state) => state.key),
  ).toContain('failed')
  const draining = await mount(
    createElement(PluginBadges, { item: { ...item, draining: true, drainingSessions: 3 }, t }),
  )
  expect(draining.textContent).toContain('Draining (3)')
  const removed = await mount(
    createElement(GenerationDrainSummary, {
      installed: [],
      status: {
        generations: [],
        plugins: [{ id: item.id, state: 'draining', boundSessions: 3, drainingSessions: 3 }],
      },
      t,
    }),
  )
  expect(removed.textContent).toContain(item.id)
  expect(removed.textContent).toContain('Draining (3)')
  const filter = await mount(createElement(KindFilter, { value: '', onChange: vi.fn(), t }))
  expect(filter.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe('Filter by kind')
  expect(sessionLoopSelection({})).toBeUndefined()
  expect(sessionLoopSelection({ loop: { id: 'old-session-loop', version: '1.0.0' } })).toEqual({
    id: 'old-session-loop',
    version: '1.0.0',
  })
})

it('loads catalog choices and saves their exact identities and revision', async () => {
  const loop = { id: 'workflow', version: '1.0.0', sourcePackage: '@acme/workflow', capabilities: ['resume'] }
  const adapter = {
    ...loop,
    id: 'adapter',
    api: 'custom',
    capabilities: { imageInput: true, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const snapshot = {
    revision: 4,
    defaults: {
      loop: { id: loop.id, version: loop.version },
      modelAdapter: { id: adapter.id, version: adapter.version, model: 'model' },
    },
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/loops')) return Response.json({ loops: [loop], ...snapshot })
    if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [adapter] })
    expect(init?.method).toBe('PUT')
    return Response.json({ ...snapshot, revision: 5 })
  })
  const api = new PluginAdminApi(
    {
      profile: 'local-dev',
      clientId: 'admin',
      permissions: ['packages.read', 'packages.activate'],
      readOnly: false,
    },
    fetcher,
  )
  const host = await mount(createElement(SessionDefaultsPanel, { api, canSave: true, t }))
  expect(host.textContent).toContain('Defaults for new sessions')
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(3)
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  )
  expect(
    JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).endsWith('/defaults'))?.[1]?.body)),
  ).toEqual(snapshot)
  expect(host.textContent).toContain('Defaults saved.')
})

it('keeps unavailable catalog errors visible and read-only saves disabled', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      Response.json(
        { error: { code: 'E_ADMIN_CATALOG_UNAVAILABLE', message: 'Unavailable' } },
        { status: 503 },
      ),
    )
  const api = new PluginAdminApi(
    { profile: 'local-dev', clientId: 'admin', permissions: ['packages.read'], readOnly: true },
    fetcher,
  )
  const host = await mount(createElement(SessionDefaultsPanel, { api, canSave: false, t }))
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('defaults.unavailable'))
  expect(host.querySelector('form')).toBeNull()
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/loops')
      ? Response.json({ loops: [], revision: 0, defaults: {} })
      : Response.json({ modelAdapters: [] }),
  )
  await act(async () => {
    host.querySelector('button')?.click()
  })
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
})
