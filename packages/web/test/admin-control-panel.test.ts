/** @vitest-environment happy-dom */

import type { PackageInstalledDescriptor, RuntimeAdminSnapshot } from '@agnes/protocol'
import { PluginAdminApi } from '@agnes/web-admin/admin/plugins/api'
import {
  GenerationDrainSummary,
  KindFilter,
  PluginBadges,
  pluginStates,
  SessionDefaultsPanel,
} from '@agnes/web-admin/admin/plugins/control-panel'
import { pluginAdminLocaleCatalog } from '@agnes/web-admin/admin/plugins/locales/admin'
import { sessionLoopSelection } from '@agnes/web-admin/admin/plugins/session-loop'
import { SETTINGS_PAGES, SettingsHub } from '@agnes/web-admin/settings/hub'
import { settingsCatalog } from '@agnes/web-admin/settings/locales'
import {
  GenerationsPanel,
  LocalPluginsPanel,
  PublicationPanel,
} from '@agnes/web-admin/settings/runtime-panels'
import { SecurityStatusPanel } from '@agnes/web-admin/settings/security-status'
import { effectiveSessionPreset, permissionForSessionPreset } from '@agnes/web-admin/settings/session-choice'
import { SessionToolsPanel } from '@agnes/web-admin/settings/session-tools'
import {
  installFeedbackSink,
  type OperationFeedback,
  SettingsSubpageFrame,
  setDisclosureOpen,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LoopPicker, namedLoops, updateLoopPicker } from '../src/loop-picker.js'
import {
  defaultRecipe,
  draftPermissionMode,
  newSessionRequest,
  openSessionMode,
  sessionPermissionLevel,
} from '../src/session-permission.js'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const t = (key: string, params?: Record<string, string | number>) =>
  (pluginAdminLocaleCatalog.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? name))
const roots: Root[] = []
const outcomes: OperationFeedback[] = []
let releaseFeedback: (() => void) | undefined
beforeEach(() => {
  outcomes.length = 0
  releaseFeedback = installFeedbackSink({ publish: (result) => outcomes.push(result), resolve() {} })
})
afterEach(async () => {
  releaseFeedback?.()
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
  provides: ['loop', 'ui'],
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
    expect(host.querySelector('[data-testid=session-tool-groups] .agh-disclosure-summary')?.textContent).toBe(
      text('sessionToolSession').replace('{number}', '1'),
    )
    expect(
      host.querySelector('[data-testid=session-tool-groups] .agh-disclosure')?.getAttribute('data-open'),
    ).toBe('false')
    expect(host.querySelector('[data-testid=session-tool-groups] .agh-disclosure')?.textContent).toContain(
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
  expect(host.textContent).not.toContain('Agent Loop')
  expect(host.textContent).not.toContain('UI')
  expect(pluginStates(item).map((state) => state.key)).toEqual([])
  expect(host.textContent).not.toContain('Draining')
  expect(
    pluginStates({ ...item, actual: 'restart-required', draining: true }).map((state) => state.key),
  ).toEqual(['restart-required'])
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
  expect(draining.textContent).toContain('In use')
  expect(draining.textContent).not.toContain('(3)')
  expect(draining.querySelectorAll('.agh-tag')).toHaveLength(1)
  const removed = await mount(
    createElement(GenerationDrainSummary, {
      installed: [item, { ...item, id: '@acme/removed' }],
      nameOf: () => 'Friendly plugin',
      status: {
        currentGenerationId: 'current',
        generations: [
          {
            id: 'old',
            state: 'draining',
            boundSessions: 3,
            openSessions: 3,
            live: true,
            packages: [
              { id: item.id, version: '0.9.0' },
              { id: '@acme/removed', version: '1.0.0' },
              { id: '@agnes/base', version: '1.0.0' },
            ],
          },
        ],
        plugins: [
          { id: item.id, state: 'active', boundSessions: 3, drainingSessions: 3, historicalSessions: 0 },
          {
            id: '@acme/removed',
            state: 'draining',
            boundSessions: 3,
            drainingSessions: 3,
            historicalSessions: 0,
          },
          {
            id: '@agnes/base',
            state: 'draining',
            boundSessions: 3,
            drainingSessions: 3,
            historicalSessions: 0,
          },
        ],
      },
      t,
    }),
  )
  expect(removed.querySelector('[data-testid=plugin-drain-summary]')?.textContent).toBe(
    '3 ongoing sessions keep their pinned backend tools.',
  )
  expect(removed.querySelector('.agh-disclosure')?.getAttribute('data-open')).toBe('false')
  expect(removed.textContent).toContain('Friendly plugin')
  expect(removed.textContent).toContain('0.9.0')
  expect(removed.textContent).toContain('old')
  expect(removed.textContent).not.toContain('@agnes/base')
  const historicalStatus = {
    generations: [
      {
        id: 'saved',
        state: 'historical' as const,
        boundSessions: 2,
        openSessions: 0,
        live: false,
        packages: [{ id: item.id, version: '0.8.0' }],
      },
    ],
    plugins: [
      { id: item.id, state: 'active' as const, boundSessions: 2, drainingSessions: 2, historicalSessions: 2 },
    ],
  }
  const history = await mount(
    createElement(GenerationDrainSummary, { installed: [item], status: historicalStatus, t }),
  )
  expect(history.querySelector('[data-testid=plugin-historical-summary]')?.textContent).toContain(
    '2 saved sessions',
  )
  expect(history.textContent).toContain('Migrate session to current plugins')
  expect(history.textContent).not.toContain('ongoing sessions are unaffected')
  const historyBadge = await mount(
    createElement(PluginBadges, { item: { ...item, draining: true }, status: historicalStatus, t }),
  )
  expect(historyBadge.textContent).toBe('Saved sessions use an older version')
  expect(historyBadge.querySelector('[role=note]')?.getAttribute('aria-label')).toContain(
    'New sessions use only enabled plugins',
  )
  expect(historyBadge.querySelector('[role=note]')?.getAttribute('tabindex')).toBe('0')
  for (const locale of ['en', 'zh-CN'] as const) {
    const retained = await mount(
      createElement(GenerationDrainSummary, {
        installed: [item],
        t: (key, params) =>
          (pluginAdminLocaleCatalog[locale][key] ?? key).replace(/\{(\w+)\}/g, (_, name) =>
            String(params?.[name] ?? name),
          ),
        status: {
          ...historicalStatus,
          currentGenerationId: 'current',
          generations: [
            ...historicalStatus.generations,
            {
              ...historicalStatus.generations[0]!,
              id: 'failed-old',
              state: 'failed',
              error: 'E_SEAM_INIT',
              packages: [{ id: item.id, version: '0.7.0' }],
            },
            {
              ...historicalStatus.generations[0]!,
              id: 'current',
              current: true,
              state: 'failed',
              error: 'E_PROVIDER_INVALID',
              packages: [{ id: item.id, version: '1.0.0' }],
            },
            {
              ...historicalStatus.generations[0]!,
              id: 'role-current',
              current: true,
              state: 'failed',
              error: 'E_PROVIDER_UNAVAILABLE',
              packages: [{ id: item.id, version: '1.0.0' }],
            },
          ],
        },
      }),
    )
    expect(retained.querySelector('[data-testid=plugin-retained-failures]')?.textContent).toContain(
      locale === 'en' ? 'Retained version failures: 1' : '1 个保留版本失败',
    )
    expect(retained.textContent).toContain('0.7.0')
    expect(retained.textContent).toContain('E_SEAM_INIT')
    expect(retained.textContent).not.toContain('E_PROVIDER_INVALID')
    expect(retained.textContent).not.toContain('E_PROVIDER_UNAVAILABLE')
  }
  const builtins = await mount(
    createElement(GenerationDrainSummary, {
      installed: [],
      t,
      status: {
        generations: [],
        plugins: [
          {
            id: '@agnes/ai',
            state: 'draining',
            boundSessions: 1,
            drainingSessions: 1,
            historicalSessions: 0,
          },
        ],
      },
    }),
  )
  expect(builtins.textContent).toBe('')
  const filter = await mount(createElement(KindFilter, { value: '', onChange: vi.fn(), t }))
  expect(filter.querySelector('[role="combobox"]')?.getAttribute('aria-label')).toBe('Capability')
  // The trigger reads 「All」; the list sizes to its longest option instead of matching the trigger.
  await act(async () => {
    filter.querySelector('[role="combobox"]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  })
  const popup = document.querySelector<HTMLElement>('.ant-select-dropdown')
  expect(popup?.style.minWidth).toBe('10rem')
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
    wireApi: 'openai-chat',
    capabilities: { imageInput: true, tools: true, streaming: true },
    models: [{ id: 'model' }],
  }
  const snapshot = {
    revision: 4,
    defaults: {
      preset: 'standard',
      permission: 'read-only',
      providers: {
        loop: { provider: loop.id, version: loop.version },
        'model-adapter': { provider: adapter.id, version: adapter.version },
      },
      model: 'model',
    },
  }
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/loops'))
      return Response.json({
        loops: [
          loop,
          ...Array.from({ length: 6 }, (_, index) => ({
            ...loop,
            id: `plugin-loop-${index}`,
            sourcePackage: `@acme/loop-${index}`,
          })),
        ],
        presets: ['standard', 'ptc'],
        ...snapshot,
      })
    if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [adapter] })
    if (String(url).endsWith('/composition'))
      return Response.json({
        selection: { loop },
        sources: { loop: { layer: 'profile', name: 'test' } },
        preset: 'standard',
        permission: 'workspace-write',
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
  const outerSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault())
  const host = await mount(
    createElement(
      'form',
      { onSubmit: outerSubmit },
      createElement(
        SettingsSubpageFrame,
        { header: null },
        createElement(SessionDefaultsPanel, { api, canSave: true, t }),
      ),
    ),
  )
  expect(host.querySelector('form form')).toBeNull()
  expect(host.querySelector('[data-testid="session-defaults"] h3')?.textContent).toBe('New session defaults')
  // One row per choice: its name on the left, its control or value on the right. The permission
  // preset is chosen under 权限与安全 only.
  expect(
    [...host.querySelectorAll('[data-testid="session-defaults"] .agnes-settings-item-label')].map(
      (label) => label.textContent,
    ),
  ).toEqual(['Running mode', 'Model', 'Model adapter'])
  expect(host.textContent).not.toContain('Permissions')
  // Nothing to press: there is no save button.
  expect(host.querySelector('[data-testid="session-defaults-save"]')).toBeNull()
  const loopRow = host.querySelector<HTMLButtonElement>('[data-testid="session-default-loop"]')
  expect(loopRow?.textContent).toContain('workflow')
  // Identifiers stay off the rows; the loop's source and capabilities are in its subpage.
  expect(host.querySelector('[data-testid="session-defaults"]')?.textContent).not.toContain('1.0.0')
  await act(async () => loopRow?.click())
  expect(
    host.querySelector('[data-testid="session-loop-workflow"]')?.closest('label')?.textContent,
  ).toContain('@acme/workflow 1.0.0')
  expect(
    host.querySelector('[data-testid="session-loop-workflow"]')?.closest('label')?.textContent,
  ).toContain('resume')
  const choices = host.querySelector('[role="radiogroup"]')!
  expect(choices.classList.contains('agh-segmented')).toBe(false)
  expect(choices.querySelectorAll('input[type="radio"]')).toHaveLength(8)
  expect(choices.textContent).toContain('@acme/loop-5 1.0.0')
  // Choosing 「follow the default」 saves at once and keeps the preset chosen elsewhere.
  await act(async () => host.querySelector<HTMLInputElement>('[data-testid="session-loop-follow"]')?.click())
  const saved = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/defaults'))
  expect(saved).toHaveLength(1)
  expect(JSON.parse(String(saved[0]?.[1]?.body))).toEqual({
    revision: 4,
    defaults: {
      preset: 'standard',
      permission: 'read-only',
      providers: { 'model-adapter': { provider: adapter.id, version: adapter.version } },
      model: 'model',
    },
  })
  expect(host.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
  expect(outerSubmit).not.toHaveBeenCalled()
})

it('rereads new-session defaults after a revision conflict so retry saves on the current revision', async () => {
  const loop = { id: 'workflow', version: '1.0.0', sourcePackage: '@acme/workflow', capabilities: [] }
  let revision = 4
  let conflict = true
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/loops'))
      return Response.json({
        loops: [loop],
        revision,
        defaults: { preset: 'standard', permission: 'read-only' },
      })
    if (String(url).endsWith('/model-adapters')) return Response.json({ modelAdapters: [] })
    if (String(url).endsWith('/composition')) return Response.json({})
    const body = JSON.parse(String(init?.body))
    if (conflict) {
      conflict = false
      revision = 9
      return Response.json(
        { error: { code: 'CONFIG_REVISION_CONFLICT', message: 'changed' } },
        { status: 409 },
      )
    }
    return Response.json({ revision: body.revision + 1, defaults: body.defaults })
  })
  const api = new PluginAdminApi(
    { profile: 'local-dev', clientId: 'admin', permissions: ['packages.activate'], readOnly: false },
    fetcher,
  )
  const host = await mount(
    createElement(
      SettingsSubpageFrame,
      { header: null },
      createElement(SessionDefaultsPanel, { api, canSave: true, t }),
    ),
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="session-default-loop"]')?.click(),
  )
  await act(async () =>
    host.querySelector<HTMLInputElement>('[data-testid="session-loop-workflow"]')?.click(),
  )
  await act(async () => {})
  const saves = () =>
    fetcher.mock.calls
      .filter(([url]) => String(url).endsWith('/defaults'))
      .map(([, init]) => JSON.parse(String(init?.body)))
  expect(saves().at(-1)?.revision).toBe(4)
  expect(host.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull()
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="settings-save-retry"]')?.click())
  expect(saves().at(-1)).toEqual({
    revision: 9,
    defaults: {
      preset: 'standard',
      permission: 'read-only',
      providers: { loop: { provider: 'workflow', version: '1.0.0' } },
    },
  })
})

it('reports an unavailable catalog as one line with retry, and leaves read-only controls disabled', async () => {
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
  expect(host.querySelector('[data-testid="loadable-error"]')).not.toBeNull()
  expect(host.querySelector('form')).toBeNull()
  fetcher.mockImplementation(async (url) =>
    String(url).endsWith('/loops')
      ? Response.json({ loops: [], revision: 0, defaults: {} })
      : Response.json({ modelAdapters: [] }),
  )
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="loadable-retry"]')?.click())
  expect(host.querySelector('[data-testid="loadable-error"]')).toBeNull()
  expect(host.querySelectorAll('.ant-select-disabled').length).toBeGreaterThanOrEqual(2)
})

it('lists the other provider slots as rows that state what is in effect, the rarer ones in a subpage', async () => {
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith('/loops')
      ? Response.json({ loops: [], revision: 0, defaults: {} })
      : String(url).endsWith('/model-adapters')
        ? Response.json({ modelAdapters: [] })
        : Response.json({}),
  )
  const api = new PluginAdminApi(
    { profile: 'local-dev', clientId: 'admin', permissions: ['packages.read'], readOnly: false },
    fetcher,
  )
  const provider = (kind: string, id: string, active: boolean) => ({
    kind,
    id,
    version: '1.0.0',
    sourcePackage: '@acme/pack',
    capabilities: [],
    restartRequired: false,
    required: false,
    pinned: false,
    active,
    selectedFor: [],
  })
  const host = await mount(
    createElement(
      SettingsSubpageFrame,
      { header: null },
      createElement(SessionDefaultsPanel, {
        api,
        canSave: true,
        t,
        providers: [
          provider('memory', 'files', true),
          provider('memory', 'vector', false),
          provider('child-agent', 'builtin', true),
          provider('sandbox', 'native', true),
        ],
      }),
    ),
  )
  // Two memory providers are installed: the row lists both and its ⓘ says why it cannot be changed.
  const memory = host.querySelector('[data-testid="session-default-slot-memory"]')
  expect(memory?.querySelector('.ant-select-disabled')).not.toBeNull()
  expect(memory?.querySelector('.agnes-settings-info')?.getAttribute('aria-label')).toBe(
    t('defaults.slot-fixed'),
  )
  // One child-agent provider: the row simply names it.
  const child = host.querySelector('[data-testid="session-default-slot-child-agent"]')
  expect(child?.querySelector('[role="combobox"]')).toBeNull()
  expect(child?.textContent).toContain('builtin')
  // Sandbox and the other rarely changed slots are a subpage; slots nothing provides are not listed.
  expect(host.querySelector('[data-testid="session-default-slot-sandbox"]')).toBeNull()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="session-default-more-slots"]')?.click(),
  )
  const sandbox = host.querySelector('[data-testid="session-default-slot-sandbox"]')
  expect(sandbox?.textContent).toContain(t('defaults.slot-profile'))
  expect(host.querySelector('[data-testid="session-default-slot-compaction"]')).toBeNull()
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
        required: false,
        authority: 'open' as const,
        pinned: false,
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
        required: false,
        authority: 'open' as const,
        pinned: false,
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
        required: false,
        authority: 'open' as const,
        pinned: false,
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
      (
        host.querySelector<HTMLButtonElement>(`[data-testid="settings-nav-${page}-tab"]`) ??
        host.querySelector<HTMLButtonElement>(`[data-testid="settings-nav-${page}"]`)
      )?.click(),
    )
    expect(host.querySelector(`[data-testid="settings-page-${page}"]`)).not.toBeNull()
    expect(
      host.querySelector(`[data-testid="settings-nav-${page}-tab"]`)?.getAttribute('aria-selected') ??
        host.querySelector(`[data-testid="settings-nav-${page}"]`)?.getAttribute('aria-current'),
    ).toBe(host.querySelector(`[data-testid="settings-nav-${page}-tab"]`) ? 'true' : 'page')
    if (page === 'diagnostics') {
      // 运行详情 is a subpage; its provider record opens in place.
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[data-testid="plugin-diagnostics"]')?.click(),
      )
      await vi.waitFor(() =>
        expect(
          host.querySelector('[data-testid="settings-subsection-provider-types-toggle"]'),
        ).not.toBeNull(),
      )
      await act(async () =>
        host
          .querySelector<HTMLButtonElement>('[data-testid="settings-subsection-provider-types-toggle"]')
          ?.click(),
      )
      await vi.waitFor(() => expect(host.querySelector('[data-testid="providers-loop"]')).not.toBeNull())
      expect(host.textContent).toContain('@acme/loop')
      expect(host.querySelectorAll('[data-testid^="providers-"]')).toHaveLength(9)
      expect(host.querySelector('[data-testid=providers-memory]')).not.toBeNull()
      const adapters = host.querySelector('[data-testid=providers-model-adapter]')
      expect(
        [...(adapters?.querySelectorAll('.agh-meta') ?? [])].map((meta) => meta.textContent?.split(' · ')[0]),
      ).toEqual(['Available', 'Available'])
    }
    if (page === 'security') {
      const choices = host.querySelectorAll(
        '[data-testid="security-default-permissions"] input[type="radio"]',
      )
      expect(choices).toHaveLength(3)
      expect([...choices].every((choice) => (choice as HTMLInputElement).disabled)).toBe(true)
      expect(host.querySelector('a[href*="preset=read-only"]')).toBeNull()
      expect(host.textContent).toContain('Unavailable in this profile')
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
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(text('migrationFailed'))
  expect(host.querySelector('[role="alert"] button')?.textContent).toBe(text('confirmMigration'))
  expect(host.textContent).not.toContain('previous')
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-session-migration"]')?.click(),
  )
  expect(migrateSession).toHaveBeenLastCalledWith('session-key')
  expect(outcomes.at(-1)).toMatchObject({
    scope: 'session-migration',
    outcome: 'success',
    message: text('migrated'),
  })
  expect(host.textContent).toContain('previous → current')
})

it('offers the sessions still on an earlier plugin version for migration, by confirmation', async () => {
  const migrateSession = vi.fn().mockResolvedValue({
    previousGenerationId: 'previous',
    generationId: 'current',
    changed: true,
  })
  const text = (key: string) => settingsCatalog.en[key] ?? key
  const api = Object.assign(
    new PluginAdminApi(
      { profile: 'local-dev', clientId: 'admin', permissions: ['packages.read'], readOnly: false },
      vi.fn(),
    ),
    { migrateSession },
  )
  const current = '11111111-1111-4111-8111-111111111111'
  const earlier = '22222222-2222-4222-8222-222222222222'
  const generation = { boundSessions: 1, openSessions: 1, live: true, packages: [] }
  const host = await mount(
    createElement(GenerationsPanel, {
      api,
      canSave: true,
      t: text,
      status: {
        currentGenerationId: current,
        plugins: [],
        generations: [
          { ...generation, id: current, state: 'active', sessions: [{ key: 'on-current', open: true }] },
          {
            ...generation,
            id: '33333333-3333-4333-8333-333333333333',
            current: true,
            state: 'failed',
            error: 'E_SEAM_INIT',
            sessions: [{ key: 'on-role-current', open: false }],
          },
          {
            ...generation,
            id: earlier,
            state: 'draining',
            // The backend names a session and says whether a turn is running when it knows.
            sessions: [
              { key: 'on-earlier', open: false },
              { key: 'busy-key', open: true, title: 'Monthly reconciliation', run: 'running' },
            ],
          },
        ],
      },
    }),
  )
  // Only sessions bound to an earlier version are candidates.
  const rows = host.querySelectorAll('[data-testid="migration-session"]')
  expect([...rows].map((row) => row.querySelector('code')?.textContent)).toEqual(['on-earlier', 'busy-key'])
  expect(rows[1]?.querySelector('h4')?.textContent).toBe('Monthly reconciliation')
  expect(rows[1]?.textContent).toContain(text('migrateRunning'))
  // A session in the middle of a turn cannot be picked.
  expect(rows[1]?.querySelector<HTMLButtonElement>('[data-testid="migration-session-pick"]')?.disabled).toBe(
    true,
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="migration-session-pick"]')?.click(),
  )
  expect(migrateSession).not.toHaveBeenCalled()
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="confirm-session-migration"]')?.click(),
  )
  expect(migrateSession).toHaveBeenCalledWith('on-earlier')
  expect(host.textContent).toContain('previous → current')
})

it('trusts a workspace deploy directory the backend offers, by confirmation, and hides the list without one', async () => {
  const text = (key: string, vars?: Record<string, string | number>) =>
    (settingsCatalog.en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars?.[name] ?? ''))
  const trustWorkspace = vi.fn(async () => ({ hash: 'a'.repeat(64) }))
  const onRefresh = vi.fn(async () => {})
  const api = Object.assign(
    new PluginAdminApi(
      { profile: 'local-dev', clientId: 'admin', permissions: ['packages.trust'], readOnly: false },
      vi.fn(),
    ),
    { trustWorkspace },
  )
  const base = {
    providers: [],
    presets: [],
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
  }
  const without = await mount(
    createElement(LocalPluginsPanel, {
      api,
      snapshot: base,
      canSave: true,
      canTrust: true,
      t: text,
      onRefresh,
    }),
  )
  expect(without.querySelector('[data-testid="workspace-deployments"]')).toBeNull()
  const host = await mount(
    createElement(LocalPluginsPanel, {
      api,
      canSave: true,
      canTrust: true,
      t: text,
      onRefresh,
      snapshot: {
        ...base,
        workspaceDeployments: [
          {
            deployDir: 'workspaces/site',
            path: '/synthetic/site',
            manifestId: 'site',
            pluginCount: 2,
            trustHash: `sha256-${'b'.repeat(64)}`,
            state: 'untrusted',
          },
          { deployDir: 'workspaces/docs', path: '/synthetic/docs', manifestId: 'docs', state: 'trusted' },
        ],
      },
    }),
  )
  const rows = host.querySelectorAll('[data-testid="workspace-deployment"]')
  expect(rows).toHaveLength(2)
  // A trusted directory needs no action.
  expect(rows[1]?.querySelector('[data-testid="trust-workspace"]')).toBeNull()
  await act(async () => rows[0]?.querySelector<HTMLButtonElement>('[data-testid="trust-workspace"]')?.click())
  expect(trustWorkspace).not.toHaveBeenCalled()
  expect(host.querySelector('[data-testid="trust-workspace-confirm"]')?.textContent).toContain(
    '/synthetic/site',
  )
  expect(host.querySelector('[data-testid="trust-workspace-confirm"]')?.textContent).toContain(
    '2 local plugins',
  )
  expect(host.querySelector('[data-testid="trust-workspace-confirm"]')?.textContent).toContain(
    'your user rights',
  )
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-testid="trust-workspace-confirm-action"]')?.click(),
  )
  // What is sent is the backend's own value for the directory, not the display path.
  expect(trustWorkspace).toHaveBeenCalledWith('workspaces/site', `sha256-${'b'.repeat(64)}`)
  expect(onRefresh).toHaveBeenCalledOnce()
  expect(outcomes.at(-1)).toMatchObject({
    scope: 'plugin-folders',
    outcome: 'success',
    message: text('trusted'),
    effect: { kind: 'rescan-required' },
  })
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
      presets: [{ id: 'standard', isDefault: true }],
      presetLabel: 'Preset',
      inheritedPreset: 'standard',
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
    'Standard',
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

it('names a plugin loop after its installed plugin, leaving built-in and shared sources alone', () => {
  const loop = (id: string, sourcePackage: string) => ({
    id,
    version: '1.0.0',
    capabilities: [],
    sourcePackage,
  })
  const installed = [
    {
      id: '@agnes/jev-loop',
      metadata: { displayName: 'Jev Agent Loop', locales: { 'zh-CN': { displayName: 'Jev 运行方式' } } },
    },
    { id: 'acme', metadata: { displayName: 'Acme' } },
  ] as never
  const loops = [
    loop('agnes.default', '@agnes/base'),
    loop('agnes.jev', '@agnes/jev-loop'),
    loop('acme.a', 'acme'),
    loop('acme.b', 'acme'),
    loop('other', 'missing'),
  ]
  const t = (key: string) => (key === 'choice.agnes.default' ? 'Default' : key)
  expect(namedLoops(loops, installed, 'zh-CN', t).map((entry) => entry.label)).toEqual([
    undefined,
    'Jev 运行方式',
    undefined,
    undefined,
    undefined,
  ])
  expect(namedLoops(loops, installed, 'en', t)[1]?.label).toBe('Jev Agent Loop')
})

it('offers only the loop from the chip until advanced settings show or a bundle is in effect', async () => {
  const loops = [
    { id: 'default', version: '1.0.0', capabilities: [], sourcePackage: 'base' },
    { id: 'workflow', version: '1.0.0', capabilities: [], sourcePackage: 'acme' },
  ]
  const view = {
    visible: true,
    disabled: false,
    loops,
    label: 'Loop',
    inherited: 'Inherit',
    unavailable: 'Unavailable',
    presets: [
      { id: 'standard', isDefault: true },
      { id: 'read-only', isDefault: false },
      { id: 'review', isDefault: false },
    ],
    inheritedPreset: 'standard',
    bundles: [
      { id: 'acme#support', sourcePackage: 'acme' },
      { id: 'acme#report', sourcePackage: 'acme' },
    ],
    onSelect() {},
    onPreset() {},
    onBundles() {},
  }
  // Advanced settings show unless this browser turned them off.
  localStorage.setItem('agnes.settings.advanced', '0')
  await act(async () => updateLoopPicker(view))
  const host = await mount(createElement(LoopPicker))
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.click())
    expect(document.querySelector('[data-testid="new-session-loop"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="new-session-bundles"]')).toBeNull()
    expect(document.querySelector('[data-testid="new-session-preset"]')).toBeNull()
    // A bundle chosen for this draft changes what the session does, so it shows without the switch.
    await act(async () => updateLoopPicker({ ...view, selectedBundles: ['acme#report'] }))
    expect(document.querySelector('[data-testid="new-session-bundles"]')).not.toBeNull()
    await act(async () => updateLoopPicker(view))
    expect(document.querySelector('[data-testid="new-session-bundles"]')).toBeNull()
    // No stored choice is the same as on.
    localStorage.removeItem('agnes.settings.advanced')
    await act(async () => updateLoopPicker({ ...view }))
    expect(document.querySelector('[data-testid="new-session-bundles"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="new-session-preset"]')).not.toBeNull()
  } finally {
    localStorage.removeItem('agnes.settings.advanced')
    await act(async () => updateLoopPicker({ ...view, visible: false }))
  }
})

it.each([
  [
    'with minimal',
    ['standard', 'minimal', 'ptc'],
    ['Default (Standard)', 'Minimal tools', 'Programmatic tools'],
  ],
  ['without minimal', ['standard', 'ptc'], ['Default (Standard)', 'Programmatic tools']],
])('lists only recipes, the default one once as 「Default」 (%s)', async (_case, ids, expected) => {
  const onPreset = vi.fn()
  const view = {
    visible: true,
    disabled: false,
    loops: [],
    label: 'Loop',
    inherited: 'Inherit',
    unavailable: 'Unavailable',
    presets: ids.map((id) => ({
      id,
      isDefault: id === 'standard',
    })),
    inheritedPreset: 'standard',
    onSelect() {},
    onPreset,
  }
  await act(async () => updateLoopPicker(view))
  const host = await mount(createElement(LoopPicker))
  try {
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-agent"]')?.click())
    const open = async () =>
      act(async () =>
        document
          .querySelector('[data-testid="new-session-preset"] input')
          ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      )
    await open()
    const options = () => [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
    const names = options().map(
      (option) => option.querySelector('.agent-choice > span')?.textContent ?? option.textContent,
    )
    expect(names).toEqual(expected)
    const minimal = options().find((option) => option.textContent?.startsWith('Minimal tools'))
    expect(minimal?.getAttribute('title') ?? null).toBe(ids.includes('minimal') ? 'Read tools only' : null)
    await act(async () => options().at(-1)?.click())
    expect(onPreset).toHaveBeenLastCalledWith('ptc')
    // 「Default」 sends no preset, so the session follows the administrator default.
    await act(async () => updateLoopPicker({ ...view, preset: 'ptc' }))
    await open()
    await act(async () => options()[0]?.click())
    expect(onPreset).toHaveBeenLastCalledWith(undefined)
  } finally {
    await act(async () => updateLoopPicker({ ...view, visible: false }))
  }
})

it('inherits the admin preset before the profile default and renders its permission policy', () => {
  const runtime: RuntimeAdminSnapshot = {
    providers: [],
    presets: [
      { id: 'standard', isDefault: true },
      { id: 'review', isDefault: false },
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
  expect(effectiveSessionPreset(undefined, { preset: 'review' }, runtime)).toBe('review')
  expect(effectiveSessionPreset('custom-full', { preset: 'review' }, runtime)).toBe('custom-full')
  expect(effectiveSessionPreset(undefined, {}, runtime)).toBe('standard')
  expect(permissionForSessionPreset('read-only', runtime)).toBeUndefined()
  expect(permissionForSessionPreset('review', runtime)).toBe('view')
  expect(permissionForSessionPreset('workspace-write', runtime)).toBeUndefined()
  expect(permissionForSessionPreset('full-access', runtime)).toBeUndefined()
  expect(permissionForSessionPreset('unknown', runtime)).toBeUndefined()
})

it('keeps the draft preset and permission level independent and requests them as chosen', () => {
  const runtime = (permissions?: RuntimeAdminSnapshot['permissions']): RuntimeAdminSnapshot => ({
    providers: [],
    presets: ['standard', 'minimal', 'ptc'].map((id) => ({
      id,
      isDefault: id === 'standard',
    })),
    ...(permissions ? { permissions } : {}),
    localPluginFolders: { home: '/synthetic/plugins', workspace: '/synthetic/.agh/plugins' },
  })
  const levels = runtime([
    { id: 'read-only', isDefault: false },
    { id: 'workspace-write', isDefault: true },
    { id: 'full-access', isDefault: false },
  ])
  const draft = (input: Partial<Parameters<typeof newSessionRequest>[0]>) => ({
    explicit: undefined,
    remembered: undefined,
    preset: undefined,
    defaults: undefined,
    runtime: levels,
    ...input,
  })
  // Every draft sends a recipe and an explicit permission selection.
  expect(newSessionRequest(draft({}))).toEqual({ preset: 'standard', permission: 'default' })
  expect(newSessionRequest(draft({ preset: 'ptc' }))).toEqual({ preset: 'ptc', permission: 'default' })
  // A chosen or remembered level is sent with any recipe, and the recipe never moves the level.
  expect(newSessionRequest(draft({ preset: 'ptc', explicit: 'full' }))).toEqual({
    preset: 'ptc',
    permission: 'full-access',
  })
  expect(newSessionRequest(draft({ remembered: 'view' }))).toEqual({
    preset: 'standard',
    permission: 'read-only',
  })
  expect(draftPermissionMode(draft({ explicit: 'view', preset: 'ptc' }))).toBe('view')
  expect(draftPermissionMode(draft({ explicit: 'view', preset: 'minimal' }))).toBe('view')
  expect(draftPermissionMode(draft({}))).toBe('workspace')
  expect(draftPermissionMode(draft({ defaults: { permission: 'full-access' } }))).toBe('full')
  // A user's explicit recipe called default remains a real recipe.
  expect(defaultRecipe({ preset: 'default' }, levels)).toBe('default')
  expect(defaultRecipe({ preset: 'ptc' }, levels)).toBe('ptc')
  // A level the deployment refuses is never requested; a remembered one falls back to the default.
  const narrow = runtime([{ id: 'workspace-write', isDefault: true }])
  expect(newSessionRequest(draft({ runtime: narrow, explicit: 'view' }))).toBeUndefined()
  expect(newSessionRequest(draft({ runtime: narrow, remembered: 'view' }))).toEqual({
    preset: 'standard',
    permission: 'default',
  })
  expect(draftPermissionMode(draft({ runtime: narrow, remembered: 'view' }))).toBe('workspace')
  // A missing permission catalogue cannot authorize a selected level or produce recipe aliases.
  const unavailable = runtime()
  expect(newSessionRequest(draft({ runtime: unavailable, explicit: 'full' }))).toBeUndefined()
  expect(newSessionRequest(draft({ runtime: unavailable, preset: 'ptc' }))).toEqual({
    preset: 'ptc',
    permission: 'default',
  })
})

it('reads an open session level from its row before guessing from its recipe', () => {
  const runtime: RuntimeAdminSnapshot = {
    providers: [],
    presets: [],
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
      workspaces: [
        {
          sessionId: 'live',
          path: '/synthetic/work',
          preset: 'ptc',
          permission: 'full-access',
          provider: 'local',
          state: 'ready',
        },
      ],
    },
  }
  expect(sessionPermissionLevel({ sessionId: 's', permission: 'read-only', preset: 'ptc' }, runtime)).toBe(
    'read-only',
  )
  expect(sessionPermissionLevel({ sessionId: 'live', preset: 'ptc' }, runtime)).toBe('full-access')
  expect(sessionPermissionLevel({ sessionId: 's', preset: 'workspace-write' }, runtime)).toBeUndefined()
  expect(sessionPermissionLevel({ sessionId: 's', preset: 'review' }, runtime)).toBe('read-only')
  expect(sessionPermissionLevel({ sessionId: 's', preset: 'ptc' }, runtime)).toBeUndefined()
  // The yolo switch widens the display to full access, but never a read-only session.
  expect(openSessionMode('read-only', true, 'full')).toBe('view')
  expect(openSessionMode('workspace-write', true, 'workspace')).toBe('full')
  expect(openSessionMode('full-access', false, 'full')).toBe('workspace')
  expect(openSessionMode('workspace-write', false, 'view')).toBe('workspace')
  expect(openSessionMode(undefined, false, 'view')).toBe('view')
})

it('shows an unchecked platform as not checked, never as incomplete, and a measured failure as a warning', async () => {
  const text = (key: string) => settingsCatalog.en[key] ?? key
  const status = (l1: NonNullable<RuntimeAdminSnapshot['security']>['platform']['l1']) =>
    createElement(SecurityStatusPanel, {
      status: { platform: { os: 'darwin', l1 }, presetPolicies: [], workspaces: [] },
      t: text,
    })
  const unprobed = await mount(status({ level: 'unprobed', scope: [] }))
  // One row, four states: 未检测 is grey and says when it is checked.
  expect(unprobed.querySelector('[data-testid="sandbox-status-unprobed"]')?.textContent).toBe('Not checked')
  expect(unprobed.querySelector('[data-testid="sandbox-status-unprobed"]')?.getAttribute('data-tone')).toBe(
    'muted',
  )
  expect(unprobed.textContent).toContain('It is checked the first time a session runs')
  expect(unprobed.textContent).not.toContain('Isolation on this computer is incomplete')
  const partial = await mount(status({ level: 'partial', scope: ['file'] }))
  expect(partial.querySelector('[data-testid="sandbox-isolation"]')?.textContent).toContain(
    'Missing: Processes · Network',
  )
  expect(partial.querySelector('.agnes-settings-tag')?.getAttribute('data-tone')).toBe('warn')
  const details = await mount(
    createElement(SecurityStatusPanel, {
      status: {
        platform: { os: 'darwin', l1: { level: 'unprobed', scope: [] } },
        presetPolicies: [],
        workspaces: [],
      },
      t: text,
      view: 'details',
    }),
  )
  expect(details.textContent).toContain(text('enforcement.unprobed'))
  expect(text('enforcement.unprobed')).not.toBe('enforcement.unprobed')
  const failed = await mount(
    status({ level: 'unavailable', scope: [], reason: 'sandbox-exec rejected the profile' }),
  )
  expect(failed.querySelector('.agnes-settings-tag')?.textContent).toBe('Unavailable')
  expect(failed.querySelector('.agnes-settings-tag')?.getAttribute('data-tone')).toBe('error')
  expect(failed.querySelector('[data-testid="sandbox-status-unprobed"]')).toBeNull()
})

it('distinguishes requested permissions from measured workspace enforcement', async () => {
  const errors = vi.spyOn(console, 'error')
  const text = (key: string) => settingsCatalog.en[key] ?? key
  const missing = await mount(createElement(SecurityStatusPanel, { status: undefined, t: text }))
  expect(missing.textContent).toContain(text('securityUnavailable'))
  const host = await mount(
    createElement(SecurityStatusPanel, {
      status: {
        platform: { os: 'linux', l1: { level: 'unavailable', scope: [], reason: 'Not probed' } },
        presetPolicies: [
          {
            id: 'review',
            level: 'L1',
            required: true,
            onUnavailable: 'deny',
            approvalPolicy: 'read-only',
            networkMode: 'deny',
          },
          {
            id: 'unrestricted',
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
            preset: 'review',
            provider: 'local',
            state: 'ready',
            enforcement: { level: 'partial', scope: ['file'] },
            policyDigest: 'bound-digest',
          },
          {
            // A retained generation can report another posture for the same session.
            sessionId: 'session-a',
            path: '/synthetic',
            preset: 'unrestricted',
            provider: 'local',
            state: 'unavailable',
          },
          {
            sessionId: 'session-a',
            path: '/synthetic',
            preset: 'unrestricted',
            provider: 'local',
            state: 'ready',
          },
        ],
      },
      t: text,
      view: 'details',
    }),
  )
  expect(host.querySelector('[data-testid="permission-preset-status"]')?.textContent).toContain(
    text('network.unrestricted'),
  )
  const rows = host.querySelectorAll('[data-testid="workspace-sandbox-status"]')
  expect(rows).toHaveLength(3)
  expect(rows[0]?.textContent).toContain(text('noOsIsolation'))
  expect(rows[0]?.textContent).toContain('bound-digest')
  expect(rows[1]?.textContent).toContain(text('unmeasured'))
  expect(rows[1]?.querySelector('[data-testid=workspace-enforcement]')?.textContent).not.toContain(
    text('enforcement.full'),
  )
  expect(rows[2]?.textContent).toContain(text('readiness.ready'))
  expect(errors.mock.calls).toEqual([])
  errors.mockRestore()
})
