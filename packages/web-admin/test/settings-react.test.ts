import { readWebStyleSource } from '../../../tools/web-style-source.mjs'
/** @vitest-environment happy-dom */

import { resolve } from 'node:path'
import type { ConfigSnapshot, RuntimeAdminSnapshot } from '@agnes/protocol'
import type { Client } from '@agnes/sdk/browser'
import { settingsSections } from '@agnes/web-client'
import '../src/settings/registry.js'
import { setLocaleTranslator } from '@agnes/web-foundation/locale-bridge'
import { zhT } from '@agnes/web-foundation/testkit/locale'
import { clearResources, setAdvancedSettingsShown, unmountRegion } from '@agnes/web-ui'
import { SettingsBuiltin, SettingsPaneBuiltin } from '@agnes/web-units'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

beforeEach(() => {
  // Independent panels also fetch here. Unhandled endpoints must still obey fetch's Promise contract.
  diagnosticsFetch.mockReset().mockImplementation(async () => Response.json({}, { status: 503 }))
})

afterEach(() => {
  clearResources()
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
  const close = styleRule(css, ':is(#account-dialog, .account-page-host) .account-dialog-close')
  const body = styleRule(css, '.account-dialog-body')
  const content = styleRule(css, ':is(#account-dialog, .account-page-host) .config-detail-grid')
  const footer = styleRule(css, ':is(#account-dialog, .account-page-host) .config-detail-footer')

  // Ant Design loads after style.css and gives `.ant-btn` position: relative. The account-scoped
  // selector must therefore win on specificity or the close control falls back into the left edge.
  expect(close).toContain('position: absolute')
  expect(close).toContain('right: 0.75rem')
  // The main settings close button must paint above the sticky pane header (z-index: 2).
  const settingsClose = styleRule(css, '#config:has(.settings-shell) #config-close')
  expect(settingsClose).toContain('z-index: 3')
  // The group title is the header line: it always leaves room for the dialog's close control.
  expect(styleRule(css, '.agnes-settings-group-title')).toContain(
    'padding: 0 var(--settings-header-end) 0 var(--settings-gutter)',
  )
  // Operation notices render above that line, so they reserve the same top and end room.
  expect(styleRule(css, '#config:has(.settings-shell) #settings-operation-notices:not(:empty)')).toContain(
    'padding: var(--settings-header-height) var(--settings-header-end) var(--s12) var(--settings-gutter)',
  )

  // Only the middle section may scroll. Keeping the footer outside that scrollport prevents a
  // short browser window from clipping the save action below the dialog edge.
  expect(body).toContain('display: flex')
  expect(body).toContain('flex-direction: column')
  expect(body).toContain('overflow: hidden')
  expect(content).toContain('overflow-y: auto')
  expect(footer).toContain('flex: 0 0 auto')
  expect(footer).not.toContain('position: sticky')

  const narrowViewport = css.slice(css.indexOf('@media (max-width: 480px)'))
  expect(
    styleRule(narrowViewport, ':is(#account-dialog, .account-page-host) .config-detail-footer'),
  ).toContain('flex-direction: column')
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
  // The dialog lists everyday pages, including application adoption; everything else moved out and is no longer listed.
  const everyday = dialog.querySelectorAll('#settings-everyday button[data-settings-group]')
  expect([...everyday].map((item) => item.getAttribute('data-settings-section'))).toEqual([
    'general',
    'model',
    'security',
    'application',
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
    expect(dialog.querySelectorAll('#settings-section-tabs [role="tab"]')).toHaveLength(2)
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
  ).toEqual(['diagnostics'])
  flushSync(() =>
    dialog
      .querySelector<HTMLButtonElement>('#settings-section-tabs [data-settings-section="models"]')
      ?.click(),
  )
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
    const baseUrl = dialog.querySelector<HTMLInputElement>('#config-base-url')
    if (!baseUrl) throw new Error('missing base URL field')
    baseUrl.value = 'https://replacement.example.invalid/v1'
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
    expect(dialog.querySelector('#config-key-hint')?.textContent).toBe(zhT('settings.key.endpointChanged'))
    dialog.querySelector<HTMLButtonElement>('#config-test')?.click()
    await vi.waitFor(() =>
      expect(dialog.querySelector('#config-api-key')?.getAttribute('aria-invalid')).toBe('true'),
    )
    baseUrl.value = snapshot.accounts?.[0]?.baseUrl ?? ''
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }))
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
    save.mockRejectedValueOnce({
      data: {
        reason: 'CONFIG_INVALID_INPUT',
        field: 'baseUrl',
        messageKey: 'appServer.errors.invalidParams',
      },
    })
    dialog.querySelector<HTMLButtonElement>('#config-save')?.click()
    await vi.waitFor(() => expect(baseUrl.getAttribute('aria-invalid')).toBe('true'))
    // An address the backend refuses is told under the address, in the advanced options it opens.
    expect(dialog.querySelector('#config-base-url-error')?.textContent).toBe(
      zhT('settings.config.invalidBaseUrl'),
    )
    expect(baseUrl.getAttribute('aria-describedby')).toContain('config-base-url-error')
    expect(dialog.querySelector('#config-account-advanced')?.getAttribute('data-open')).toBe('true')
    expect(dialog.querySelector('#config-error')?.textContent).toBe('')
    dialog.querySelector<HTMLButtonElement>('#config-save')?.click()
    await vi.waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          networkTimeouts: { requestMs: 90000, connectMs: 5000, streamIdleMs: 15000 },
        }),
      ),
    )
    // The saved account's page closes; 添加账户 then opens a page of the settings dialog that holds
    // the account form, not a second dialog.
    await vi.waitFor(() => expect(dialog.querySelector('[data-testid="account-page-edit"]')).toBeNull())
    await vi.waitFor(() => expect(dialog.querySelector('#config-add-account')).not.toBeNull())
    dialog.querySelector<HTMLButtonElement>('#config-add-account')?.click()
    await vi.waitFor(() =>
      expect(dialog.querySelector('[data-testid="account-page-add"] #config-provider')).not.toBeNull(),
    )
    expect(dialog.querySelector<HTMLDialogElement>('#account-dialog')?.open).toBe(false)
    expect(dialog.querySelector<HTMLSelectElement>('#config-provider')?.value).toBe('openai')
    expect(dialog.querySelector('label[for="config-api-key"]')).toBeTruthy()
    // The page shows the two steps in place, starting at choosing a provider.
    expect(dialog.querySelector('.account-dialog-body')?.getAttribute('data-account-step')).toBe('provider')
    // 返回 leaves the page and gives the form back.
    dialog.querySelector<HTMLButtonElement>('[data-testid="settings-subpage-back"]')?.click()
    await vi.waitFor(() => expect(dialog.querySelector('[data-testid="account-page-add"]')).toBeNull())
    expect(dialog.querySelector('#account-dialog #config-provider')).not.toBeNull()
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
    expect(host.querySelector('[data-testid="settings-catalog-state"]')?.textContent).toContain('Read failed')
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="settings-retry"]')!
    expect(retry.disabled).toBe(false)
    await act(async () => retry.click())
    expect(host.querySelector('[data-testid="settings-catalog-state"]')).toBeNull()
    expect(host.querySelector('[data-testid="security-default-permissions"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="settings-refresh"]')).toBeNull()
    load.mockClear()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(load).toHaveBeenCalledOnce()
    load.mockClear()
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(load).toHaveBeenCalledOnce()
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
      expect(host.querySelector('[data-testid="settings-refresh"]')).toBeNull()
      const panel = host.querySelector('[data-testid="settings-page-security"]')
      await vi.waitFor(() => expect(panel?.getAttribute('aria-busy')).toBe('true'))
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
        expect(panel?.getAttribute('aria-busy')).toBe('false')
        expect(!!host.querySelector('[data-testid="settings-retry"]')).toBe(outcome === 'failure')
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
        expect(host.querySelector('[data-testid="settings-page-security"]')?.getAttribute('aria-busy')).toBe(
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
  const pinsInspect = vi
    .fn()
    .mockRejectedValueOnce(new Error('forbidden'))
    .mockResolvedValue({ orphans: [pin] })
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
    const admin = adminOf({ runtime, pinsInspect, pinsRelease }, ['packages.remove'])
    flushSync(() => root.render(createElement(SettingsPages, { admin })))
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="diagnostics-doctor"]')?.getAttribute('aria-busy')).toBe(
        'false',
      ),
    )
    expect(runtime).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="plugin-diagnostics"]')?.textContent).toContain(
      'Technical details',
    )
    expect(host.querySelector('[data-testid="runtime-generations"]')).toBeNull()
    // Leftover plugin files are read and released here, without the plugins page being open.
    // Cleanup opens directly from diagnostics, without loading technical runtime details.
    expect(host.querySelector('[data-testid="runtime-occupancy"]')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="runtime-pins"]')!.click())
    expect(runtime).not.toHaveBeenCalled()
    const occupancy = host.querySelector<HTMLElement>('[data-testid="runtime-occupancy"]')
    await vi.waitFor(() => expect(occupancy?.textContent).toContain('Unable to check plugin cleanup status'))
    expect(occupancy?.querySelector('[data-testid="pin-row"]')).toBeNull()
    expect(occupancy?.textContent).not.toContain('No retention records need cleanup')
    const retry = occupancy?.querySelector<HTMLButtonElement>('button')
    expect(retry?.textContent).toBe('Retry')
    await act(async () => retry!.click())
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
      'Run diagnostics',
      'Plugin file cleanup',
    ])
    expect(
      host.querySelector('[data-testid="settings-subpage-header"] [data-testid="settings-refresh"]'),
    ).toBeNull()
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

it('opens the application adoption page in its stable group independently of the runtime catalog', async () => {
  const form = document.createElement('div')
  form.id = 'config-form'
  form.dataset.runtimePage = 'application'
  const host = document.createElement('div')
  document.body.append(form, host)
  const root = createRoot(host)
  const runtime = vi.fn(async () => {
    throw new Error('must not load runtime')
  })
  try {
    const application = vi.fn<PluginAdminApi['application']>(async () => ({
      revision: 1,
      selection: null,
      status: 'host',
      effective: null,
      assets: {},
      candidates: [{ packageId: 'acme/kit', applicationId: 'Acme', version: '1.0.0', available: true }],
    }))
    await act(async () =>
      root.render(createElement(SettingsPages, { admin: adminOf({ runtime, application }) })),
    )
    await vi.waitFor(() => expect(host.textContent).toContain('1.0.0'))
    expect(host.textContent).toContain('agh app clear')
    expect(application).toHaveBeenCalled()
    expect(host.querySelector('[data-testid="application-placeholder"]')).toBeNull()
    expect(settingsSections.entries().filter((entry) => entry.id === 'application')).toHaveLength(1)
    expect(settingsSections.get('application')?.group).toBe('application')
    expect(runtime).not.toHaveBeenCalled()
    const { settingsRoute, settingsGroup } = await import('@agnes/web-units/shell')
    expect(settingsGroup('application')).toBe('application')
    for (const [old, anchor] of [
      ['agent-fde', 'bundles'],
      ['runtime-config', 'models'],
      ['system-prompt', 'system-prompt'],
      ['execution', 'session-loop'],
      ['context', 'context'],
    ] as const)
      expect(settingsRoute(old)).toEqual({ id: 'models', anchor: `settings-subsection-${anchor}` })
    expect(settingsSections.get('models')?.group).toBe('accounts')
    expect(settingsSections.get('diagnostics')?.group).toBe('advanced')
  } finally {
    await act(async () => root.unmount())
  }
})

it('keeps advanced composition reachable behind technical details while leading with agent tasks', async () => {
  const form = document.createElement('div')
  form.id = 'config-form'
  form.dataset.runtimePage = 'models'
  const host = document.createElement('div')
  document.body.append(form, host)
  const root = createRoot(host)
  vi.stubGlobal('fetch', async () => Response.json({ error: { message: 'off' } }, { status: 503 }))
  const runtime = vi.fn(
    async (): Promise<RuntimeAdminSnapshot> => ({
      providers: [],
      presets: [],
      localPluginFolders: { home: '/fixture/plugins', workspace: '/fixture/workspace' },
    }),
  )
  const bundles = vi.fn(async () => ({
    revision: 2,
    bundles: [],
    effect: 'restart-required' as const,
    catalog: [],
  }))
  try {
    await act(async () =>
      root.render(
        createElement(SettingsPages, {
          admin: adminOf({
            runtime,
            bundles,
            loops: async () => ({ loops: [], defaults: {}, revision: 1 }),
            modelAdapters: async () => ({ modelAdapters: [] }),
            composition: async () => {
              throw new Error('off')
            },
            list: async () => {
              throw new Error('off')
            },
          }),
        }),
      ),
    )
    await vi.waitFor(() => expect(host.querySelector('[data-testid="run-config-technical"]')).not.toBeNull())
    expect(host.textContent).toContain('These settings only affect new sessions')
    const technical = host.querySelector<HTMLElement>('[data-testid="run-config-technical"]')
    const toggle = technical?.querySelector<HTMLButtonElement>(':scope > button')
    if (!technical || !toggle) throw new Error('technical details missing')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(technical.textContent).toContain('Preset IDs identify permission profiles')
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="settings-drill-bundles"]')?.click(),
    )
    await vi.waitFor(() => expect(host.querySelector('[data-testid="bundles-empty"]')).not.toBeNull())
    expect(bundles).toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
