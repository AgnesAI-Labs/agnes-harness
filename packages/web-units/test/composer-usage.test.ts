/** @vitest-environment happy-dom */
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
    createModelPicker: picker,
    createPermissionPicker: picker,
    createUsagePanel: vi.fn(() => update),
    isSubmitShortcut: () => false,
    resize: () => {},
  }
  const selectedRuntime = vi.fn()
  const options = {
    onCancel() {},
    onDraftChange() {},
    onError() {},
    onSubmit() {},
    onWorkspace() {},
    onModelSelect: async () => false,
    onPermissionSelect: async () => false,
    onRuntimeSelect: selectedRuntime,
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
      runtime: {
        selected: 'native',
        label: 'Native',
        fixed: false,
        disabled: false,
        options: [
          {
            id: 'native',
            version: '1',
            label: 'Native',
            apiVersion: 1,
            available: true,
            capabilities: { prompt: true, cancel: true, resume: true, compact: true, fork: true },
          },
          {
            id: 'jevloop',
            version: '1',
            label: 'JevLoop',
            apiVersion: 1,
            available: false,
            unavailableReason: '模型未就绪',
            capabilities: { prompt: true, cancel: true, resume: true, compact: false, fork: false },
          },
        ],
      },
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
    const runtimePicker = host.querySelector<HTMLSelectElement>('[aria-label="选择新会话运行循环"]')
    expect(runtimePicker?.value).toBe('native')
    expect(runtimePicker?.options[1]?.disabled).toBe(true)
    expect(runtimePicker?.options[1]?.textContent).toContain('模型未就绪')
    await act(async () => runtimePicker?.dispatchEvent(new Event('change', { bubbles: true })))
    expect(selectedRuntime).toHaveBeenCalledWith('native')
    const runtime = view.runtime
    if (!runtime) throw new Error('runtime view missing')
    await act(async () => handle.current?.render({ ...view, runtime: { ...runtime, fixed: true } }))
    expect(host.querySelector('select.composer-runtime')).toBeNull()
    expect(host.querySelector('[data-runtime-id="native"]')?.textContent).toBe('Native')
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
