/** @vitest-environment happy-dom */

import type { PackageCatalogDescriptor, PackageCatalogPage, SkillImportResult } from '@agnes/protocol'
import { CredentialsApi } from '@agnes/resource-control-web/credentials-api'
import {
  ComputerUseCapability,
  type SettingsComputerUseView,
  SkillDetailContent,
  setAdvancedSettingsShown,
} from '@agnes/web-ui'
import { act, createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelDialogHost } from '../src/pages/channel-dialog.js'
import { closeChannelDialog } from '../src/pages/channel-dialog-state.js'
import { SessionChannelControl } from '../src/pages/channel-session-control.js'
import { ChannelsPanel } from '../src/pages/channels.js'
import type { HomePageData } from '../src/pages/host.js'
import type { PluginView } from '../src/pages/plugins/admin-view.js'
import { ExternalOperationResult } from '../src/pages/plugins/external-operation-result.js'
import { MarketTab } from '../src/pages/plugins/market-tab.js'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { isBusinessAgent, orderInstalled, PluginsTab } from '../src/pages/plugins/plugins-tab.js'
import {
  CAPABILITIES,
  PLUGIN_TABS,
  type PluginPage,
  plainPluginsAddress,
  pluginPage,
  pluginPageId,
  pluginPageTab,
  pluginsRoute,
} from '../src/pages/plugins/route.js'
import { SkillFolders } from '../src/pages/plugins/skill-folders.js'
import { SkillInstallDialog } from '../src/pages/plugins/skill-import.js'

afterEach(() => document.body.replaceChildren())

it('shows session and peer names per connection and reconciles unbind with the same command', async () => {
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  const provider = {
    extension: 'plugin/example',
    manifest: { id: 'example', displayName: 'Example Chat' },
    bindingAvailable: true,
  }
  let bound = true,
    fail = true
  const call = vi.fn(async (method: string) => {
    if (method === 'channels.overview')
      return {
        sessions: [],
        channels: [
          {
            provider,
            configurationRevision: 'revision',
            instances: [
              {
                id: 'bot',
                workspace: 'D:/work',
                agent: 'default',
                version: 7,
                connection: { channel: 'connected', daemon: 'connected' },
                bindings: bound
                  ? [
                      {
                        sessionId: 'current-session',
                        sessionTitle: 'Design review',
                        targetId: 'peer',
                        label: 'Engineering team',
                        state: 'active',
                      },
                    ]
                  : [],
                unavailable: false,
              },
            ],
          },
        ],
      }
    if (fail) {
      fail = false
      throw new Error('lost response')
    }
    bound = false
    return { output: {} }
  })
  const data = {
    call,
    sessionId: () => 'current-session',
    openSettings: vi.fn(),
    startDraft: vi.fn(),
  } as unknown as HomePageData
  await act(async () => root.render(createElement(ChannelsPanel, { data })))
  await vi.waitFor(() => expect(host.textContent).toContain('Design review'))
  expect(host.textContent).toContain('Engineering team')
  expect(host.querySelector('.channel-glyph svg')).not.toBeNull()
  expect(host.querySelector('.channel-glyph img')).toBeNull()
  expect(host.querySelector('a')?.getAttribute('href')).toBe('?session=current-session')
  expect(host.querySelector('input[aria-label="Instance ID"]')).toBeNull()
  const unbind = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Unbind')!
  await act(async () => unbind.click())
  expect(host.textContent).toContain('Unbind unconfirmed')
  await act(async () => unbind.click())
  await vi.waitFor(() => expect(host.textContent).not.toContain('Engineering team'))
  const attempts = call.mock.calls.filter(([method]) => method === '_agnes/v1/extension.call') as unknown as [
    string,
    { commandId: string; sessionId: string; input: unknown },
  ][]
  expect(attempts).toHaveLength(2)
  expect(attempts[0]![1]).toEqual(attempts[1]![1])
  expect(attempts[0]![1]).toMatchObject({
    sessionId: 'current-session',
    input: { instanceId: 'bot', expectedVersion: 7 },
  })
  await act(async () => root.unmount())
})

it('discovers installed channels and configures inside a dialog using immutable session context and native approval', async () => {
  const credentials = vi.spyOn(CredentialsApi.prototype, 'list').mockResolvedValue([])
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  const provider = {
    extension: 'plugin/future',
    revision: 'v1',
    bindingAvailable: true,
    configSchema: { type: 'object', properties: {} },
    manifest: { id: 'future', displayName: 'Future Chat', credentials: { required: [], optional: [] } },
  }
  const requestProfileApproval = vi.fn()
  let approved = false
  let failOverview = false
  const call = vi.fn(async (method: string) => {
    if (method === 'channels.overview' && failOverview) throw new Error('temporary catalog failure')
    if (method === 'channels.overview')
      return {
        sessions: [{ sessionId: 'current', title: 'Release planning', cwd: 'D:/session' }],
        channels: [{ provider, configurationRevision: 'revision', instances: [] }],
      }
    if (method === 'channels.context')
      return {
        sessionId: 'current',
        title: 'Release planning',
        workspace: 'D:/session',
        agent: 'default',
        agentTitle: { en: 'General assistant', 'zh-CN': '通用助手' },
        instanceId: 's-123456abcdef-123456',
      }
    if (method === 'channels.configure')
      return {
        receipt: { state: approved ? 'completed' : 'approval-required' },
        instanceId: 's-123456abcdef-123456',
      }
    return {
      output: {
        instances: [
          {
            id: 's-123456abcdef-123456',
            version: 1,
            connection: { channel: 'connected', daemon: 'connected' },
            targets: [],
            bindings: [{ targetId: 'peer', label: 'Verified chat', state: 'active' }],
          },
        ],
      },
    }
  })
  const data = {
    call,
    requestProfileApproval,
    sessionId: () => 'current',
    openSettings: vi.fn(),
    startDraft: vi.fn(),
  } as unknown as HomePageData
  await act(async () => {
    root.render(createElement(ChannelDialogHost, { data }))
  })
  // The composer lives in another lazy bundle: exercise the shell event, not a module-local store.
  await act(async () => window.dispatchEvent(new CustomEvent('agnes-channel-dialog', { detail: { sessionId: 'current' } })))
  await vi.waitFor(() => expect(host.textContent).toContain('Future Chat'))
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Future Chat'))!
      .click(),
  )
  await vi.waitFor(() => expect(host.textContent).toContain('Release planning'))
  expect(host.textContent).toContain('D:/session')
  expect(host.querySelector('input[aria-label="Instance ID"]')).toBeNull()
  expect(host.querySelector('input[aria-label="Absolute workspace path"]')).toBeNull()
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Connect and continue')!
      .click(),
  )
  expect(requestProfileApproval).toHaveBeenCalledWith({ state: 'approval-required' })
  approved = true
  await act(async () =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === 'Continue connecting')!
      .click(),
  )
  await vi.waitFor(() => expect(host.textContent).toContain('Verified chat'))
  failOverview = true
  await act(async () => window.dispatchEvent(new Event('agnes-channels-changed')))
  await vi.waitFor(() => expect(host.textContent).toContain('Unable to load channels'))
  expect(host.textContent).toContain('Verified chat')
  failOverview = false
  await act(async () => window.dispatchEvent(new Event('agnes-channels-changed')))
  const inputs = call.mock.calls.filter(([method]) => method === 'channels.configure') as unknown as [
    string,
    Record<string, unknown>,
  ][]
  expect(inputs[0]![1]).toEqual(inputs[1]![1])
  expect(inputs[0]![1]).toMatchObject({
    sessionId: 'current',
    instanceId: 's-123456abcdef-123456',
    configurationRevision: 'revision',
  })
  expect(inputs[0]![1]).not.toHaveProperty('workspace')
  expect(inputs[0]![1]).not.toHaveProperty('agent')
  await act(async () => {
    closeChannelDialog()
    root.unmount()
  })
  credentials.mockRestore()
})

it('shows this session’s channel states and opens the exact existing connection for editing', async () => {
  const credentials = vi.spyOn(CredentialsApi.prototype, 'list').mockResolvedValue([{ id: 'secret://generic/token', label: 'Saved token', kind: 'api-key', createdAt: '2026-11-06T00:00:00Z', references: [] }])
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  let bound = true, disconnected = false, fail = false
  const call = vi.fn(async (method: string, input: unknown) => {
    if (method === 'channels.context') return { sessionId: 'current', title: 'Current session', workspace: 'D:/work', agent: 'default', agentTitle: { en: 'General assistant', 'zh-CN': '通用助手' }, instanceId: (input as { instanceId: string }).instanceId }
    if (fail) throw new Error('temporary overview failure')
    return { sessions: [{ sessionId: 'current', title: 'Current session', cwd: 'D:/work' }], channels: ['one', 'two'].map(name => ({
      provider: { extension: 'plugin/' + name, revision: 'one', bindingAvailable: true, manifest: { id: name, displayName: 'Future ' + name, credentials: { required: ['token'], optional: [] } }, configSchema: { type: 'object', properties: { label: { type: 'string', title: 'Bot label' } } } },
      configurationRevision: 'revision', instances: [{ id: 'bot-' + name, workspace: 'D:/work', agent: 'default', credentialRefs: { token: 'secret://generic/token' }, allowFrom: [], requireMention: true, config: { label: 'Saved value' }, version: 1, unavailable: false, connection: { channel: disconnected ? 'closed' : 'connected', daemon: 'connected' }, bindings: bound ? [{ sessionId: 'current', sessionTitle: 'Current session', targetId: 'peer-' + name, label: 'Peer ' + name, state: 'active' }] : [] },
      { id: 'unbound-' + name, intendedSession: { sessionId: 'current' }, bindings: [] }],
    })) }
  })
  const data = { call, sessionId: () => 'current', openSettings: vi.fn(), startDraft: vi.fn() } as unknown as HomePageData
  const render = (sessionId: string | undefined) => createElement('div', null, createElement(SessionChannelControl, { sessionId, data }), createElement(ChannelDialogHost, { data }))
  await act(async () => root.render(render('current')))
  await vi.waitFor(() => expect(host.textContent).toContain('Future one · Connected'))
  expect(host.textContent).toContain('Future two · Connected')
  expect(host.querySelectorAll('[data-testid="composer-channel-binding"]')).toHaveLength(2)
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="composer-channel-binding"]')!.click())
  await vi.waitFor(() => expect(host.querySelector<HTMLInputElement>('input[aria-label="Bot label"]')?.value).toBe('Saved value'))
  expect(host.textContent).toContain('Edit channel connection')
  expect(host.textContent).toContain('Saved token')
  expect(host.textContent).toContain('Save changes')
  expect(host.querySelector('.channel-picker')).toBeNull()
  expect(host.querySelector('.channel-steps')).toBeNull()
  expect(call).toHaveBeenCalledWith('channels.context', { extension: 'plugin/one', sessionId: 'current', instanceId: 'bot-one' })
  await act(async () => closeChannelDialog())
  await act(async () => root.render(render('other')))
  expect(host.querySelector('[data-testid="composer-channel-binding"]')?.textContent).toBe('Channels')
  disconnected = true
  await act(async () => { root.render(render('current')); window.dispatchEvent(new Event('agnes-channels-changed')) })
  await vi.waitFor(() => expect(host.textContent).toContain('Future one · Disconnected'))
  fail = true
  await act(async () => window.dispatchEvent(new Event('agnes-channels-changed')))
  await vi.waitFor(() => expect(host.textContent).toContain('Future one · Status unavailable'))
  fail = false; bound = false
  await act(async () => window.dispatchEvent(new Event('agnes-channels-changed')))
  await vi.waitFor(() => expect(host.querySelector('[data-testid="composer-channel-binding"]')?.textContent).toBe('Channels'))
  await act(async () => root.render(render(undefined)))
  expect(host.textContent).toBe('Channels')
  await act(async () => { closeChannelDialog(); root.unmount() })
  credentials.mockRestore()
})

it.each(['failed', 'skipped'] as const)('shows persisted partial capability results (%s)', (status) => {
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  const activation: NonNullable<SkillImportResult['activation']> = {
    digest: 'a'.repeat(64),
    enable: true,
    expiresAt: '2099-01-01T00:00:00Z',
    environment: [],
    issues: [],
    warnings: [],
    resources: [
      {
        kind: 'mcp',
        resourceId: 'mcp/rea',
        name: 'rea',
        revision: 'b'.repeat(64),
        desired: 'disabled',
        trust: 'untrusted',
      },
      {
        kind: 'skill',
        resourceId: 'skill/companion',
        name: 'CLI companion',
        revision: 'c'.repeat(64),
        desired: 'disabled',
        trust: 'untrusted',
      },
    ],
    outcomes: [
      { resourceId: 'mcp/rea', status, code: 'MCP_LOCAL_ENTRY_MISSING' },
      { resourceId: 'skill/companion', status: 'succeeded' },
    ],
  }
  const t = (key: string, vars: Readonly<Record<string, string | number>> = {}) =>
    Object.entries(vars).reduce(
      (value, [name, item]) => value.replaceAll(`{${name}}`, String(item)),
      pluginsPageCatalog.en[key] ?? key,
    )
  try {
    flushSync(() => root.render(createElement(ExternalOperationResult, { activation, t })))
    expect(host.textContent).toContain('Partially completed')
    expect(host.textContent).toContain('1/2')
    expect(host.textContent).toContain('CLI companion')
    expect(host.textContent).toContain(status === 'failed' ? 'Failed' : 'Skipped')
    expect(host.textContent).toContain('The declared local MCP entry file is missing')
    expect(host.textContent).not.toContain('All 2')
    activation.outcomes![0] = { resourceId: 'mcp/rea', status: 'succeeded' }
    flushSync(() => root.render(createElement(ExternalOperationResult, { activation, t })))
    expect(host.textContent).toContain('All 2')
    expect(host.textContent).not.toContain('MCP_LOCAL_ENTRY_MISSING')
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
})

it('keeps skill folders read-only until the page permits configuration writes', async () => {
  const config = {
    rulesEnabled: true,
    timeEnabled: true,
    timeZone: 'UTC',
    customSkillRoots: ['/synthetic/skills'],
    refreshIntervalMs: 1000,
    maxBytes: 4096,
    maxSourceBytes: 1024,
    instructionFiles: [],
    localInstructionFiles: [],
  }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ config, workspaces: [] }))
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const props = { t: (key: string) => key, onSaved: vi.fn(), canSave: false }
  try {
    flushSync(() => root.render(createElement(SkillFolders, props)))
    const field = () => host.querySelector<HTMLTextAreaElement>('#skill-folders-paths')
    await vi.waitFor(() => expect(field()?.value).toBe('/synthetic/skills'))
    expect(field()?.disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="skill-folders-save"]')?.disabled).toBe(true)
    flushSync(() => root.render(createElement(SkillFolders, { ...props, canSave: true })))
    expect(field()?.disabled).toBe(false)
  } finally {
    flushSync(() => root.unmount())
    fetcher.mockRestore()
  }
})

describe('plugins page route', () => {
  it('reads the tab, and a built-in capability page under the plugins tab', () => {
    expect(pluginsRoute(undefined)).toEqual({ tab: 'plugins' })
    for (const tab of PLUGIN_TABS) expect(pluginsRoute({ tab })).toEqual({ tab })
    for (const capability of CAPABILITIES)
      expect(pluginsRoute({ tab: `plugins.${capability}` })).toEqual({ tab: 'plugins', capability })
  })

  it('lists only the built-ins that are not configured in settings', () => {
    expect(CAPABILITIES).toEqual(['search', 'computer-use', 'subagents'])
  })

  it('sends an old link to a capability that moved into settings to the settings page that holds it', () => {
    expect(pluginsRoute({ tab: 'plugins.execution' })).toEqual({ tab: 'plugins', settings: 'models' })
    expect(pluginsRoute({ tab: 'plugins.memory' })).toEqual({ tab: 'plugins', settings: 'general' })
    expect(pluginsRoute({ tab: 'plugins.context' })).toEqual({ tab: 'plugins', settings: 'general' })
    // Only the old capability ids move; a lookalike from the object prototype does not.
    expect(pluginsRoute({ tab: 'plugins.toString' })).toEqual({ tab: 'plugins' })
  })

  it('falls back to the plugins tab for anything it does not know', () => {
    for (const tab of ['discover', 'plugins.unknown', '', 7, null])
      expect(pluginsRoute({ tab })).toEqual({ tab: 'plugins' })
  })
})

describe('plugins page pushed pages', () => {
  const pages: readonly PluginPage[] = [
    { kind: 'capability', id: 'search' },
    { kind: 'plugin', id: '@agnes/plugin-attachments' },
    { kind: 'market', id: 'fde-crm' },
    { kind: 'skill', id: 'skill:workspace:review' },
    { kind: 'mcp', id: 'github' },
    { kind: 'review', id: 'cand-1' },
    { kind: 'run', id: 'knowledge-qa' },
    { kind: 'add-plugin' },
    { kind: 'install', id: '@agnes-examples/dag-loop' },
    { kind: 'add-mcp' },
    { kind: 'operations' },
    { kind: 'search-engine' },
  ]

  it('names each page by one route segment and reads it back', () => {
    for (const page of pages) expect(pluginPage(pluginPageId(page))).toEqual(page)
    expect(pluginPageId({ kind: 'plugin', id: 'a' })).toBe('plugin:a')
    expect(pluginPageId({ kind: 'add-mcp' })).toBe('add-mcp')
    // A package id keeps its `/`: the address encodes each level on its own.
    expect(pluginPageId({ kind: 'plugin', id: '@agnes/plugin-helper' })).toBe('plugin:@agnes/plugin-helper')
    // An id keeps everything after the first colon, so resource ids with colons survive.
    expect(pluginPage('skill:skill:workspace:review')).toEqual({
      kind: 'skill',
      id: 'skill:workspace:review',
    })
  })

  it('does not name a page for a segment it does not know', () => {
    for (const segment of ['', 'plugin:', ':x', 'unknown:x', 'memory', 'execution', 'toString', 'plugin'])
      expect(pluginPage(segment), segment).toBeUndefined()
  })

  it('keeps each page under the tab it is opened from', () => {
    expect(pages.map((page) => pluginPageTab(page))).toEqual([
      'plugins',
      'plugins',
      'market',
      'skills',
      'mcp',
      'review',
      'skills',
      undefined,
      // A review stays under the tab its check was started from.
      undefined,
      'mcp',
      undefined,
      undefined,
    ])
  })

  it('puts the plain plugins address in place of an old link to a built-in, keeping everything else', () => {
    expect(plainPluginsAddress('http://x/?page=plugins&tab=plugins.search&session=s1#h')).toBe(
      '/?page=plugins&tab=plugins&session=s1#h',
    )
    expect(plainPluginsAddress('http://x/?page=plugins&tab=plugins.search&view=plugin%3Aa')).toBe(
      '/?page=plugins&tab=plugins',
    )
  })
})

describe('plugins page copy', () => {
  it('has the same keys in both languages, and names every tab and capability', () => {
    const en = Object.keys(pluginsPageCatalog.en ?? {}).sort()
    expect(Object.keys(pluginsPageCatalog['zh-CN'] ?? {}).sort()).toEqual(en)
    for (const tab of PLUGIN_TABS) expect(en).toContain(`tab.${tab}`)
    for (const capability of CAPABILITIES)
      for (const part of ['name', 'desc', 'page']) expect(en).toContain(`cap.${capability}.${part}`)
    // What moved into settings leaves no copy behind here.
    for (const prefix of [
      'cap.execution.',
      'cap.memory.',
      'cap.context.',
      'ctx.',
      'exec.',
      'summary.context.',
    ])
      expect(en.filter((key) => key.startsWith(prefix))).toEqual([])
  })
})

describe('plugin grouping', () => {
  const item = (id: string, metadata?: Record<string, unknown>) =>
    ({ id, ...(metadata ? { metadata } : {}) }) as unknown as Parameters<typeof isBusinessAgent>[0]

  it('knows a business agent by its metadata, or by its package scope until the field exists', () => {
    expect(
      isBusinessAgent({
        ...item('@acme/report'),
        agents: [
          {
            ref: 'acme/kit#work',
            launch: { title: { en: 'Work' }, description: { en: 'Work' }, preset: 'safe' },
          },
        ],
      }),
    ).toBe(true)
    expect(isBusinessAgent(item('@agnes-fde/knowledge-qa'))).toBe(false)
    expect(isBusinessAgent(item('@agnes/attachments', { category: 'tools' }))).toBe(false)
  })

  it('lists installed plugins as one run: business agents, then enabled ones, then by name', () => {
    const row = (id: string, desired: string, category: string) =>
      ({
        id,
        desired,
        ...(category === 'business-agent' ? { agents: [{ ref: 'acme/kit#work', launch: {} }] } : {}),
      }) as unknown as Parameters<typeof orderInstalled>[0][number]
    const rows = [
      row('zeta', 'enabled', 'tools'),
      row('beta', 'disabled', 'developer'),
      row('alpha', 'enabled', 'integrations'),
      row('report', 'disabled', 'business-agent'),
      row('audit', 'enabled', 'business-agent'),
    ]
    expect(orderInstalled(rows, (item) => item.id).map((item) => item.id)).toEqual([
      'audit',
      'report',
      'alpha',
      'zeta',
      'beta',
    ])
  })
})

it('groups marketplace releases and opens or installs the selected release', async () => {
  const item: PackageCatalogDescriptor = {
    id: '@example/panel',
    version: '1.0.0',
    source: { type: 'file', ref: 'file:./bundled-examples/showcase/arbitrary-industry' },
    integrity: 'sha256-' + 'a'.repeat(64),
    license: 'MIT',
    contributions: [],
    compatibility: 'supported',
    sourceId: 'local',
    retrievedAt: '2026-10-14T00:00:00Z',
  }
  let chosen: string | undefined
  const view = {
    state: {
      catalog: [
        {
          ...item,
          id: 'developer/teaching',
          source: { type: 'file', ref: 'file:./bundled-examples/fde/knowledge-qa' },
        },
        item,
        { ...item, version: '2.0.0' },
        { ...item, version: '2.0.0' },
        {
          ...item,
          id: 'acme/parent-example',
          metadata: {
            displayName: 'Hidden example',
            summary: 'Example',
            description: 'Example',
            exampleOf: 'acme/parent',
          },
        },
      ],
      installed: [],
      loading: false,
    },
    tab: 'discover',
    query: '',
    kind: '',
    category: '',
    t: (key: string) => key,
    queryRaw: '',
    purposeText: (key: string) => key,
    can: () => true,
    render: () => {},
    settingsText: (key: string) => key,
    canEffect: () => true,
    inspecting: () => false,
    inspectFailure: () => undefined,
    loadCatalog: async () => {},
    setQuery: () => {},
    setKind: () => {},
    setCategory: () => {},
    primaryAction: (row: PackageCatalogDescriptor) => ({
      disabled: false,
      run: () => {
        chosen = row.version
      },
    }),
    selectItem: (row: PackageCatalogDescriptor) => {
      chosen = row.version
    },
  } as unknown as PluginView
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.querySelectorAll('[data-testid="market-card"]')).toHaveLength(1)
    expect(host.textContent).not.toContain('Hidden example')
    const picker = host.querySelector('[data-testid="plugin-version-picker"]')!
    await act(async () =>
      picker.querySelector('input')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    )
    const choices = [...host.querySelectorAll<HTMLElement>('.ant-select-item-option')]
    expect(choices.map((entry) => entry.textContent)).toEqual(['1.0.0', '2.0.0'])
    await act(async () => choices[1]?.click())
    expect(chosen).toBeUndefined()
    expect(host.querySelector('[data-testid="market-card"]')?.getAttribute('data-plugin-version')).toBe(
      '2.0.0',
    )
    host.querySelector<HTMLButtonElement>('.plugins-page-card-title')?.click()
    expect(chosen).toBe('2.0.0')
    chosen = undefined
    host.querySelector<HTMLButtonElement>('[data-testid="market-install"]')?.click()
    expect(chosen).toBe('2.0.0')
  } finally {
    flushSync(() => root.unmount())
  }
})

it.each([true, false])(
  'reviews complete Skill content and cleans up abandoned review (commit=%s)',
  async (commit) => {
    vi.useFakeTimers()
    const prepared = {
      state: 'prepared',
      proposalId: 'skill-install-fixture',
      name: 'fixture',
      digest: 'a'.repeat(64),
      files: ['SKILL.md', 'bin/main.mjs'],
      fileCount: 2,
      environment: [{ name: 'node', evidence: 'probed', state: 'satisfied' }],
    }
    const skillImport = vi
      .fn()
      .mockResolvedValueOnce({ state: 'running', proposalId: 'skill-check-fixture', phase: 'acquiring' })
      .mockResolvedValueOnce(prepared)
      .mockResolvedValueOnce({ ...prepared, state: 'installed' })
    const view = { api: { skillImport } } as unknown as PluginView
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    const button = (text: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === text)
    try {
      flushSync(() =>
        root.render(
          createElement(SkillInstallDialog, {
            view,
            initialSource: 'git:https://github.com/owner/repository.git',
            t: (key) => key,
            onClose: vi.fn(),
          }),
        ),
      )
      await act(async () => undefined)
      expect(skillImport).toHaveBeenLastCalledWith({
        action: 'check',
        source: { type: 'git', ref: 'git:https://github.com/owner/repository.git' },
        scope: 'user',
        enable: false,
      })
      expect(host.textContent).toContain('skill.import.phase.acquiring')
      await act(async () => vi.advanceTimersByTimeAsync(300))
      expect(host.textContent).toContain('skill.import.env.satisfied')
      expect(host.textContent).toContain('skill.import.unverified')
      if (!commit) return
      await act(async () => button('skill.import.confirm')?.click())
      expect(skillImport).toHaveBeenLastCalledWith({
        action: 'commit',
        proposalId: prepared.proposalId,
        expectedDigest: prepared.digest,
      })
      expect(host.textContent).toContain('skill.import.state.installed')
      expect(button('skill.import.confirm')).toBeUndefined()
    } finally {
      flushSync(() => root.unmount())
      host.remove()
      vi.useRealTimers()
      if (!commit)
        expect(skillImport).toHaveBeenLastCalledWith({ action: 'cancel', proposalId: prepared.proposalId })
    }
  },
)

it('cancels a late check response when its installation window has already closed', async () => {
  let finish: (value: { state: 'running'; proposalId: string; phase: string }) => void = () => undefined
  const check = new Promise<{ state: 'running'; proposalId: string; phase: string }>((resolve) => {
    finish = resolve
  })
  const skillImport = vi.fn().mockReturnValueOnce(check).mockResolvedValue({ state: 'cancelled' })
  const view = { api: { skillImport } } as unknown as PluginView
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      createElement(SkillInstallDialog, {
        view,
        initialSource: 'git:https://github.com/owner/repository.git',
        t: (key) => key,
        onClose: vi.fn(),
      }),
    ),
  )
  flushSync(() => root.unmount())
  await act(async () => {
    finish({ state: 'running', proposalId: 'skill-check-late', phase: 'acquiring' })
  })
  expect(skillImport).toHaveBeenLastCalledWith({ action: 'cancel', proposalId: 'skill-check-late' })
  host.remove()
})

it('reviews MCP connections and commits only explicitly selected Skills and connection tests', async () => {
  const prepared = {
    state: 'prepared',
    kind: 'mcp',
    proposalId: 'mcp-import-fixture',
    digest: 'a'.repeat(64),
    mcp: {
      servers: [
        {
          serverId: 'sample',
          transport: 'stdio',
          sandboxProfile: 'strict',
          command: 'node',
          args: ['server.mjs'],
          state: 'planned',
          selected: false,
        },
      ],
      skills: [{ path: '.agents/skills/companion', name: 'companion', state: 'prepared', fileCount: 2 }],
      requiredCredentials: [],
      configurationFiles: ['.mcp.json'],
      issues: [],
    },
  }
  const skillImport = vi
    .fn()
    .mockResolvedValueOnce(prepared)
    .mockResolvedValueOnce({ ...prepared, state: 'cancelled' })
    .mockResolvedValueOnce({
      ...prepared,
      mcp: {
        ...prepared.mcp,
        servers: prepared.mcp.servers.map((server) => ({ ...server, selected: true })),
      },
    })
    .mockResolvedValueOnce({ ...prepared, state: 'installed' })
  const view = { api: { skillImport }, canEffect: () => true } as unknown as PluginView
  const host = document.body.appendChild(document.createElement('div')),
    root = createRoot(host)
  try {
    flushSync(() =>
      root.render(
        createElement(SkillInstallDialog, {
          view,
          initialSource: 'git:https://github.com/example/mcp.git',
          t: (key) => key,
          onClose: vi.fn(),
        }),
      ),
    )
    await act(async () => undefined)
    expect(host.textContent).toContain('mcp.import.connections')
    const choices = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    expect(choices).toHaveLength(2)
    expect(choices[0]?.checked).toBe(false)
    expect(choices[1]?.checked).toBe(true)
    await act(async () => {
      choices[0]?.click()
    })
    const apply = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'mcp.import.configure',
    )
    await act(async () => apply?.click())
    expect(skillImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'check', mcpServers: ['sample'] }),
    )
    const reviewedChoices = host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
    expect(reviewedChoices).toHaveLength(3)
    expect(reviewedChoices[0]?.checked).toBe(true)
    expect(reviewedChoices[1]?.checked).toBe(true)
    await act(async () => reviewedChoices[2]?.click())
    const confirm = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'skill.import.confirm',
    )
    await act(async () => confirm?.click())
    expect(skillImport).toHaveBeenLastCalledWith({
      action: 'commit',
      proposalId: prepared.proposalId,
      expectedDigest: prepared.digest,
      skillDirectories: ['.agents/skills/companion'],
      mcpServers: ['sample'],
      testConnection: true,
    })
    expect(host.textContent).toContain('mcp.import.state.installed')
  } finally {
    flushSync(() => root.unmount())
    host.remove()
  }
})

it('merges community cards into one gallery and opens complete details without remote requests', async () => {
  const topics = ['agh-plugin', ...Array.from({ length: 19 }, (_, i) => `topic-${i}`)]
  const community: NonNullable<PackageCatalogPage['community']> = {
    state: 'ready',
    error: null,
    totalReported: 30,
    lastSuccessAt: new Date().toISOString(),
    nextAttemptAt: null,
    items: Array.from({ length: 13 }, (_, id) => ({
      id: id + 1,
      fullName: `author/repo-${id}`,
      description: '<script>not markup</script>',
      topics,
      ecosystem: id === 0 ? 'dsh' : 'agh',
      stars: 100 - id,
      forks: 2,
      issues: 3,
      language: 'TypeScript',
      license: 'MIT',
      pushedAt: null,
    })),
  }
  const fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external fetch expected'))
  const catalog = vi.fn(async () => ({ items: [], nextCursor: null, community }))
  const inspect = vi.fn()
  const view = {
    state: {
      community,
      catalog: [
        {
          id: '@example/official',
          version: '1.0.0',
          source: { type: 'file', ref: 'file:./official' },
          sourceId: 'builtin-plugins',
          integrity: `sha256-${'a'.repeat(64)}`,
          license: 'MIT',
          contributions: [],
          compatibility: 'supported',
          retrievedAt: new Date().toISOString(),
        },
      ],
      installed: [],
      loading: false,
    },
    api: { catalog },
    refreshCommunity: catalog,
    tab: 'discover',
    query: '',
    queryRaw: '',
    kind: '',
    t: (key: string) => key,
    purposeText: (key: string) => key,
    can: () => true,
    canEffect: () => true,
    inspecting: () => false,
    inspectFailure: () => undefined,
    primaryAction: () => ({ disabled: false, run: () => undefined }),
    loadCatalog: vi.fn(),
    inspect,
  } as unknown as PluginView
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.querySelectorAll('[data-testid="market-list"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="market-card"]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-testid="community-card"]')).toHaveLength(11)
    expect(host.querySelectorAll('.community-market-topics a')).toHaveLength(0)
    expect(host.textContent).not.toContain('community.coverage')
    expect(host.textContent).not.toContain('community.updated')
    const source = host.querySelector<HTMLSelectElement>('.plugin-source-filter select')!
    await act(async () => {
      source.value = 'community'
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.querySelectorAll('[data-testid="community-card"]')).toHaveLength(12)
    expect(host.querySelectorAll('[data-testid="market-card"]')).toHaveLength(0)
    expect(host.querySelector('.community-market-card p')?.textContent).toBe('<script>not markup</script>')
    expect(host.querySelector('script')).toBeNull()
    const views = host.querySelectorAll<HTMLButtonElement>('[data-testid="community-view"]')
    await act(async () => views[0]?.click())
    const details = () => document.querySelector('[data-testid="community-details"]')
    await vi.waitFor(() => expect(details()).not.toBeNull())
    expect(details()?.querySelectorAll('.community-market-topics a')).toHaveLength(20)
    expect(details()?.textContent).toContain('<script>not markup</script>')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('community.reviewRequired')
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="community.close"]')?.click(),
    )
    await vi.waitFor(() => expect(details()).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(views[0]))
    await act(async () => views[1]?.click())
    const check = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'community.check',
    )
    await act(async () => check?.click())
    expect(inspect).toHaveBeenCalledWith(
      { type: 'git', ref: 'git:https://github.com/author/repo-1.git' },
      'install',
      check,
    )
    const next = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'market.more',
    )!
    await act(async () => next.click())
    expect(host.querySelectorAll('[data-testid="community-card"]')).toHaveLength(13)
    view.query = 'repo-5'
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.querySelectorAll('[data-testid="community-card"]')).toHaveLength(1)
    expect(host.textContent).toContain('author/repo-5')
    view.query = 'no-match'
    view.state.community = { ...community, state: 'syncing' }
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.textContent).toContain('market.none')
    expect(host.textContent).not.toContain('market.loading')
    view.state.community = { ...community, items: [], state: 'syncing' }
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.textContent).toContain('market.none')
    view.state.community = { ...community, items: [], state: 'pending', lastSuccessAt: null }
    flushSync(() => root.render(createElement(MarketTab, { view, t: (key) => key })))
    expect(host.textContent).toContain('market.loading')
    expect(fetcher).not.toHaveBeenCalled()
    expect(catalog).not.toHaveBeenCalled()
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(catalog).toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    flushSync(() => root.unmount())
    fetcher.mockRestore()
  }
})

describe('computer use capability', () => {
  const view = (attention: SettingsComputerUseView['attention']): SettingsComputerUseView => ({
    status: { label: 'Available', summary: 'macOS driver ready.', runtime: '', blockers: [] },
    permissions: { label: 'Granted', summary: 'All granted.', grantHidden: !attention?.permissions },
    doctor: { label: 'Passed', summary: 'Healthy.' },
    operation: { label: 'No record', summary: 'Nothing running.' },
    ...(attention ? { attention } : {}),
    controls: {
      refreshDisabled: false,
      grantDisabled: false,
      doctorDisabled: false,
      installDisabled: true,
      updateDisabled: false,
      restartDisabled: false,
      operationRefreshDisabled: false,
      cancelDisabled: true,
      cancelHidden: true,
    },
  })
  const actions = {
    refresh: vi.fn(async () => {}),
    grantPermissions: vi.fn(async () => {}),
    doctor: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    refreshOperation: vi.fn(async () => {}),
    cancelOperation: vi.fn(async () => {}),
  }
  function render(value: SettingsComputerUseView) {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    flushSync(() => root.render(createElement(ComputerUseCapability, { view: value, actions })))
    return host
  }
  const expanded = (host: HTMLElement) =>
    host.querySelector('[data-testid="computer-use-more-toggle"]')?.getAttribute('aria-expanded')

  it('is one calm line while everything works', () => {
    const host = render(view({ status: false, permissions: false, doctor: false, operation: false }))
    expect(
      host.querySelector('[data-testid="computer-use-capability"]')?.getAttribute('data-attention'),
    ).toBe('false')
    expect(expanded(host)).toBe('false')
    expect(host.querySelector('[data-testid="computer-use-permission-grant"]')).toBeNull()
  })

  it('opens the details and offers the step when a permission is missing', () => {
    const host = render(view({ status: false, permissions: true, doctor: false, operation: false }))
    expect(expanded(host)).toBe('true')
    host.querySelector<HTMLElement>('[data-testid="computer-use-permission-grant"]')?.click()
    expect(actions.grantPermissions).toHaveBeenCalledTimes(1)
  })
})

describe('skill detail', () => {
  const skill = {
    kind: 'skill',
    resourceId: 'skill:weekly',
    name: 'weekly-report',
    description: 'Writes the weekly report.',
    priority: 100,
    revision: 'skill-row:v1:abc',
    stale: false,
    sourceIdentity: { scope: 'workspace', rootKey: 'workspace-agnes', sourceId: 's1' },
    resolution: { winner: true, shadowed: [] },
  } as unknown as Parameters<typeof SkillDetailContent>[0]['skill']
  function render() {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    flushSync(() =>
      root.render(
        createElement(SkillDetailContent, {
          skill,
          disabled: false,
          actions: [],
          onAction: () => {},
          onPrioritySave: () => {},
          onClose: () => {},
        }),
      ),
    )
    return host
  }
  // Advanced settings are on unless the reader turned them off.
  beforeEach(() => setAdvancedSettingsShown(false))
  afterEach(() => setAdvancedSettingsShown(false))

  it('shows what the skill is and where it comes from, without priority or identifiers', () => {
    const host = render()
    expect(host.textContent).toContain('Workspace skills folder')
    expect(host.querySelector('[data-testid="skill-advanced"]')).toBeNull()
    expect(host.textContent).not.toContain('skill-row:v1:abc')
  })

  it('adds name priority and technical details once advanced settings are shown', () => {
    setAdvancedSettingsShown(true)
    const host = render()
    expect(host.querySelector('[data-testid="skill-advanced"]')).not.toBeNull()
    expect(host.textContent).toContain('Priority 100')
    expect(host.textContent).toContain('skill-row:v1:abc')
  })
})

it('keeps all plugins in a single list with the bundled helper enable toggle', () => {
  const row = (id: string, category: string, exampleOf?: string) => ({
    id,
    version: '1.0.0',
    ...(category === 'business-agent' ? { agents: [{ ref: 'acme/kit#work', launch: {} }] } : {}),
    source: {
      type: 'file',
      ref: `file:./${id === '@agnes/plugin-helper' ? 'bundled-plugins/plugin-helper' : 'examples/plugin'}`,
    },
    presentation: { origin: id === '@agnes/plugin-helper' ? 'official' : 'example', rows: [] },
    trusted: true,
    desired: 'enabled',
    actual: 'running',
    blockers: [],
    contributions: [],
    metadata: {
      displayName: id,
      summary: id,
      description: id,
      ...(exampleOf ? { exampleOf } : {}),
    },
  })
  const rows = [
    row('@agnes/plugin-helper', 'developer'),
    row('acme/example', 'example', '@agnes/plugin-helper'),
    row('@agnes-fde/support-triage', 'business-agent'),
  ]
  const toggle = vi.fn(async () => {})
  const view = {
    state: {
      installed: rows,
      loading: false,
      inventoryAuthoritative: true,
      operations: new Map(),
      externalPackages: [
        {
          id: 'mcp-import-00000000-0000-4000-8000-000000000000',
          name: 'sample/mcp-kit',
          source: { type: 'git', ref: 'git:https://github.com/sample/mcp-kit.git#fixed' },
          result: { kind: 'mcp', state: 'installed' },
          resources: [
            { kind: 'mcp', resourceId: 'mcp/sample', name: 'sample', state: 'present' },
            { kind: 'skill', resourceId: 'skill/user/companion', name: 'companion', state: 'present' },
          ],
        },
      ],
    },
    filteredInstalled: () => rows,
    locale: { getSnapshot: () => 'en' },
    query: '',
    queryRaw: '',
    kind: '',
    category: '',
    t: (key: string) => key,
    purposeText: (key: string) => key,
    settingsText: (key: string) => key,
    can: () => true,
    canEffect: () => true,
    detailActions: () => [],
    surfaceLinks: () => [],
    packageBusy: () => false,
    runtimeState: () => undefined,
    presentationOf: () => undefined,
    primaryAction: () => ({ label: 'Review', disabled: false, run: async () => {} }),
    confirmDisable: toggle,
    render: () => {},
  } as unknown as PluginView
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(PluginsTab, { view, t: (key) => key, summaries: {} })))
    const builtin = host.querySelector('[data-testid="plugin-browser"]')!
    expect(host.querySelector('[data-testid="plugin-builtin"]')).toBeNull()
    expect(builtin.textContent).toContain('@agnes/plugin-helper')
    expect(host.querySelector('[data-testid="plugin-browser"]')?.textContent).toContain(
      '@agnes-fde/support-triage',
    )
    expect(host.querySelector('[data-plugin-id="acme/example"]')).not.toBeNull()
    expect(builtin.querySelector('[data-testid="external-plugin-row"]')?.textContent).toContain(
      'sample/mcp-kit',
    )
    expect(
      builtin
        .querySelector('[data-testid="external-plugin-row"] button[role="switch"]')
        ?.getAttribute('aria-checked'),
    ).toBe('false')
    expect(builtin.querySelector('[data-testid="external-plugin-row"] .plugin-row-actions')).not.toBeNull()
    const sourceFilter = host.querySelector<HTMLSelectElement>('select[aria-label="source.label"]')
    if (!sourceFilter) throw new Error('source filter missing')
    flushSync(() => {
      sourceFilter.value = 'official'
      sourceFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(
      [...host.querySelectorAll('[data-plugin-id]')].map((row) => row.getAttribute('data-plugin-id')),
    ).toEqual(['@agnes/plugin-helper'])
    flushSync(() => {
      sourceFilter.value = 'local'
      sourceFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.querySelectorAll('[data-plugin-id]')).toHaveLength(2)
    flushSync(() => {
      sourceFilter.value = ''
      sourceFilter.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const enable = builtin.querySelector<HTMLButtonElement>(
      '[data-plugin-id="@agnes/plugin-helper"] button[role="switch"]',
    )!
    expect(enable).not.toBeNull()
    expect(enable.disabled).toBe(false)
    enable.click()
    expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ id: '@agnes/plugin-helper' }))
    view.query = 'companion'
    flushSync(() => root.render(createElement(PluginsTab, { view, t: (key) => key, summaries: {} })))
    expect(host.querySelector('[data-testid="external-plugin-row"]')).not.toBeNull()
    view.query = 'no-such-plugin'
    flushSync(() => root.render(createElement(PluginsTab, { view, t: (key) => key, summaries: {} })))
    expect(host.querySelector('[data-testid="external-plugin-row"]')).toBeNull()
  } finally {
    flushSync(() => root.unmount())
  }
})

it('filters a single inventory by provenance source and declared capabilities independently of registered evidence', async () => {
  const { matchesPluginFilters, pluginSource } = await import('../src/pages/plugins/plugins-tab.js')
  const base = {
    id: '@agnes-fde/misleading-name',
    source: { type: 'npm', ref: 'npm:community-kit' },
    provides: ['tool'],
    contributions: [],
    provenance: {
      source: { type: 'npm', ref: 'npm:community-kit' },
      integrity: 'sha256-test',
      signatureVerified: false,
      verification: 'unverified',
    },
  } as unknown as import('@agnes/protocol').PackageInstalledDescriptor
  const provenance = base.provenance
  if (!provenance) throw new Error('provenance fixture missing')
  expect(pluginSource(base)).toBe('community')
  expect(pluginSource({ ...base, presentation: { origin: 'official', rows: [] } })).toBe('community')
  expect(
    pluginSource({
      ...base,
      provenance: { ...provenance, source: { type: 'file', ref: 'file:./local' } },
    }),
  ).toBe('local')
  expect(
    pluginSource({
      ...base,
      provenance: { ...provenance, verification: 'official-ed25519', signatureVerified: true },
    }),
  ).toBe('official')
  expect(matchesPluginFilters(base, 'community', 'tool')).toBe(true)
  expect(matchesPluginFilters(base, 'official', 'tool')).toBe(false)
  expect(matchesPluginFilters(base, 'community', 'loop')).toBe(false)
})

it('coalesces pending-review reads and rejects a response invalidated in flight', async () => {
  const { PluginAdminApi } = await import('@agnes/web-admin/admin/plugins/api')
  const { PluginsPage } = await import('../src/pages/plugins-page.js')
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}))
  const adminContext = {
    profile: 'synthetic',
    clientId: 'web',
    permissions: ['packages.read' as const],
    readOnly: false,
  }
  vi.spyOn(PluginAdminApi, 'context').mockResolvedValue(adminContext)
  vi.spyOn(PluginAdminApi, 'overview').mockResolvedValue({
    context: adminContext,
    inventory: { packages: [] },
  })
  vi.spyOn(PluginAdminApi.prototype, 'list').mockResolvedValue({ packages: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'treeList').mockResolvedValue({ nodes: [] } as never)
  vi.spyOn(PluginAdminApi.prototype, 'surfaceLinks').mockResolvedValue({ surfaces: [] })
  vi.spyOn(PluginAdminApi.prototype, 'runtime').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'composition').mockRejectedValue(new Error('optional'))
  vi.spyOn(PluginAdminApi.prototype, 'catalog').mockResolvedValue({ items: [], nextCursor: null })
  const pins = vi.spyOn(PluginAdminApi.prototype, 'pinsInspect').mockRejectedValue(new Error('forbidden'))
  let hidden = false
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (hidden ? 'hidden' : 'visible'))
  const reads: ((value: unknown) => void)[] = []
  const failures: ((reason: Error) => void)[] = []
  vi.spyOn(PluginAdminApi.prototype, 'candidatesList').mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        reads.push(resolve as (value: unknown) => void)
        failures.push(reject)
      }),
  )
  for (const id of ['plugin-detail', 'source-dialog', 'plugin-confirm']) {
    const dialog = document.createElement('dialog')
    dialog.id = id
    document.body.append(dialog)
  }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const context = {
    t: (key: string) => key,
    data: { call: async () => ({}), sessionId: () => undefined, openSettings() {}, startDraft() {} },
  }
  const badge = () => host.querySelector('[data-testid="plugins-tab-review"]')?.textContent
  try {
    await act(async () => root.render(createElement(PluginsPage, { context })))
    await vi.waitFor(() => expect(reads.length).toBe(1))
    await act(async () => reads[0]?.({ candidates: [] }))
    expect(pins).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="plugin-held-versions"]')).toBeNull()
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(reads).toHaveLength(1)
    await act(async () => window.dispatchEvent(new Event('agnes:candidates-changed')))
    await vi.waitFor(() => expect(reads.length).toBe(2))
    await act(async () => window.dispatchEvent(new Event('agnes:candidate-count-changed')))
    // True invalidations are queued, never read in parallel or accepted as an older snapshot.
    expect(reads).toHaveLength(2)
    await act(async () => reads[1]?.({ candidates: [{ state: 'review' }] }))
    expect(badge()).not.toContain('1')
    await vi.waitFor(() => expect(reads).toHaveLength(3))
    await act(async () => reads[2]?.({ candidates: [{ state: 'review' }, { state: 'review' }] }))
    await vi.waitFor(() => expect(badge()).toContain('2'))
    await act(async () => window.dispatchEvent(new Event('agnes:candidates-changed')))
    expect(reads).toHaveLength(4)
    await act(async () => failures[3]?.(new Error('unavailable')))
    expect(badge()).toContain('2')
    hidden = true
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('agnes:candidates-changed'))
    })
    expect(reads).toHaveLength(4)
    hidden = false
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(reads).toHaveLength(5)
    await act(async () => reads[4]?.({ candidates: [{ state: 'review' }] }))
    expect(badge()).toContain('1')
  } finally {
    await act(async () => root.unmount())
    fetcher.mockRestore()
    vi.restoreAllMocks()
  }
})
