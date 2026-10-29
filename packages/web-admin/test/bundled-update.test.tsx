/** @vitest-environment happy-dom */
import type { PackageCatalogDescriptor, PackageInstalledDescriptor } from '@agnes/protocol'
import { UiLocaleProvider } from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginDetailBody } from '../src/admin/plugins/admin/detail-body.js'
import { forgetInventory } from '../src/admin/plugins/admin/inventory-cache.js'
import { bundledUpdate } from '../src/admin/plugins/admin/model.js'
import { PluginAdminPage } from '../src/admin/plugins/admin/page.js'
import { PluginAdminApi } from '../src/admin/plugins/api.js'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterEach(() => {
  vi.restoreAllMocks()
  forgetInventory()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
})

it.each(
  ['en', 'zh-CN'].flatMap((locale) =>
    ['plugin-helper', 'data-report', 'support-triage'].map((name) => ({ locale, name })),
  ),
)('offers the $name update from 1.0.0 to 1.1.0 in $locale', async ({ locale, name }) => {
  document.documentElement.lang = locale
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const installed: PackageInstalledDescriptor = {
    id: name === 'plugin-helper' ? '@agnes/plugin-helper' : `@agnes-fde/${name}`,
    version: '1.0.0',
    integrity: `sha256-${'a'.repeat(64)}`,
    source: {
      type: 'file',
      ref:
        name === 'plugin-helper'
          ? 'file:./bundled-plugins/plugin-helper'
          : `file:./bundled-examples/fde/${name}`,
    },
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    primaryStatus: {
      state: 'ready',
      reasonCode: 'ready',
      nextAction: 'none',
      reason: { en: 'Available for new sessions.', 'zh-CN': '新会话可用。' },
    },
    blockers: [],
    contributions: [],
    presentation: { origin: name === 'plugin-helper' ? 'official' : 'example', rows: [] },
  }
  const candidate: PackageCatalogDescriptor = {
    id: installed.id,
    version: '1.1.0',
    integrity: `sha256-${'b'.repeat(64)}`,
    source: installed.source,
    sourceId: name === 'plugin-helper' ? 'builtin-plugins' : 'official-examples',
    license: 'Apache-2.0',
    contributions: [],
    compatibility: 'supported',
    retrievedAt: '2026-10-16T00:00:00.000Z',
  }
  vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({
    context: {
      profile: 'local-dev',
      clientId: 'fixture',
      authScope: 'fixture',
      readOnly: false,
      permissions: ['packages.read', 'packages.install', 'packages.trust', 'packages.activate'],
    },
    inventory: { packages: [installed] },
  })
  vi.spyOn(PluginAdminApi.prototype, 'list').mockResolvedValue({ packages: [installed] })
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [candidate], nextCursor: null })
  vi.spyOn(PluginAdminApi.prototype, 'pinsInspect').mockResolvedValue({ orphans: [] })
  for (const method of ['surfaceLinks', 'treeList', 'runtime', 'composition'] as const)
    vi.spyOn(PluginAdminApi.prototype, method).mockRejectedValue(new Error('Optional feed unavailable'))
  const host = document.body.appendChild(document.createElement('div'))
  const page = new PluginAdminPage({ surface: { host, render: () => null } })
  vi.spyOn(page, 'render').mockImplementation(() => {})
  const inspect = vi.spyOn(page, 'inspect').mockResolvedValue({ ok: true, operationId: 'fixture-inspect' })
  const root = createRoot(host)
  try {
    await page.refresh()
    expect(page.availableBundledUpdate(installed)).toEqual(candidate)
    expect(bundledUpdate({ ...installed, integrity: candidate.integrity }, [candidate])).toBeUndefined()
    // An optional bundled package still receives its release update.
    expect(
      bundledUpdate(
        {
          ...installed,
          presentation: {
            origin: name === 'plugin-helper' ? 'official' : 'example',
            optional: true,
            rows: [],
          },
        },
        [candidate],
      ),
    ).toEqual(candidate)
    expect(
      bundledUpdate({ ...installed, source: { type: 'file', ref: 'file:./custom-plugin-helper' } }, [
        candidate,
      ]),
    ).toBeUndefined()
    const view = page.viewContext()
    await act(async () =>
      root.render(
        createElement(
          UiLocaleProvider,
          { source: view.locale },
          createElement(PluginDetailBody, {
            view,
            item: installed,
            actions: page.detailActions(installed),
          }),
        ),
      ),
    )
    expect(host.textContent).toContain(locale === 'en' ? 'Update available' : '有可用更新')
    expect(host.textContent).toContain('1.0.0 → 1.1.0')
    expect(host.querySelector('[data-testid=plugin-primary-status]')?.textContent).toContain(
      locale === 'en' ? 'Available for new sessions.' : '新会话可用。',
    )
    expect(host.textContent).toContain(locale === 'en' ? 'Status dimensions' : '状态维度')
    expect(host.querySelectorAll('[data-testid=plugin-primary-status] .agh-tag')).toHaveLength(1)
    await act(async () => host.querySelector<HTMLElement>('[data-testid="plugin-versions-tab"]')?.click())
    const action = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(locale === 'en' ? 'Review update' : '审核更新'),
    )
    expect(action).toBeDefined()
    expect(action?.disabled).toBe(false)
    await act(async () => action?.click())
    expect(inspect).toHaveBeenCalledWith(
      candidate.source,
      'update',
      expect.anything(),
      installed.id,
      installed.id,
    )
    expect(view.state.installed[0]).toEqual(installed)
  } finally {
    await act(async () => root.unmount())
    page.dispose()
  }
})
