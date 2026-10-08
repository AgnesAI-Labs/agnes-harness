/** @vitest-environment happy-dom */
import type { PackageInstalledDescriptor, RuntimeAdminSnapshot } from '@agnes/protocol'
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
import { LoopPicker, updateLoopPicker } from '../src/loop-picker.js'
import { SETTINGS_PAGES, SettingsHub } from '../src/settings/hub.js'
import { settingsCatalog } from '../src/settings/locales.js'
import { GenerationsPanel, PublicationPanel } from '../src/settings/runtime-panels.js'

import { SecurityStatusPanel } from '../src/settings/security-status.js'
import { effectiveSessionPreset, permissionForSessionPreset } from '../src/settings/session-choice.js'

import { SessionToolsPanel } from '../src/settings/session-tools.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string) => pluginAdminLocaleCatalog.en[key] ?? key
const roots: Root[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
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

it('shows actual session tool groups and their activation reasons in both languages', async () => {
  for (const locale of ['en', 'zh-CN'] as const) {
    const text = (key: string) => settingsCatalog[locale][key] ?? key
    const host = await mount(
      createElement(SessionToolsPanel, {
        t: text,
        value: {
          sessions: [
            {
              sessionKey: 'fixture-session',
              preset: 'standard',
              toolGroups: [
                { packageId: '@agnes/base', reason: 'official-default', bundles: [], tools: ['read'] },
                { packageId: 'acme/general', reason: 'enabled-plugin', bundles: [], tools: ['lookup'] },
                {
                  packageId: 'acme/demo',
                  reason: 'bundle',
                  bundles: ['acme/demo#demo'],
                  tools: ['demo_read'],
                },
                { packageId: 'ignored', reason: 'unknown', bundles: [], tools: ['secret'] },
              ],
            },
          ],
        },
      }),
    )
    expect(host.querySelector('[data-testid=session-tool-groups] summary')?.textContent).toBe(
      text('sessionToolSession').replace('{number}', '1'),
    )
    expect(host.querySelector('[data-testid=session-tool-groups] details')?.hasAttribute('open')).toBe(false)
    expect(host.querySelector('[data-testid=session-tool-groups] details')?.textContent).toContain(
      'fixture-session',
    )
    expect(host.textContent).toContain(text('toolReason.official-default'))
    expect(host.textContent).toContain(text('toolReason.enabled-plugin'))
    expect(host.textContent).toContain(text('toolReason.bundle'))
    expect(host.textContent).toContain('acme/demo#demo')
    expect(host.textContent).toContain('demo_read')
    expect(host.textContent).not.toContain('ignored')
    const source = { layer: 'session', name: 'review-work' }
    const current = await mount(
      createElement(SessionToolsPanel, {
        t: text,
        value: {
          sessions: [
            {
              sessionKey: 'current-session',
              preset: 'standard',
              toolGroups: [
                { packageId: 'stale', reason: 'enabled-plugin', bundles: [], tools: ['stale_tool'] },
              ],
              capabilities: {
                preset: 'standard',
                bundles: ['review'],
                codePin: { legacy: false, generationId: 'generation-current', packages: [] },
                loop: { value: { id: 'agnes.default', version: '1.0.0' }, source },
                modelRoutes: { value: null, source },
                permissions: {
                  preset: 'standard',
                  policy: 'default',
                  toolRuntime: 'default',
                  readOnly: false,
                  source,
                },
                sandbox: { provider: 'native', onUnavailable: 'deny', source },
                compaction: { engine: null, source },
                persistence: { provider: 'ledger', source },
                tools: [
                  { id: 'review_read', enabled: true, reasons: [{ source, rule: 'bundle:review' }] },
                  {
                    id: 'denied_write',
                    enabled: false,
                    reasons: [{ source: { layer: 'preset', name: 'read-only' }, rule: 'deny' }],
                  },
                ],
                mcp: [],
                skills: [],
                modelAdapters: [],
                childEngines: [],
                childModels: [],
                uiModules: [],
                surfaces: [],
                packages: [],
                plugins: [],
                selectedModelAdapters: [],
              },
            },
          ],
        },
      }),
    )
    expect(current.querySelector('[data-testid=session-capabilities]')).not.toBeNull()
    expect(current.textContent).toContain(text('capabilityWhy'))
    expect(current.textContent).toContain(text('capabilitySource.session'))
    expect(current.textContent).toContain('bundle:review')
    expect(current.textContent).toContain('review_read')
    expect(current.textContent).toContain(text('capabilityDisabled'))
    expect(current.textContent).not.toContain('stale_tool')
  }
})

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
    wireApi: 'openai-chat',
    capabilities: { imageInput: true, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const snapshot = {
    revision: 4,
    defaults: {
      preset: 'read-only',
      loop: { id: loop.id, version: loop.version },
      modelAdapter: { id: adapter.id, version: adapter.version, model: 'model' },
    },
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/loops'))
      return Response.json({
        loops: [loop],
        presets: ['read-only', 'workspace-write', 'full-access'],
        ...snapshot,
      })
    if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [adapter] })
    if (String(url).endsWith('/composition'))
      return Response.json({
        selection: { loop },
        sources: { loop: { layer: 'profile', name: 'test' } },
        preset: 'workspace-write',
      })
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
  expect(host.querySelector('[data-testid="admin-default-loop-readonly"]')?.textContent).toContain('workflow')
  expect(host.querySelector('[aria-label="Permission preset"]')).not.toBeNull()
  expect(host.textContent).toContain('read-only')
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

it('navigates runtime capabilities and never offers a disallowed security preset', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async () =>
      Response.json({ version: 1, configured: false, invalid: false, defaultProvider: null, providers: [] }),
    ),
  )
  const snapshot = {
    providers: [
      {
        kind: 'loop',
        id: 'custom',
        version: '1.0.0',
        sourcePackage: '@acme/loop',
        capabilities: ['resume'],
        restartRequired: false,
        active: true,
        selectedFor: ['default'],
        scope: 'session',
      },
      {
        kind: 'model-adapter',
        id: 'available-a',
        version: '1.0.0',
        sourcePackage: '@acme/models',
        capabilities: [],
        restartRequired: false,
        active: true,
        selectedFor: ['route:a'],
      },
      {
        kind: 'model-adapter',
        id: 'available-b',
        version: '1.0.0',
        sourcePackage: '@acme/models',
        capabilities: [],
        restartRequired: false,
        active: false,
        selectedFor: [],
      },
    ],
    presets: [{ id: 'standard', isDefault: true }],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
  }
  const api = new PluginAdminApi(
    { profile: 'local-dev', clientId: 'admin', permissions: ['packages.read'], readOnly: true },
    vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith('/runtime')) return Response.json(snapshot)
      if (String(url).endsWith('/loops')) return Response.json({ loops: [], revision: 0, defaults: {} })
      if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [] })
      if (String(url).endsWith('/bundles'))
        return Response.json({ revision: 0, bundles: [], catalog: [], effect: 'restart-required' })
      return Response.json({ items: [], nextCursor: null })
    }),
  )
  const host = await mount(
    createElement(SettingsHub, {
      api,
      canSave: false,
      pluginText: t,
      installed: [],
      generations: undefined,
      onPage() {},
      onRefresh: async () => {},
      onReview() {},
    }),
  )
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.querySelector('[data-testid="settings-nav-resources"]')).toBeNull()
  for (const page of SETTINGS_PAGES) {
    await act(async () =>
      host.querySelector<HTMLButtonElement>(`[data-testid="settings-nav-${page}"]`)?.click(),
    )
    expect(host.querySelector(`[data-testid="settings-page-${page}"]`)).not.toBeNull()
    expect(host.querySelector(`[data-testid="settings-nav-${page}"]`)?.getAttribute('aria-current')).toBe(
      'page',
    )
    if (page === 'providers') {
      expect(host.textContent).toContain('@acme/loop')
      expect(host.querySelectorAll('[data-testid^="providers-"]')).toHaveLength(8)
      const adapters = host.querySelector('[data-testid=providers-model-adapter]')
      expect(
        [...(adapters?.querySelectorAll('.agnes-settings-actions .agnes-ui-badge') ?? [])].map(
          (badge) => badge.textContent,
        ),
      ).toEqual(['Available', 'Available'])
    }
    if (page === 'security') {
      expect(host.querySelectorAll('[data-testid^="security-"]')).toHaveLength(3)
      expect(host.querySelector('a[href*="preset=read-only"]')).toBeNull()
      expect(host.textContent).toContain('Not allowed by this profile')
    }
  }
})

it('reports publication failures and requires an explicit eligible migration without changing pins on refusal', async () => {
  const text = (key: string) => settingsCatalog.en[key] ?? key
  const context = {
    profile: 'local-dev',
    clientId: 'admin',
    permissions: ['packages.read'] as const,
    readOnly: true,
  }
  const unsupported = await mount(
    createElement(GenerationsPanel, { api: undefined, status: undefined, canSave: true, t: text }),
  )
  expect(unsupported.querySelector<HTMLButtonElement>('[data-testid="migrate-session"]')?.disabled).toBe(true)
  expect(unsupported.textContent).toContain(text('migrationUnavailable'))
  const publication = await mount(
    createElement(PublicationPanel, {
      snapshot: {
        providers: [],
        presets: [],
        localPluginFolders: { home: '/synthetic', workspace: '/synthetic' },
        publication: {
          operation: 'models',
          ok: false,
          recovery: 'retry-same-input',
          containers: [
            { compositionHash: 'container-a', status: 'applied' },
            { compositionHash: 'container-b', status: 'failed' },
          ],
        },
      },
      t: text,
    }),
  )
  expect(publication.querySelector('[role="alert"]')?.textContent).toBe(text('publicationRetry'))
  expect(publication.textContent).toContain('container-b')
  expect(publication.textContent).toContain(text('publicationFailed'))
  const migrateSession = vi.fn().mockRejectedValueOnce(new Error('BUSY')).mockResolvedValue({
    previousGenerationId: 'previous',
    generationId: 'current',
    changed: true,
  })
  const api = Object.assign(new PluginAdminApi({ ...context, readOnly: false }, vi.fn()), { migrateSession })
  const host = await mount(
    createElement(GenerationsPanel, { api, status: undefined, canSave: true, t: text }),
  )
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('[data-testid="migration-session-key"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!input || !setter) throw new Error('Missing session key input')
    setter.call(input, 'session-key')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="migrate-session"]')?.click())
  expect(migrateSession).not.toHaveBeenCalled()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-session-migration"]')?.click(),
  )
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(text('migrationFailed'))
  expect(host.textContent).not.toContain('previous')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-session-migration"]')?.click(),
  )
  expect(migrateSession).toHaveBeenLastCalledWith('session-key')
  expect(host.querySelector('[role="status"]')?.textContent).toBe(text('migrated'))
  expect(host.textContent).toContain('previous → current')
})

it('places ordered bundle and preset choices beside the loop only for a new session', async () => {
  const bundles = [
    { id: 'acme#support', sourcePackage: 'acme' },
    { id: 'acme#report', sourcePackage: 'acme' },
  ]
  await act(async () =>
    updateLoopPicker({
      visible: true,
      disabled: false,
      loops: [],
      label: 'Loop',
      inherited: 'Inherit',
      unavailable: 'Unavailable',
      presets: [{ id: 'read-only', isDefault: true }],
      presetLabel: 'Preset',
      inheritedPreset: 'read-only',
      bundles,
      selectedBundles: ['acme#report', 'acme#support'],
      bundlesLabel: 'Bundles',
      onSelect() {},
      onPreset() {},
      onBundles() {},
    }),
  )
  const host = await mount(createElement(LoopPicker))
  expect(host.querySelectorAll('[role="combobox"]')).toHaveLength(0)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.click())
  expect(document.querySelectorAll('[role="combobox"]')).toHaveLength(2)
  expect(document.querySelector('[data-testid="new-session-preset-readonly"]')?.textContent).toContain(
    'Read only',
  )
  expect(document.querySelector('[data-testid="new-session-bundles"]')?.textContent).toContain('acme#report')
  await act(async () =>
    updateLoopPicker({
      visible: false,
      disabled: true,
      loops: [],
      label: 'Loop',
      inherited: 'Inherit',
      unavailable: 'Unavailable',
      onSelect() {},
    }),
  )
  expect(host.querySelector('[data-testid="new-session-bundles"]')).toBeNull()
})

it('inherits the admin preset before the profile default and renders its permission policy', () => {
  const runtime: RuntimeAdminSnapshot = {
    providers: [],
    presets: [
      { id: 'standard', isDefault: true },
      { id: 'read-only', isDefault: false },
    ],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
    security: {
      platform: { os: 'linux', l1: { level: 'full', scope: ['file'] } },
      presetPolicies: [
        {
          id: 'review',
          level: 'L1',
          required: true,
          onUnavailable: 'deny',
          approvalPolicy: 'read-only',
          networkMode: 'deny',
        },
      ],
      workspaces: [],
    },
  }
  expect(effectiveSessionPreset(undefined, { preset: 'read-only' }, runtime)).toBe('read-only')
  expect(effectiveSessionPreset('full-access', { preset: 'read-only' }, runtime)).toBe('full-access')
  expect(effectiveSessionPreset(undefined, {}, runtime)).toBe('standard')
  expect(permissionForSessionPreset('read-only', runtime)).toBe('view')
  expect(permissionForSessionPreset('review', runtime)).toBe('view')
  expect(permissionForSessionPreset('workspace-write', runtime)).toBe('workspace')
  expect(permissionForSessionPreset('full-access', runtime)).toBe('full')
  expect(permissionForSessionPreset('unknown', runtime)).toBeUndefined()
})

it('distinguishes requested permissions from measured workspace enforcement', async () => {
  const text = (key: string) => settingsCatalog.en[key] ?? key
  const missing = await mount(createElement(SecurityStatusPanel, { status: undefined, t: text }))
  expect(missing.textContent).toContain(text('securityUnavailable'))
  const host = await mount(
    createElement(SecurityStatusPanel, {
      status: {
        platform: { os: 'linux', l1: { level: 'unavailable', scope: [], reason: 'Not probed' } },
        presetPolicies: [
          {
            id: 'read-only',
            level: 'L1',
            required: true,
            onUnavailable: 'deny',
            approvalPolicy: 'read-only',
            networkMode: 'deny',
          },
          {
            id: 'full-access',
            level: 'L0',
            required: false,
            onUnavailable: 'allow',
            approvalPolicy: 'full-access',
            networkMode: 'unrestricted',
          },
        ],
        workspaces: [
          {
            sessionId: 'session-a',
            path: '/synthetic',
            preset: 'read-only',
            provider: 'local',
            state: 'ready',
            enforcement: { level: 'partial', scope: ['file'] },
            policyDigest: 'bound-digest',
          },
          {
            sessionId: 'session-b',
            path: '/synthetic',
            preset: 'full-access',
            provider: 'local',
            state: 'unavailable',
          },
        ],
      },
      t: text,
    }),
  )
  expect(host.querySelector('[data-testid="permission-preset-status"]')?.textContent).toContain(
    text('network.unrestricted'),
  )
  const rows = host.querySelectorAll('[data-testid="workspace-sandbox-status"]')
  expect(rows).toHaveLength(2)
  expect(rows[0]?.textContent).toContain(text('enforcement.partial'))
  expect(rows[0]?.textContent).toContain('bound-digest')
  expect(rows[1]?.textContent).toContain(text('unmeasured'))
  expect(rows[1]?.querySelector('[data-testid=workspace-enforcement]')?.textContent).not.toContain(
    text('enforcement.full'),
  )
})
