/** @vitest-environment happy-dom */
import { webUiLocaleCatalog } from '@agnes/web-ui'
import { ConversationUsage } from '@agnes/web-ui/conversation'
import { act, createElement, createRef, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
  type ModelPickerProps,
  type PermissionPickerProps,
} from '../src/composer.js'

it('renders the injected pickers and usage gauge in its own tree and feeds them the current view', async () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
  const host = document.createElement('section')
  document.body.append(host)
  const root = createRoot(host)
  const handle = createRef<ComposerHandle>()
  const model = vi.fn((_props: ModelPickerProps) => createElement('span', { id: 'fixture-model' }))
  const permission = vi.fn((_props: PermissionPickerProps) =>
    createElement('span', { id: 'fixture-permission' }),
  )
  const dependencies: ComposerDependencies = {
    // 组件已改为从目录取词，所以桩要返回真实文案（含 {var} 插值）而不是 key 本身。
    translate: (key, vars) => {
      const template = webUiLocaleCatalog['zh-CN'][key] ?? key
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match,
      )
    },
    ModelPicker: model,
    PermissionPicker: permission,
    UsagePanel: ConversationUsage,
    isSubmitShortcut: () => false,
  }
  const onModelSelect = vi.fn(async () => false)
  const onPermissionSelect = async () => false
  const onModelSettingsChange = async () => false
  const options = {
    onCancel() {},
    onDraftChange() {},
    onError() {},
    onSubmit() {},
    onWorkspace() {},
    onModelSelect,
    onModelSettingsChange,
    onPermissionSelect,
  }
  try {
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(Composer, { ...options, ref: handle, dependencies })),
      ),
    )
    // Nothing to gauge before the session reports a context window.
    expect(host.querySelector<HTMLElement>('#session-usage')?.hidden).toBe(true)
    const view: ComposerView = {
      cancel: { disabled: true, hidden: true, label: '停止' },
      connected: false,
      configured: true,
      hasSession: true,
      hint: { kind: 'state', text: 'disconnected' },
      input: { disabled: false, placeholder: 'task' },
      loading: false,
      model: {
        accessibleName: 'model',
        disabled: true,
        label: 'model',
        options: [{ route: 'local', id: 'm' }],
        pending: false,
        selected: { route: 'local', id: 'm' },
      },
      modelSettings: {
        settings: { thinking: 'high', contextWindow: 64000 },
        contextWindow: 128000,
        thinkingLevelMap: { low: 'low', high: 'high' },
      },
      permission: { disabled: true, pending: false, selected: 'full' },
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

    // The model, the approval mode and context use sit in the card; the workspace in the row below.
    expect(host.querySelector('#fixture-model')?.closest('#composer .composer-controls')).toBeTruthy()
    expect(host.querySelector('#fixture-permission')?.closest('#composer .composer-controls')).toBeTruthy()
    const usage = host.querySelector<HTMLElement>('#session-usage')
    expect(usage?.closest('#composer .composer-controls')).toBeTruthy()
    expect(usage?.hidden).toBe(false)
    expect(usage?.querySelector('.usage-percent')?.textContent).toBe('1%')
    expect(usage?.textContent).toContain('上次同步')

    expect(model.mock.lastCall?.[0]).toMatchObject({
      onSelect: onModelSelect,
      onSettingsChange: onModelSettingsChange,
      state: {
        label: 'model',
        selected: { route: 'local', id: 'm' },
        // Session settings and the catalog capacity reach the picker as one state.
        settings: {
          thinking: 'high',
          contextWindow: 64000,
          capacity: 128000,
          thinkingLevelMap: { low: 'low', high: 'high' },
        },
      },
    })
    expect(permission.mock.lastCall?.[0]).toMatchObject({
      onSelect: onPermissionSelect,
      state: { disabled: true, pending: false, selected: 'full' },
    })
    // The reason sending is unavailable stays readable in the card and describes the input.
    expect(host.querySelector('#composer-hint')?.textContent).toBe('disconnected')
    expect(host.querySelector('#prompt')?.getAttribute('aria-describedby')).toBe(
      'composer-hint composer-suggestion',
    )
    expect(host.querySelector('#composer-suggestion')).not.toBeNull()
    expect(host.querySelector('#composer kbd')).toBeNull()
    expect(host.querySelector('[data-testid="composer-use-model"]')).toBeNull()

    // A hint that names a way out offers it as one click: switch to the model it carries.
    const next = { route: 'account', id: 'next' }
    await act(async () =>
      handle.current?.render({
        ...view,
        hint: { kind: 'state', text: 'model gone', action: { label: 'Use next', model: next } },
      }),
    )
    const use = host.querySelector<HTMLButtonElement>('[data-testid="composer-use-model"]')
    expect(use?.textContent).toBe('Use next')
    // The pill truncates a long suggestion; the full text stays available as its title.
    expect(use?.title).toBe('Use next')
    expect(use?.previousElementSibling?.id).toBe('composer-hint')
    await act(async () => use?.click())
    expect(onModelSelect).toHaveBeenLastCalledWith(next)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
