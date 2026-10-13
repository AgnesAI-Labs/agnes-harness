/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import { ADVANCED_SETTINGS_STORAGE_KEY, advancedSettingsShown, setAdvancedSettingsShown } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Conversation,
  type ConversationChildContainers,
  createAdminPaneStore,
  EMPTY_SIDEBAR_STATE,
  SettingsBuiltin,
  type SettingsPane,
  SettingsPaneBuiltin,
  Sidebar,
} from '../src/index.js'
import type { SettingsNavigationEntry, SettingsRegionHandle } from '../src/settings.js'

const roots: Root[] = []
const englishText: Record<string, string> = {
  'settings-shell.appearanceTitle': 'General',
  'settings-shell.fontScale': 'Font size',
  'shell.install': 'Install from source',
  'button.refresh': 'Refresh Skill catalog',
  'shell.list.aria': 'Resource catalog',
  // 语言切换的三条文案由 web 包的 locale-catalog 提供，这里补进桩以便断言它确实渲染出来。
  'settings.appearance.language': 'Language',
  'settings.appearance.language.en': 'English',
  'settings.appearance.language.en.hint': 'Show the workbench in English',
  'settings.appearance.language.zh-CN': '简体中文',
  'settings.appearance.language.zh-CN.hint': 'Show the workbench in Simplified Chinese',
}
const enT = (key: string): string => englishText[key] ?? key

afterEach(() => {
  while (roots.length) roots.pop()?.unmount()
  document.body.replaceChildren()
  document.documentElement.lang = 'en'
  setAdvancedSettingsShown(false)
})

describe('independent core web-unit implementations', () => {
  it('mounts the model settings body and account dialog as React-owned surfaces', () => {
    const host = document.createElement('dialog')
    host.id = 'config'
    document.body.append(host)
    const shell = createRoot(host)
    roots.push(shell)
    flushSync(() => shell.render(createElement(SettingsBuiltin, { options: { translate: enT } })))
    const paneSlot = host.querySelector<HTMLElement>('#settings-pane-slot-model')
    if (!paneSlot) throw new Error('model settings slot is missing')
    const pane = createRoot(paneSlot)
    roots.push(pane)
    flushSync(() => pane.render(createElement(SettingsPaneBuiltin, { pane: 'model' })))

    expect(host.querySelector('#config-form')).toBeInstanceOf(HTMLFormElement)
    expect(host.querySelector('#model-settings-pane')).toBeTruthy()
    expect(host.querySelector('#config-accounts')).toBeTruthy()
    expect(host.querySelector('#settings-dsh-slot-settings-models-provider-card')).toBeTruthy()
    expect(host.querySelector('#account-dialog')).toBeInstanceOf(HTMLDialogElement)
    expect(host.querySelector('#config-provider')).toBeInstanceOf(HTMLSelectElement)
    expect(host.querySelector('#config-save')).toBeInstanceOf(HTMLButtonElement)
    expect(host.querySelector('#config-save')?.getAttribute('form')).toBe('config-form')
  })

  it('renders the admin pane load state on its navigation controls, list and notice', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const adminPanes = createAdminPaneStore(flushSync)
    flushSync(() => root.render(createElement(SettingsBuiltin, { options: { adminPanes } })))
    for (const pane of ['plugin', 'resources'] as const) {
      const slot = host.querySelector<HTMLElement>(`#settings-pane-slot-${pane}`)
      if (!slot) throw new Error('Missing settings pane slot')
      const paneRoot = createRoot(slot)
      roots.push(paneRoot)
      flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane, adminPanes })))
    }
    const control = (id: string) => host.querySelector<HTMLButtonElement>(`#${id}`) as HTMLButtonElement
    const list = host.querySelector<HTMLElement>('#resource-list') as HTMLElement
    const toolbar = host.querySelector<HTMLElement>('.resource-toolbar') as HTMLElement
    const notice = host.querySelector<HTMLElement>('#resource-notice') as HTMLElement
    expect(control('skills-tab').getAttribute('aria-selected')).toBe('true')
    expect(list.hidden).toBe(false)
    expect(notice.hasAttribute('data-kind')).toBe(false)

    adminPanes.begin('resources', 'mcp')
    expect(control('mcp-tab').getAttribute('aria-selected')).toBe('true')
    expect(control('mcp-tab').tabIndex).toBe(0)
    expect(control('mcp-tab').getAttribute('aria-busy')).toBe('true')
    expect(control('mcp-tab').disabled).toBe(false)
    expect(control('skills-tab').getAttribute('aria-selected')).toBe('false')
    expect(control('skills-tab').tabIndex).toBe(-1)
    expect(control('skills-tab').hasAttribute('aria-busy')).toBe(false)
    expect(list.hidden).toBe(true)
    expect(toolbar.hidden).toBe(true)

    adminPanes.fail('resources', 'Could not open')
    adminPanes.settle('resources', false)
    expect(notice.textContent).toBe('Could not open')
    expect(notice.dataset.kind).toBe('error')
    expect(control('mcp-tab').hasAttribute('aria-busy')).toBe(false)
    expect(list.hidden).toBe(true)

    // The pane's own controller reports into the same line; the next open still clears it.
    notice.textContent = 'Saved'
    adminPanes.begin('resources', 'mcp')
    adminPanes.clearNotice('resources')
    adminPanes.settle('resources', true)
    expect(notice.textContent).toBe('')
    expect(notice.dataset.kind).toBe('')
    expect(list.hidden).toBe(false)
    expect(toolbar.hidden).toBe(false)

    adminPanes.begin('plugin')
    expect(control('plugin-management').disabled).toBe(true)
    expect(control('plugin-management').getAttribute('aria-busy')).toBe('true')
    adminPanes.settle('plugin', true)
    expect(control('plugin-management').disabled).toBe(false)
    expect(control('plugin-management').hasAttribute('aria-busy')).toBe(false)
  })

  it('keeps one rail entry per everyday group, routes tabs by keyboard and removes disposed sections', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const region = createRef<SettingsRegionHandle>()
    let entries: SettingsNavigationEntry[] = [
      {
        id: 'model',
        group: 'accounts',
        titleKey: 'account',
        groupTitleKey: 'accounts',
        icon: 'accounts',
        order: 0,
        nativePane: 'model',
        navigationId: 'model-settings',
      },
      {
        id: 'first',
        group: 'security',
        titleKey: 'first',
        groupTitleKey: 'security',
        icon: 'security',
        order: 10,
      },
      {
        id: 'second',
        group: 'security',
        titleKey: 'second',
        groupTitleKey: 'security',
        icon: 'security',
        order: 11,
      },
      // Pages that moved out of settings stay registered until their new home replaces them.
      {
        id: 'skills',
        group: 'tools',
        titleKey: 'skills',
        groupTitleKey: 'tools',
        icon: 'tools',
        order: 20,
        nativePane: 'resources',
        navigationId: 'skills-tab',
      },
      {
        id: 'mcp',
        group: 'tools',
        titleKey: 'mcp',
        groupTitleKey: 'tools',
        icon: 'tools',
        order: 21,
        nativePane: 'resources',
        navigationId: 'mcp-tab',
      },
    ]
    const changed = new Set<() => void>()
    flushSync(() =>
      root.render(
        createElement(SettingsBuiltin, {
          ref: region,
          options: {
            translate: (key) => key,
            sectionPages: createElement('p', { id: 'section-pages' }),
            sections: {
              entries: () => [...entries],
              subscribe: (listener) => {
                changed.add(listener)
                return () => {
                  changed.delete(listener)
                }
              },
            },
          },
        }),
      ),
    )
    for (const pane of ['model', 'plugin', 'resources'] as const) {
      const slot = host.querySelector<HTMLElement>(`#settings-pane-slot-${pane}`)
      if (!slot) throw new Error('Missing settings pane slot')
      const paneRoot = createRoot(slot)
      roots.push(paneRoot)
      flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane })))
    }
    const nav = () => host.querySelectorAll('.settings-nav-group button[data-settings-group]')
    // Models, and one entry for the two security pages; the moved pages are not listed.
    expect(nav()).toHaveLength(2)
    expect(host.querySelector('#settings-search')).toBeNull()
    expect(host.querySelector('[data-testid="settings-nav-skills"]')).toBeNull()
    const sections = () => host.querySelector<HTMLElement>('#settings-sections-pane')
    expect(sections()?.hidden).toBe(true)
    expect(sections()?.querySelector('#section-pages')).toBeTruthy()
    host.querySelector<HTMLButtonElement>('[data-settings-section="first"]')?.click()
    // A section without a native pane shows in the dialog's own host, not in the plugin pane.
    expect(sections()?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('#model-settings-pane')?.hidden).toBe(true)
    expect(host.querySelector<HTMLElement>('#plugin-settings-pane')?.hidden).toBe(true)
    host
      .querySelector<HTMLButtonElement>('[role="tab"][data-settings-section="first"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('second')
    expect(host.querySelector('#config-form')?.getAttribute('data-settings-section')).toBe('second')
    expect(new URL(location.href).searchParams.get('settings')).toBe('second')
    const nativeControl = host.querySelector('#model-settings')
    const tabControl = host.querySelector('#settings-section-tab-second')
    const content = host.querySelector('#settings-content-slots')
    expect(content?.parentElement?.id).toBe('config-form')
    expect(host.querySelector('#settings-pane-slots')?.parentElement).toBe(content)
    expect(host.querySelector('#settings-dsh-shell-slots')?.parentElement).toBe(content)
    expect(host.querySelector('#settings-section-tabs')?.parentElement).toBe(content)
    expect(sections()?.parentElement).toBe(content)
    const outlets = [...host.querySelectorAll('[data-agnes-dsh-slot]')]
    for (const listener of changed) listener()
    expect(host.querySelector('#model-settings')).toBe(nativeControl)
    for (const outlet of outlets) expect(host.contains(outlet)).toBe(true)
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('second')
    expect(document.activeElement?.getAttribute('role')).toBe('tab')
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'second', bubbles: true }))
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('second')
    expect(document.activeElement?.getAttribute('role')).toBe('tab')
    const field = document.createElement('input')
    sections()?.append(field)
    field.focus()
    for (const listener of changed) listener()
    expect(document.activeElement).toBe(field)
    // A moved page still opens when something asks for it by name; its siblings are its tabs.
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'skills', bubbles: true }))
    expect(host.querySelector('#resource-settings-pane')?.hasAttribute('hidden')).toBe(false)
    expect(sections()?.hidden).toBe(true)
    expect(host.querySelector('[data-testid="settings-nav-first"]')?.hasAttribute('aria-current')).toBe(false)
    const resourceTab = host.querySelector<HTMLButtonElement>('#mcp-tab')
    let resourceClicks = 0
    resourceTab?.addEventListener('click', () => resourceClicks++)
    resourceTab?.click()
    expect(resourceTab?.getAttribute('aria-selected')).toBe('true')
    host.querySelector<HTMLButtonElement>('#model-settings')?.click()
    expect(resourceTab?.hidden).toBe(true)
    expect(resourceClicks).toBe(1)
    expect(host.querySelector('#mcp-tab')).toBe(resourceTab)
    expect(host.querySelector('#resource-list')?.getAttribute('aria-labelledby')).toBe('mcp-tab')
    host.querySelector<HTMLButtonElement>('[data-settings-section="first"]')?.click()
    host
      .querySelector('#settings-section-tab-first')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    expect(document.activeElement).toBe(tabControl)
    // A shell reopen can reset the native pane before restoring the same deep link.
    region.current?.open('model')
    expect(sections()?.hidden).toBe(true)
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'second', bubbles: true }))
    expect(sections()?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('#model-settings-pane')?.hidden).toBe(true)
    // The group's rail entry stays current even though the page on screen is not the group's first.
    expect(host.querySelector('[data-testid="settings-nav-first"]')?.getAttribute('aria-current')).toBe(
      'page',
    )
    const marker = document.createElement('h3')
    marker.id = 'auxiliary-models'
    marker.tabIndex = -1
    host.querySelector('#model-settings-pane')?.append(marker)
    const link = document.createElement('a')
    link.href = '?settings=model#auxiliary-models'
    link.textContent = 'Models'
    sections()?.append(link)
    link.click()
    expect(host.querySelector<HTMLElement>('#model-settings-pane')?.hidden).toBe(false)
    expect(sections()?.hidden).toBe(true)
    expect(new URL(location.href).searchParams.get('settings')).toBe('model')
    expect(new URL(location.href).hash).toBe('#auxiliary-models')
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'second', bubbles: true }))
    expect(sections()?.hidden).toBe(false)

    entries = [
      ...entries,
      {
        id: 'third',
        group: 'security',
        titleKey: 'third',
        groupTitleKey: 'security',
        icon: 'security',
        order: 12,
      },
    ]
    for (const listener of changed) listener()
    expect(nav()).toHaveLength(2)
    expect(host.querySelectorAll('#settings-section-tabs [role="tab"]')).toHaveLength(3)
    // A group of pages is named once above its tabs, and the tab list takes that name.
    const groupTitle = host.querySelector<HTMLElement>('#settings-group-title')
    expect(groupTitle?.hidden).toBe(false)
    expect(groupTitle?.textContent).not.toBe('')
    expect(groupTitle?.nextElementSibling?.id).toBe('settings-section-tabs')
    expect(host.querySelector('#settings-section-tabs')?.getAttribute('aria-labelledby')).toBe(
      'settings-group-title',
    )
    entries = entries.filter((entry) => entry.id !== 'second')
    for (const listener of changed) listener()
    expect(host.querySelector('[data-settings-section="second"]')).toBeNull()
    expect(host.querySelector('#config-form')?.getAttribute('data-settings-section')).toBe('model')
  })

  it('lists advanced pages only while the switch is on, routes merged links and the terminal', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    let closed = 0
    let terminal = 0
    host.addEventListener('agnes:settings-terminal', () => terminal++)
    const entries: SettingsNavigationEntry[] = [
      {
        id: 'model',
        group: 'accounts',
        titleKey: 'Models',
        groupTitleKey: 'Accounts',
        icon: 'accounts',
        order: 0,
        nativePane: 'model',
        navigationId: 'model-settings',
      },
      {
        id: 'models',
        group: 'advanced',
        titleKey: 'Run configuration',
        groupTitleKey: 'Advanced',
        icon: 'agent',
        order: 80,
      },
      {
        id: 'diagnostics',
        group: 'advanced',
        titleKey: 'Runtime & diagnostics',
        groupTitleKey: 'Advanced',
        icon: 'diagnostics',
        order: 81,
      },
      {
        id: 'custom',
        group: 'vendor',
        titleKey: 'Preferences',
        groupTitleKey: 'Example plugin',
        icon: 'plug',
        order: 100,
      },
    ]
    const moved: unknown[] = []
    const options = {
      sections: { entries: () => entries, subscribe: () => () => undefined },
      translate: (key: string) => key,
      onClose: () => closed++,
      onMoved: (target: unknown) => moved.push(target),
    }
    flushSync(() => root.render(createElement(SettingsBuiltin, { options })))
    for (const pane of ['model', 'plugin', 'appearance'] as const) {
      const slot = host.querySelector<HTMLElement>(`#settings-pane-slot-${pane}`)
      if (!slot) throw new Error('Missing settings pane slot')
      const paneRoot = createRoot(slot)
      roots.push(paneRoot)
      flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane })))
    }
    const form = host.querySelector<HTMLFormElement>('#config-form')
    if (!form) throw new Error('Missing settings navigation controls')
    form.dataset.settingsView = 'detail'
    // Off by default: no advanced group, and a plugin's own section is listed by name.
    expect(host.querySelector('#settings-advanced')).toBeNull()
    expect(host.querySelector('[data-testid="settings-nav-models"]')).toBeNull()
    expect(host.querySelector('[data-testid="settings-nav-custom"]')?.textContent).toContain('Preferences')
    // A page that left settings is not opened here: its new home goes to the host.
    for (const id of ['memory', 'skills', 'history'])
      form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true }))
    expect(moved).toEqual([
      { kind: 'page', page: 'plugins', tab: 'plugins.memory' },
      { kind: 'page', page: 'plugins', tab: 'skills' },
      { kind: 'session-search' },
    ])
    expect(form.dataset.settingsSection).toBe('model')
    // An old link to an advanced page still opens it; the switch stays the reader's choice.
    form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'context', bubbles: true }))
    expect(form.dataset.settingsSection).toBe('models')
    expect(new URL(location.href).searchParams.get('settings')).toBe('models')
    expect(new URL(location.href).hash).toBe('#settings-subsection-context')
    expect(host.querySelector<HTMLElement>('#settings-sections-pane')?.hidden).toBe(false)
    expect(host.querySelector('#settings-advanced')).toBeNull()
    const toggle = host.querySelector<HTMLElement>('[data-testid="settings-advanced-switch"]')
    if (!toggle) throw new Error('Missing the advanced settings switch')
    await act(async () => toggle.click())
    expect(advancedSettingsShown()).toBe(true)
    expect(localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)).toBe('1')
    const advanced = host.querySelector<HTMLElement>('#settings-advanced')
    expect(advanced?.querySelectorAll('button[data-settings-section]')).toHaveLength(2)
    // The page already on screen is the current entry of the group that just appeared.
    expect(host.querySelector('[data-testid="settings-nav-models"]')?.getAttribute('aria-current')).toBe(
      'page',
    )
    expect(host.querySelector('[data-testid="settings-nav-diagnostics"]')?.hasAttribute('aria-current')).toBe(
      false,
    )
    form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'models', bubbles: true }))
    expect(new URL(location.href).hash).toBe('#settings-subsection-context')
    history.replaceState(history.state, '', '?settings=context')
    form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'models', bubbles: true }))
    expect(new URL(location.href).searchParams.get('settings')).toBe('models')
    expect(new URL(location.href).hash).toBe('#settings-subsection-context')
    host.querySelector<HTMLButtonElement>('#settings-back')?.click()
    expect(form.dataset.settingsView).toBe('list')
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('models')
    await act(async () => toggle.click())
    expect(host.querySelector('#settings-advanced')).toBeNull()
    expect(localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)).toBeNull()
    // The background tasks page is gone: its links open the workbench terminal, like the terminal's.
    for (const [index, id] of ['terminal', 'jobs'].entries()) {
      await act(async () => {
        form.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: id, bubbles: true }))
      })
      expect(closed).toBe(index + 1)
      expect(terminal).toBe(index + 1)
      expect(new URL(location.href).searchParams.has('settings')).toBe(false)
    }
    await vi.waitFor(() => expect(document.querySelector('.agh-toast')?.textContent).toBeTruthy())
    expect(document.body.contains(document.querySelector('.agh-toast'))).toBe(true)
    expect(document.querySelector('.agh-toast-host')?.parentElement).toBe(document.body)
  })

  it('renders the appearance controls in English', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'appearance', translate: enT })))
    expect(host.querySelector('input[name="agnes-theme"][value="system"]')).toBeInstanceOf(HTMLInputElement)
    expect(host.querySelector('input[name="agnes-font-scale"][value="normal"]')).toBeInstanceOf(
      HTMLInputElement,
    )
    expect(host.querySelector('#appearance-settings-pane h2')?.textContent).toBe('General')
    expect(host.querySelector('[aria-label="Font size"]')?.getAttribute('aria-label')).toBe('Font size')
    // 语言切换必须留在通用设置里：合并 origin/main 时它一度被整段冲掉，
    // 而当时的用例断言被改成只查配色和字号，回归没有被兜住。
    // The language and skin controls are pickers filled at run time, not options written here.
    expect(host.querySelector('[aria-label="Language"] select#locale-select')).toBeInstanceOf(
      HTMLSelectElement,
    )
    expect(host.querySelector('select#skin-select + #skin-option-items')).toBeTruthy()
    expect(host.querySelector('input[name="agnes-locale"], input[name="agnes-skin"]')).toBeNull()
    expect(host.querySelector('[aria-label="Language"] legend')?.textContent).toBe('Language')
  })

  it('renders controller controls and their current translations', () => {
    // 合并 origin/main 时 settings.ts 被整段退回成 main 的版本，分支自己加的标记随之丢失，
    // 而当时没有任何用例覆盖这些元素，回归因此无人发现。这里按元素逐个钉住标记。
    // 面板是单独渲染进各自 slot 的（外壳会把 settings-pane 段落移除），所以按面板渲染。
    const expected: Array<[SettingsPane, string, string, string]> = [
      ['computer-use', '#computer-use-refresh span', 'data-i18n', 'computerUse.action.refresh'],
      ['computer-use', '#computer-use-install span', 'data-i18n', 'computerUse.action.install'],
      ['computer-use', '#computer-use-update span', 'data-i18n', 'computerUse.action.update'],
      ['computer-use', '#computer-use-restart span', 'data-i18n', 'computerUse.action.restart'],
      ['computer-use', '#computer-use-doctor-run span', 'data-i18n', 'computerUse.doctor.run'],
      [
        'computer-use',
        '#computer-use-operation-refresh span',
        'data-i18n',
        'computerUse.action.operationRefresh',
      ],
      ['computer-use', '#computer-use-operation-cancel span', 'data-i18n', 'computerUse.action.cancel'],
      ['computer-use', '#computer-use-permission-grant span', 'data-i18n', 'computerUse.permissions.grant'],
      ['archived', '#archived-search', 'placeholder', 'settings-shell.searchPlaceholder'],
    ]
    for (const [pane, selector, attribute, key] of expected) {
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      flushSync(() =>
        root.render(createElement(SettingsPaneBuiltin, { pane, translate: (key) => `translated:${key}` })),
      )
      const element = host.querySelector(selector)
      expect(element, `${selector} 缺失`).toBeTruthy()
      expect(attribute === 'placeholder' ? element?.getAttribute(attribute) : element?.textContent).toBe(
        `translated:${key}`,
      )
    }
  })

  it('keeps the conversation child contract in the web-units package', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const ref = createRef<import('../src/index.js').ConversationHandle>()
    let children: ConversationChildContainers | undefined
    const root = createRoot(host)
    roots.push(root)

    flushSync(() =>
      root.render(
        createElement(Conversation, {
          ref,
          onMount: (value) => {
            children = value
          },
        }),
      ),
    )

    expect(host.querySelector('[data-agnes-region-unit="conversation"]')).toBeTruthy()
    expect(host.querySelector('#transcript')).toBeTruthy()
    expect(host.querySelector('#empty-state')).toBeTruthy()
    expect(host.querySelector('#new-content')).toBeInstanceOf(HTMLButtonElement)
    expect(children?.transcript.id).toBe('transcript')
    ref.current?.setEmptyStateVisible(true)
    expect(host.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(false)
  })

  it('renders sidebar through injected host adapters while owning its surface', () => {
    const host = document.createElement('aside')
    document.body.append(
      host,
      Object.assign(document.createElement('button'), { id: 'sidebar-toggle' }),
      Object.assign(document.createElement('button'), { id: 'sidebar-backdrop' }),
    )
    const ref = createRef<import('../src/index.js').SidebarHandle>()
    let rendered = 0
    let disposed = 0
    const root = createRoot(host)
    roots.push(root)

    flushSync(() =>
      root.render(
        createElement(Sidebar, {
          ref,
          state: EMPTY_SIDEBAR_STATE,
          dependencies: {
            translate: (key) => key,
            renderNavigation: () => {
              rendered++
              return 'navigation'
            },
            bindSidebar: () => ({
              close: () => undefined,
              dismiss: () => undefined,
              dispose: () => {
                disposed++
              },
            }),
          },
        }),
      ),
    )

    expect(host.querySelector('[data-agnes-region-unit="sidebar"]')).toBeTruthy()
    expect(host.querySelector('#sessions')?.textContent).toBe('navigation')
    expect(rendered).toBeGreaterThan(0)
    root.unmount()
    expect(disposed).toBe(1)
  })

  it('renders plugin and resource pane templates with translated controls', () => {
    const host = document.createElement('div')
    document.body.append(host)
    document.documentElement.lang = 'en'
    const root = createRoot(host)
    roots.push(root)

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'plugin', translate: enT })))
    expect(host.querySelector('#install-source')?.textContent).toBe('Install from source')
    expect(host.querySelector('#install-source span')?.textContent).toBe('Install from source')

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'resources', translate: enT })))
    expect(host.querySelector('#skill-refresh')?.textContent).toBe('Refresh Skill catalog')
    expect(host.querySelector('#resource-list')?.getAttribute('aria-label')).toBe('Resource catalog')
    expect(host.querySelector('[data-i18n]')).toBeNull()
  })
})
