/** @vitest-environment happy-dom */

import type { UINode } from '@agnes/protocol'
import { createElement, createRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Conversation,
  type ConversationChildContainers,
  EMPTY_SIDEBAR_STATE,
  SettingsBuiltin,
  type SettingsPane,
  SettingsPaneBuiltin,
  Sidebar,
  Transcript,
  type TranscriptHandle,
} from '../src/index.js'
import type { SettingsNavigationEntry, SettingsRegionHandle } from '../src/settings.js'

const roots: Root[] = []
const englishText: Record<string, string> = {
  'settings-shell.appearanceTitle': 'General settings',
  'settings-shell.fontScale': 'Font size',
  'shell.install': 'Install from source',
  'button.refresh': 'Refresh Skill catalog',
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

  it('keeps one rail entry per registry group, routes tabs by keyboard and removes disposed sections', () => {
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
      { id: 'first', group: 'agent', titleKey: 'first', groupTitleKey: 'agent', icon: 'agent', order: 10 },
      { id: 'second', group: 'agent', titleKey: 'second', groupTitleKey: 'agent', icon: 'agent', order: 11 },
    ]
    const changed = new Set<() => void>()
    flushSync(() =>
      root.render(
        createElement(SettingsBuiltin, {
          ref: region,
          options: {
            translate: (key) => key,
            sections: {
              entries: () => entries,
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
    for (const pane of ['model', 'plugin'] as const) {
      const slot = host.querySelector<HTMLElement>(`#settings-pane-slot-${pane}`)
      if (!slot) throw new Error('Missing settings pane slot')
      const paneRoot = createRoot(slot)
      roots.push(paneRoot)
      flushSync(() => paneRoot.render(createElement(SettingsPaneBuiltin, { pane })))
    }
    const nav = () => host.querySelectorAll('.settings-nav-group > [data-settings-section]')
    expect(nav()).toHaveLength(2)
    host.querySelector<HTMLButtonElement>('[data-settings-section="first"]')?.click()
    host
      .querySelector<HTMLButtonElement>('[role="tab"][data-settings-section="first"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.activeElement?.getAttribute('data-settings-section')).toBe('second')
    expect(host.querySelector('#config-form')?.getAttribute('data-settings-section')).toBe('second')
    expect(new URL(location.href).searchParams.get('settings')).toBe('second')
    // A shell reopen can reset the native pane before restoring the same deep link.
    region.current?.open('model')
    expect(host.querySelector<HTMLElement>('#plugin-settings-pane')?.hidden).toBe(true)
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'second', bubbles: true }))
    expect(host.querySelector<HTMLElement>('#plugin-settings-pane')?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('#model-settings-pane')?.hidden).toBe(true)
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
    host.querySelector('#plugin-settings-pane')?.append(link)
    link.click()
    expect(host.querySelector<HTMLElement>('#model-settings-pane')?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('#plugin-settings-pane')?.hidden).toBe(true)
    expect(new URL(location.href).searchParams.get('settings')).toBe('model')
    expect(new URL(location.href).hash).toBe('#auxiliary-models')
    host
      .querySelector('#config-form')
      ?.dispatchEvent(new CustomEvent('agnes:settings-route', { detail: 'second', bubbles: true }))
    expect(host.querySelector<HTMLElement>('#plugin-settings-pane')?.hidden).toBe(false)

    entries = [
      ...entries,
      { id: 'third', group: 'agent', titleKey: 'third', groupTitleKey: 'agent', icon: 'agent', order: 12 },
    ]
    for (const listener of changed) listener()
    expect(nav()).toHaveLength(2)
    expect(host.querySelectorAll('#settings-section-tabs [role="tab"]')).toHaveLength(3)
    entries = entries.filter((entry) => entry.id !== 'second')
    for (const listener of changed) listener()
    expect(host.querySelector('[data-settings-section="second"]')).toBeNull()
    expect(host.querySelector('#config-form')?.getAttribute('data-settings-section')).toBe('model')
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
    expect(host.querySelector('[data-i18n="settings-shell.appearanceTitle"]')?.textContent).toBe(
      'General settings',
    )
    expect(
      host.querySelector('[data-i18n-aria="settings-shell.fontScale"]')?.getAttribute('aria-label'),
    ).toBe('Font size')
    // 语言切换必须留在通用设置里：合并 origin/main 时它一度被整段冲掉，
    // 而当时的用例断言被改成只查配色和字号，回归没有被兜住。
    const english = host.querySelector<HTMLInputElement>('input[name="agnes-locale"][value="en"]')
    const chinese = host.querySelector<HTMLInputElement>('input[name="agnes-locale"][value="zh-CN"]')
    expect(english).toBeInstanceOf(HTMLInputElement)
    expect(chinese).toBeInstanceOf(HTMLInputElement)
    expect(english?.checked).toBe(true)
    expect(host.querySelector('[data-i18n="settings.appearance.language"]')?.textContent).toBe('Language')
  })

  it('keeps the settings markup markers the origin/main merge dropped', () => {
    // 合并 origin/main 时 settings.ts 被整段退回成 main 的版本，分支自己加的标记随之丢失，
    // 而当时没有任何用例覆盖这些元素，回归因此无人发现。这里按元素逐个钉住标记。
    // 面板是单独渲染进各自 slot 的（外壳会把 settings-pane 段落移除），所以按面板渲染。
    const expected: Array<[SettingsPane, string, string, string]> = [
      ['computer-use', '#computer-use-refresh [data-i18n]', 'data-i18n', 'computerUse.action.refresh'],
      ['computer-use', '#computer-use-install [data-i18n]', 'data-i18n', 'computerUse.action.install'],
      ['computer-use', '#computer-use-update [data-i18n]', 'data-i18n', 'computerUse.action.update'],
      ['computer-use', '#computer-use-restart [data-i18n]', 'data-i18n', 'computerUse.action.restart'],
      ['computer-use', '#computer-use-doctor-run [data-i18n]', 'data-i18n', 'computerUse.doctor.run'],
      [
        'computer-use',
        '#computer-use-operation-refresh [data-i18n]',
        'data-i18n',
        'computerUse.action.operationRefresh',
      ],
      [
        'computer-use',
        '#computer-use-operation-cancel [data-i18n]',
        'data-i18n',
        'computerUse.action.cancel',
      ],
      [
        'computer-use',
        '#computer-use-permission-grant [data-i18n]',
        'data-i18n',
        'computerUse.permissions.grant',
      ],
      ['archived', '#archived-search', 'data-i18n-placeholder', 'settings-shell.searchPlaceholder'],
    ]
    for (const [pane, selector, attribute, key] of expected) {
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      roots.push(root)
      flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane })))
      const element = host.querySelector(selector)
      expect(element, `${selector} 缺失`).toBeTruthy()
      expect(element?.getAttribute(attribute), `${selector} 少了 ${attribute}="${key}"`).toBe(key)
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
            renderNavigation: ({ nav }) => {
              rendered++
              nav.textContent = 'navigation'
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

  it('keeps transcript rendering and cleanup behind an injected renderer contract', () => {
    const host = document.createElement('section')
    host.id = 'transcript'
    const button = document.createElement('button')
    document.body.append(host, button)
    const ref = createRef<TranscriptHandle>()
    let rendered: readonly UINode[] = []
    let reset = 0
    let observed = 0
    let stopped = 0
    const root = createRoot(host)
    roots.push(root)

    flushSync(() =>
      root.render(
        createElement(Transcript, {
          ref,
          newContentButton: button,
          dependencies: {
            createRenderer: () => ({
              render: (nodes) => {
                rendered = nodes
              },
              reset: () => {
                reset++
              },
              pinToBottom: () => undefined,
            }),
            observeCards: () => {
              observed++
              return () => {
                stopped++
              }
            },
          },
        }),
      ),
    )

    const node: UINode = { kind: 'assistant', id: 'assistant-1', seq: 1, text: 'hello' }
    ref.current?.render([node])
    expect(host.querySelector('#transcript-content')).toBeTruthy()
    expect(rendered).toEqual([node])
    expect(observed).toBe(1)
    root.unmount()
    expect(reset).toBe(1)
    expect(stopped).toBe(1)
  })

  it('renders plugin and resource pane templates with stable locale markers', () => {
    const host = document.createElement('div')
    document.body.append(host)
    document.documentElement.lang = 'en'
    const root = createRoot(host)
    roots.push(root)

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'plugin', translate: enT })))
    expect(host.querySelector('#install-source')?.textContent).toBe('Install from source')
    expect(host.querySelector('#install-source')?.getAttribute('data-i18n')).toBe('shell.install')

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'resources', translate: enT })))
    expect(host.querySelector('#skill-refresh')?.textContent).toBe('Refresh Skill catalog')
    expect(host.querySelector('#resource-list')?.getAttribute('data-i18n-aria')).toBe('shell.list.aria')
  })
})
