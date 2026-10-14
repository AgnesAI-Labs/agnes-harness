import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import type { ConfigSnapshot, RuntimeAdminSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { settingsSections } from '@agnes/web-client'
import '../src/settings/registry.js'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { zhT } from '@agnes/web-foundation/testkit/locale'
import { setAdvancedSettingsShown, unmountRegion } from '@agnes/web-ui'
import { SettingsBuiltin, SettingsPaneBuiltin } from '@agnes/web-units'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginAdminApi } from '../src/admin/plugins/api.js'
import { type SettingsAdmin, SettingsPages } from '../src/settings/pages.js'
import { createSettingsController } from '../src/settings.js'

const diagnosticsFetch = vi.hoisted(() => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  return fetcher
})

// i18n: these suites assert zh-CN catalog output; pin the translator before imports run.
setLocaleTranslator(zhT)

const stylePath = resolve(import.meta.dirname, '../../web/public/style.css')

function styleRule(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^\\s*${escapedSelector} \\{([^}]*)\\}`, 'm').exec(css)
  expect(match, `missing rule ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

afterEach(() => {
  document.body.replaceChildren()
  setAdvancedSettingsShown(false)
})

/** The admin connection a settings page reads; only the calls a test names are answered. */
const adminOf =
  (api: Partial<PluginAdminApi>, permissions: readonly string[] = []) =>
  async (): Promise<SettingsAdmin> => ({
    api: { generations: async () => undefined, ...api } as unknown as PluginAdminApi,
    context: { permissions, readOnly: false } as unknown as SettingsAdmin['context'],
  })

it('keeps the account dialog close control anchored and the action footer visible in short viewports', () => {
  const css = readWebStyleSource(stylePath)
  const close = styleRule(css, '#account-dialog .account-dialog-close')
  const body = styleRule(css, '.account-dialog-body')
  const content = styleRule(css, '#account-dialog .config-detail-grid')
  const footer = styleRule(css, '#account-dialog .config-detail-footer')

  // Ant Design loads after style.css and gives `.ant-btn` position: relative. The account-scoped
  // selector must therefore win on specificity or the close control falls back into the left edge.
  expect(close).toContain('position: absolute')
  expect(close).toContain('right: 0.75rem')
  // The settings column ends before the close control; only a narrow dialog reserves room for it.
  expect(styleRule(css, '.agnes-settings-group-title')).toContain('max-width: var(--settings-frame)')

  // Only the middle section may scroll. Keeping the footer outside that scrollport prevents a
  // short browser window from clipping the save action below the dialog edge.
  expect(body).toContain('display: flex')
  expect(body).toContain('flex-direction: column')
  expect(body).toContain('overflow: hidden')
  expect(content).toContain('overflow-y: auto')
  expect(footer).toContain('flex: 0 0 auto')
  expect(footer).not.toContain('position: sticky')

  const narrowViewport = css.slice(css.indexOf('@media (max-width: 480px)'))
  expect(styleRule(narrowViewport, '#account-dialog .config-detail-footer')).toContain(
    'flex-direction: column',
  )
})

it('operates the React settings pane and account dialog without losing native form semantics', async () => {
  const dialog = document.createElement('dialog')
  dialog.id = 'config'
  document.body.append(dialog)
  const shellRoot = createRoot(dialog)
  const moved: unknown[] = []
  flushSync(() =>
    shellRoot.render(
      createElement(SettingsBuiltin, {
        options: {
          sections: settingsSections,
          onMoved: (target) => moved.push(target),
        },
      }),
    ),
  )
  await act(async () => {
    dialog
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'terminal', bubbles: true }))
  })
  expect(document.querySelector('.agh-toast')?.textContent).toContain('Open a session to use the terminal.')
  const openTerminal = (event: Event) => event.preventDefault()
  dialog.addEventListener('agnes:settings-terminal', openTerminal)
  await act(async () => {
    dialog
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'terminal', bubbles: true }))
  })
  expect(document.querySelector('.agh-toast')?.textContent).toContain(
    'The terminal is now in the session workbench.',
  )
  dialog.removeEventListener('agnes:settings-terminal', openTerminal)
  expect(dialog.querySelectorAll('[data-testid="settings-navigation"]')).toHaveLength(1)
  // The dialog lists three pages; everything else moved out and is no longer listed.
  const everyday = dialog.querySelectorAll('#settings-everyday button[data-settings-group]')
  expect([...everyday].map((item) => item.getAttribute('data-settings-section'))).toEqual([
    'general',
    'model',
    'security',
  ])
  expect(dialog.querySelector('#settings-advanced')).toBeNull()
  expect(dialog.querySelector('#settings-search')).toBeNull()
  for (const id of ['plugins', 'skills', 'mcp', 'schedules', 'history', 'archived', 'jobs'])
    expect(dialog.querySelector(`[data-testid="settings-nav-${id}"]`)).toBeNull()
  // A request for a page that left settings goes to the host; the dialog stays where it was.
  for (const id of ['mcp', 'search', 'skills', 'feedback', 'computer-use', 'plugins', 'schedules']) {
    flushSync(() =>
      dialog
        .querySelector('#config-form')
        ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true })),
    )
    expect(dialog.querySelector('#config-form')?.getAttribute('data-settings-section')).toBe('model')
    expect(dialog.querySelector('#settings-section-tabs [role="tab"]')).toBeNull()
  }
  expect(moved).toEqual([
    { kind: 'page', page: 'plugins', tab: 'mcp' },
    { kind: 'page', page: 'plugins', tab: 'plugins.search' },
    { kind: 'page', page: 'plugins', tab: 'skills' },
    { kind: 'page', page: 'plugins', tab: 'review' },
    { kind: 'page', page: 'plugins', tab: 'plugins.computer-use' },
    { kind: 'page', page: 'plugins' },
    { kind: 'page', page: 'automation', tab: 'schedules' },
  ])
  const onPage = vi.fn()
  dialog.addEventListener('agnes:settings-page', onPage)
  await act(async () => setAdvancedSettingsShown(true))
  expect(
    [...dialog.querySelectorAll('#settings-advanced button[data-settings-section]')].map((item) =>
      item.getAttribute('data-settings-section'),
    ),
  ).toEqual(['models', 'diagnostics'])
  flushSync(() => dialog.querySelector<HTMLButtonElement>('[data-testid="settings-nav-models"]')?.click())
  expect(onPage.mock.calls[0]?.[0].detail).toBe('models')
  const paneSlot = dialog.querySelector<HTMLElement>('#settings-pane-slot-model')
  if (!paneSlot) throw new Error('model pane slot missing')
  const paneRoot = createRoot(paneSlot)
  flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane: 'model' })))

  const snapshot: ConfigSnapshot = {
    profile: 'local-dev',
    revision: 1,
    configured: true,
    provider: null,
    accounts: [
      {
        accountId: 'work',
        label: 'Work',
        providerId: 'openai',
        route: 'account-work',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt',
        models: [{ id: 'gpt', name: 'GPT' }],
        enabled: true,
        credentialConfigured: true,
        authType: 'api-key',
        networkTimeouts: { requestMs: 90000, connectMs: 4000, streamIdleMs: 15000 },
      },
    ],
    defaultAccountId: 'work',
    effect: 'new-sessions',
  }
  const save = vi.fn(async () => snapshot)
  const controller = createSettingsController({
    client: {
      config: {
        get: async () => snapshot,
        save,
        test: async () => ({ verified: true, models: snapshot.accounts?.[0]?.models ?? [] }),
        providers: async () => ({
          providers: [
            {
              id: 'openai',
              label: 'OpenAI',
              api: 'openai-completions',
              baseUrl: 'https://api.openai.com/v1',
            },
          ],
        }),
      },
    } as unknown as Client,
    onSaved: vi.fn(async () => undefined),
    onError: vi.fn(),
  })
  try {
    await controller.open()
    expect(dialog.querySelectorAll('.config-account')).toHaveLength(1)
    expect(dialog.querySelector('#config-accounts .config-account-select')).toBeTruthy()
    dialog.querySelector<HTMLButtonElement>('#config-accounts .config-account-select')?.click()
    // Timeouts are chosen in seconds; a stored value no preset names stays as 自定义.
    const field = dialog.querySelector<HTMLSelectElement>('[data-testid="account-network-connectMs"]')
    expect(field?.value).toBe('custom')
    expect(
      dialog.querySelector<HTMLInputElement>('[data-testid="account-network-connectMs-custom"]')?.value,
    ).toBe('4')
    expect(dialog.querySelector('[data-testid="account-network-timeouts"]')?.textContent).toContain(
      zhT('accounts.network.legend'),
    )
    flushSync(() => {
      if (field) field.value = '5000'
      field?.dispatchEvent(new Event('change', { bubbles: true }))
    })
    dialog.querySelector<HTMLButtonElement>('#config-test')?.click()
    await vi.waitFor(() =>
      expect(dialog.querySelector<HTMLButtonElement>('#config-save')?.disabled).toBe(false),
    )
    dialog.querySelector<HTMLButtonElement>('#config-save')?.click()
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          networkTimeouts: { requestMs: 90000, connectMs: 5000, streamIdleMs: 15000 },
        }),
      ),
    )
    dialog.querySelector<HTMLButtonElement>('#config-add-account')?.click()
    expect(dialog.querySelector<HTMLDialogElement>('#account-dialog')?.open).toBe(true)
    expect(dialog.querySelector<HTMLSelectElement>('#config-provider')?.value).toBe('openai')
    expect(dialog.querySelector('#config-api-key')?.closest('label')).toBeTruthy()
    expect(dialog.querySelector<HTMLButtonElement>('#config-save')?.disabled).toBe(true)
    dialog.querySelector<HTMLButtonElement>('#account-dialog-close')?.click()
    expect(dialog.querySelector<HTMLDialogElement>('#account-dialog')?.open).toBe(false)
  } finally {
    controller.close()
    for (const host of dialog.querySelectorAll<HTMLElement>(
      '#config-accounts, #config-account-network, .agnes-ui-button-host, .agnes-ui-field-host',
    ))
      unmountRegion(host)
    paneRoot.unmount()
    shellRoot.unmount()
  }
})

it('translates static settings pane text when the pane is first mounted', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'appearance', translate: zhT })))
    expect(host.querySelector('#appearance-settings-pane h2')?.textContent).toBe('通用')
    expect(host.querySelector('#appearance-settings-pane')?.textContent).toContain('显示高级设置')
  } finally {
    root.unmount()
    host.remove()
  }
})

it('reports a failed admin connection and lets the settings page retry it', async () => {
  const host = document.createElement('div')
  host.id = 'config-form'
  host.dataset.runtimePage = 'security'
  document.body.append(host)
  const root = createRoot(host)
  const snapshot: RuntimeAdminSnapshot = {
    providers: [],
    presets: [],
    localPluginFolders: { home: '/fixture/plugins', workspace: '/fixture/workspace' },
  }
  const load = vi.fn(adminOf({ runtime: async () => snapshot }))
  load.mockRejectedValueOnce(new Error('Synthetic admin offline'))
  try {
    await act(async () => root.render(createElement(SettingsPages, { admin: load })))
    expect(host.querySelector('[data-testid="settings-catalog-state"]')?.textContent).toContain('unavailable')
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="settings-refresh"]')!
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(host.querySelector('[data-testid="settings-catalog-state"]')).toBeNull()
    expect(host.querySelector('[data-testid="security-default-permissions"]')).not.toBeNull()
  } finally {
    flushSync(() => root.unmount())
  }
})

for (const outcome of ['success', 'failure'] as const) {
  it(`announces a pending settings refresh and clears it on ${outcome}`, async () => {
    const host = document.createElement('div')
    document.body.append(host)
    host.id = 'config-form'
    host.dataset.runtimePage = 'security'
    const root = createRoot(host)
    let resolveRuntime: (snapshot: RuntimeAdminSnapshot) => void = () => undefined
    let rejectRuntime: (error: Error) => void = () => undefined
    const pending = new Promise<RuntimeAdminSnapshot>((resolve, reject) => {
      resolveRuntime = resolve
      rejectRuntime = reject
    })
    try {
      flushSync(() =>
        root.render(createElement(SettingsPages, { admin: adminOf({ runtime: () => pending }) })),
      )
      const refresh = host.querySelector<HTMLButtonElement>('[data-testid="settings-refresh"]')
      await vi.waitFor(() => expect(refresh?.getAttribute('aria-busy')).toBe('true'))
      expect(refresh?.disabled).toBe(true)
      if (outcome === 'success') {
        resolveRuntime({
          providers: [],
          presets: [],
          localPluginFolders: { home: '/fixture/plugins', workspace: '/fixture/workspace' },
        })
      } else {
        rejectRuntime(new Error('Synthetic runtime unavailable'))
      }
      await vi.waitFor(() => {
        expect(refresh?.disabled).toBe(false)
        expect(refresh?.getAttribute('aria-busy')).toBe('false')
      })
    } finally {
      root.unmount()
      host.remove()
    }
  })
}

it.each(['success', 'failure'] as const)(
  'keeps independent settings usable after leaving a pending catalog request (%s)',
  async (outcome) => {
    const host = document.createElement('div')
    host.id = 'config-form'
    host.dataset.runtimePage = 'security'
    document.body.append(host)
    const root = createRoot(host)
    let finish!: (snapshot: RuntimeAdminSnapshot) => void
    let fail!: (error: Error) => void
    const pending = new Promise<RuntimeAdminSnapshot>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const cleanup: Array<() => void> = []
    try {
      const remove = settingsSections.register({
        id: 'independent',
        group: 'vendor',
        order: 200,
        icon: 'plug',
        titleKey: 'independent',
        groupTitleKey: 'vendor',
        runtimeCatalog: false,
        component: () => createElement('p', { 'data-testid': 'independent-content' }, 'Plugin section'),
      })
      cleanup.push(remove)
      flushSync(() =>
        root.render(createElement(SettingsPages, { admin: adminOf({ runtime: () => pending }) })),
      )
      await vi.waitFor(() =>
        expect(host.querySelector('[data-testid="settings-refresh"]')?.getAttribute('aria-busy')).toBe(
          'true',
        ),
      )
      flushSync(() =>
        document.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: 'independent' })),
      )
      expect(host.querySelector('[data-testid="settings-page-independent"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="settings-refresh"]')).toBeNull()
      expect(host.querySelector('[data-testid="settings-catalog-state"]')).toBeNull()
      // A page that moved out of the dialog is not this host's to show.
      flushSync(() => document.dispatchEvent(new CustomEvent('agnes:settings-page', { detail: 'discover' })))
      expect(host.querySelector('[data-testid="settings-page-independent"]')).not.toBeNull()
      await act(async () => {
        if (outcome === 'success')
          finish({
            providers: [],
            presets: [],
            localPluginFolders: { home: '/fixture/plugins', workspace: '/fixture/workspace' },
          })
        else fail(new Error('Synthetic runtime unavailable'))
        await pending.catch(() => undefined)
      })
      expect(host.querySelector('[data-testid="independent-content"]')?.textContent).toBe('Plugin section')
      expect(host.querySelector('[data-testid="settings-catalog-state"]')).toBeNull()
      expect(host.querySelector('[data-testid="settings-refresh"]')).toBeNull()
    } finally {
      flushSync(() => root.unmount())
      for (const dispose of cleanup) dispose()
      host.remove()
    }
  },
)

it('loads registered diagnostics independently of the plugin catalog with one translated heading', async () => {
  const host = document.createElement('div')
  const form = document.createElement('div')
  form.id = 'config-form'
  form.dataset.runtimePage = 'diagnostics'
  document.body.append(form, host)
  const pin = {
    pinId: 'pin-1',
    purpose: 'recovery' as const,
    packageId: '@acme/tool',
    version: '1.0.0',
    snapshotId: 'snapshot-1',
    operationId: 'operation-1',
  }
  const pinsRelease = vi.fn(async (ids: string[]) => ({
    results: ids.map((pinId) => ({ pinId, outcome: 'released' as const })),
  }))
  const root = createRoot(host)
  const runtime = vi.fn(async () => {
    throw new Error('unavailable catalog')
  })
  diagnosticsFetch.mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith('/doctor')
        ? { checks: [], status: 'ok' }
        : {
            doctorAvailable: true,
            bundle: {
              schemaVersion: 1,
              collectedAt: '2026-10-08T00:00:00Z',
              agh: { version: 'test' },
              runtime: {
                platform: 'test',
                arch: 'test',
                osRelease: 'test',
                node: '24',
                pid: 1,
                uptimeMs: 0,
              },
              profile: { hash: 'a'.repeat(64) },
              generations: { available: false, current: null, items: [] },
              doctor: [],
              errors: [],
              audit: [],
              limits: { audit: 100, errors: 4096 },
            },
          },
    ),
  )
  try {
    const admin = adminOf({ runtime, pinsInspect: async () => ({ orphans: [pin] }), pinsRelease }, [
      'packages.remove',
    ])
    flushSync(() => root.render(createElement(SettingsPages, { admin })))
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="diagnostics-doctor"]')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    )
    expect(runtime).not.toHaveBeenCalled()
    // Leftover plugin files are read and released here, without the plugins page being open.
    // Leftover files are the first record of the 运行详情 subpage, opened in place.
    expect(host.querySelector('[data-testid="runtime-occupancy"]')).toBeNull()
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="plugin-diagnostics"]')?.click(),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="runtime-pins-toggle"]')?.click(),
    )
    const occupancy = host.querySelector<HTMLElement>('[data-testid="runtime-occupancy"]')
    await vi.waitFor(() => expect(occupancy?.querySelector('[data-testid="pin-row"]')).not.toBeNull())
    expect(occupancy?.textContent).toContain('@acme/tool 1.0.0')
    await act(async () => occupancy?.querySelector<HTMLButtonElement>('[data-testid="pin-release"]')?.click())
    expect(pinsRelease).not.toHaveBeenCalled()
    await act(async () =>
      occupancy?.querySelector<HTMLButtonElement>('[data-testid="pins-confirm-release"]')?.click(),
    )
    expect(pinsRelease).toHaveBeenCalledWith(['pin-1'])
    await vi.waitFor(() => expect(occupancy?.querySelector('[data-testid="pin-row"]')).toBeNull())
    // The page names itself once; the open subpage has its own title and the refresh.
    expect([...host.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Runtime & diagnostics',
      'Runtime details',
    ])
    expect(
      host.querySelector('[data-testid="settings-subpage-header"] [data-testid="settings-refresh"]'),
    ).not.toBeNull()
    expect(settingsSections.get('doctor')).toBeUndefined()
    expect(host.querySelector('[data-testid="diagnostics-doctor"]')).not.toBeNull()
  } finally {
    flushSync(() => root.unmount())
    vi.unstubAllGlobals()
  }
})

it('re-reads the runtime details after a local plugin rescan, not only the page around them', async () => {
  const host = document.createElement('div')
  host.id = 'config-form'
  host.dataset.runtimePage = 'diagnostics'
  document.body.append(host)
  const root = createRoot(host)
  const snapshot: RuntimeAdminSnapshot = {
    providers: [],
    presets: [],
    localPluginFolders: { home: '/fixture/plugins', workspace: '/fixture/workspace' },
  }
  const runtime = vi.fn(async () => snapshot)
  const reloadLocal = vi.fn(async () => undefined)
  diagnosticsFetch.mockImplementation(async () =>
    Response.json({ error: { message: 'off' } }, { status: 503 }),
  )
  try {
    await act(async () =>
      root.render(
        createElement(SettingsPages, { admin: adminOf({ runtime, reloadLocal }, ['packages.activate']) }),
      ),
    )
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="plugin-diagnostics"]')?.click(),
    )
    await vi.waitFor(() => expect(host.querySelector('[data-testid="runtime-local-toggle"]')).not.toBeNull())
    const reads = runtime.mock.calls.length
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="runtime-local-toggle"]')?.click(),
    )
    const rescan = host.querySelector<HTMLButtonElement>('[data-testid="reload-local-plugins"]')
    expect(rescan).not.toBeNull()
    await act(async () => rescan?.click())
    expect(reloadLocal).toHaveBeenCalledOnce()
    // The subpage's own snapshot is read again after the mutation.
    await vi.waitFor(() => expect(runtime.mock.calls.length).toBeGreaterThan(reads))
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
})
