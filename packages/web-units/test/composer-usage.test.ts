/** @vitest-environment happy-dom */
import { webUiLocaleCatalog } from '@agnes/web-ui'
import { ConversationUsage } from '@agnes/web-ui/assistant-ui'
import { act, createElement, createRef, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
} from '../src/composer.js'

it('uses component ownership and disposes compatible custom factories on replacement and unmount', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('section')
  document.body.append(host)
  const root = createRoot(host)
  const handle = createRef<ComposerHandle>()
  const update = Object.assign(vi.fn(), { dispose: vi.fn() })
  const picker = () => ({ destroy: vi.fn(), render: vi.fn() })
  const dependencies: ComposerDependencies = {
    // 组件已改为从目录取词，所以桩要返回真实文案（含 {var} 插值）而不是 key 本身。
    translate: (key, vars) => {
      const template = webUiLocaleCatalog['zh-CN'][key] ?? key
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match,
      )
    },
    createModelPicker: picker,
    createPermissionPicker: picker,
    createUsagePanel: vi.fn(() => update),
    isSubmitShortcut: () => false,
    resize: () => {},
  }
  const options = {
    onCancel() {},
    onDraftChange() {},
    onError() {},
    onSubmit() {},
    onWorkspace() {},
    onModelSelect: async () => false,
    onPermissionSelect: async () => false,
  }
  const render = async (deps: ComposerDependencies) =>
    act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Composer, { ...options, ref: handle, dependencies: deps }),
        ),
      ),
    )
  try {
    await render({ ...dependencies, UsagePanel: ConversationUsage })
    expect(dependencies.createUsagePanel).not.toHaveBeenCalled()
    const view: ComposerView = {
      cancel: { disabled: true, hidden: true, label: '停止' },
      connected: false,
      configured: true,
      hasSession: true,
      hint: { kind: 'state', text: 'disconnected' },
      input: { disabled: false, placeholder: 'task' },
      loading: false,
      model: { accessibleName: 'model', disabled: true, label: 'model', options: [], pending: false },
      permission: { disabled: true, pending: false, selected: 'workspace' },
      sending: false,
      send: { disabled: true, label: 'send', mode: 'idle', title: 'send' },
      stopping: false,
      usage: {
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        context: { tokens: 1500, window: 128000, autoCompact: true },
        model: { route: 'local', id: 'm', thinking: 'off' },
      },
      workspace: { disabled: true, label: 'workspace', title: 'workspace' },
    }
    await act(async () => handle.current?.render(view))
    expect(host.querySelector('#session-usage')?.textContent).toContain('上次同步')
    await render(dependencies)
    expect(dependencies.createUsagePanel).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenLastCalledWith(view.usage, false)
    const next = Object.assign(vi.fn(), { dispose: vi.fn() })
    await render({ ...dependencies, createUsagePanel: () => next })
    expect(update.dispose).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenLastCalledWith(view.usage, false)
    await act(async () => root.render(null))
    expect(next.dispose).toHaveBeenCalledTimes(1)
    // Older custom factories with no disposal property still satisfy the injection contract.
    await render({ ...dependencies, createUsagePanel: () => vi.fn(() => {}) })
    await act(async () => root.render(null))
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
