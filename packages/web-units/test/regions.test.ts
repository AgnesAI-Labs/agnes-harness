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
    expect(host.querySelector('.transcript')).toBeTruthy()
    expect(host.querySelector('.empty-state')).toBeTruthy()
    expect(host.querySelector('.new-content')).toBeInstanceOf(HTMLButtonElement)
    expect(children?.transcript.className).toBe('transcript')
    ref.current?.setEmptyStateVisible(true)
    expect(host.querySelector('.empty-state')?.hasAttribute('hidden')).toBe(false)
  })

  it('renders sidebar through injected host adapters while owning its surface', () => {
    const host = document.createElement('aside')
    document.body.append(
      host,
      Object.assign(document.createElement('button'), { className: 'sidebar-toggle' }),
      Object.assign(document.createElement('button'), { className: 'sidebar-backdrop' }),
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
    expect(host.querySelector('.session-nav')?.textContent).toBe('navigation')
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
    expect(host.querySelector('.transcript-content')).toBeTruthy()
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
