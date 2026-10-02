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
  SettingsPaneBuiltin,
  Sidebar,
  Transcript,
  type TranscriptHandle,
} from '../src/index.js'

const roots: Root[] = []

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
    flushSync(() => shell.render(createElement(SettingsBuiltin, { options: {} })))
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

  it('renders the appearance language switch in English', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'appearance' })))
    const english = host.querySelector<HTMLInputElement>('input[name="agnes-locale"][value="en"]')
    const chinese = host.querySelector<HTMLInputElement>('input[name="agnes-locale"][value="zh-CN"]')
    expect(english).toBeInstanceOf(HTMLInputElement)
    expect(english?.checked).toBe(true)
    expect(chinese?.checked).toBe(false)
    expect(host.querySelector('[data-i18n="settings.appearance.language"]')?.textContent).toBe('Language')
    expect(
      host.querySelector('[data-i18n-aria="settings.appearance.language"]')?.getAttribute('aria-label'),
    ).toBe('Language')
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

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'plugin' })))
    expect(host.querySelector('#install-source')?.textContent).toBe('Install from source')
    expect(host.querySelector('#install-source')?.getAttribute('data-i18n')).toBe('shell.install')

    flushSync(() => root.render(createElement(SettingsPaneBuiltin, { pane: 'resources' })))
    expect(host.querySelector('#skill-refresh')?.textContent).toBe('Refresh Skill catalog')
    expect(host.querySelector('#resource-list')?.getAttribute('data-i18n-aria')).toBe('shell.list.aria')
  })
})
