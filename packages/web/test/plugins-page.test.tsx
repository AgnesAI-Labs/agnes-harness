/** @vitest-environment happy-dom */
import {
  ComputerUseCapability,
  type SettingsComputerUseView,
  SkillDetailContent,
  setAdvancedSettingsShown,
} from '@agnes/web-ui'
import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pluginsPageCatalog } from '../src/pages/plugins/page-locale.js'
import { isBusinessAgent, isExperimental } from '../src/pages/plugins/plugins-tab.js'
import { CAPABILITIES, PLUGIN_TABS, pluginsRoute } from '../src/pages/plugins/route.js'

afterEach(() => document.body.replaceChildren())

describe('plugins page route', () => {
  it('reads the tab, and a built-in capability page under the plugins tab', () => {
    expect(pluginsRoute(undefined)).toEqual({ tab: 'plugins' })
    for (const tab of PLUGIN_TABS) expect(pluginsRoute({ tab })).toEqual({ tab })
    for (const capability of CAPABILITIES)
      expect(pluginsRoute({ tab: `plugins.${capability}` })).toEqual({ tab: 'plugins', capability })
  })

  it('falls back to the plugins tab for anything it does not know', () => {
    for (const tab of ['discover', 'plugins.unknown', '', 7, null])
      expect(pluginsRoute({ tab })).toEqual({ tab: 'plugins' })
  })
})

describe('plugins page copy', () => {
  it('has the same keys in both languages, and names every tab and capability', () => {
    const en = Object.keys(pluginsPageCatalog.en ?? {}).sort()
    expect(Object.keys(pluginsPageCatalog['zh-CN'] ?? {}).sort()).toEqual(en)
    for (const tab of PLUGIN_TABS) expect(en).toContain(`tab.${tab}`)
    for (const capability of CAPABILITIES)
      for (const part of ['name', 'desc', 'page']) expect(en).toContain(`cap.${capability}.${part}`)
  })
})

describe('plugin grouping', () => {
  const item = (id: string, metadata?: Record<string, unknown>) =>
    ({ id, ...(metadata ? { metadata } : {}) }) as unknown as Parameters<typeof isBusinessAgent>[0]

  it('knows a business agent by its metadata, or by its package scope until the field exists', () => {
    expect(isBusinessAgent(item('@acme/report', { category: 'business-agent' }))).toBe(true)
    expect(isBusinessAgent(item('@agnes-fde/code-review'))).toBe(true)
    expect(isBusinessAgent(item('@agnes/attachments', { category: 'tools' }))).toBe(false)
  })

  it('treats a plugin as experimental only when its metadata says so', () => {
    expect(isExperimental(item('a', { experimental: true }))).toBe(true)
    expect(isExperimental(item('a', { experimental: 'yes' }))).toBe(false)
    expect(isExperimental(item('a'))).toBe(false)
  })
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
