/** @vitest-environment happy-dom */
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { createElement, createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComposerProps } from '../src/composer/contracts.js'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
} from '../src/composer.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'
import { createComposerReferences } from '../src/reference-picker.js'

const dependencies: ComposerDependencies = {
  translate: (key) => webUnitsLocaleCatalog['zh-CN'][key] ?? key,
  ModelPicker: () => createElement('span', { id: 'fixture-model' }),
  PermissionPicker: () => createElement('span', { id: 'fixture-permission' }),
  UsagePanel: () => null,
  isSubmitShortcut: (event) =>
    event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229,
}

const idle: ComposerView = {
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' },
  input: { disabled: false, placeholder: '描述你想完成的事…' },
  loading: false,
  model: { accessibleName: 'model', disabled: false, label: 'model', options: [], pending: false },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: false, label: '发送', mode: 'idle', title: '发送（Enter）' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: false, label: 'agnes', title: '/workspace/agnes', visible: true },
}

const regions: RegionRenderer[] = []

function mount(overrides: Partial<ComposerProps> = {}, view: ComposerView = idle) {
  const host = document.createElement('div')
  document.body.append(host)
  const region = createRegionRenderer(host)
  regions.push(region)
  const handle = createRef<ComposerHandle>()
  const props = {
    onCancel: vi.fn(),
    onDraftChange: vi.fn(),
    onError: vi.fn(),
    onSubmit: vi.fn(),
    onWorkspace: vi.fn(),
    onModelSelect: async () => false,
    onPermissionSelect: async () => false,
    ...overrides,
  }
  region.render(createElement(Composer, { ...props, ref: handle, dependencies, initialView: view }))
  region.flush()
  const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
  if (!prompt || !handle.current) throw new Error('composer did not mount')
  return { host, handle: handle.current, prompt, props }
}

function type(prompt: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(prompt, value)
  prompt.setSelectionRange(value.length, value.length)
  prompt.dispatchEvent(new Event('input', { bubbles: true }))
}

function key(prompt: HTMLTextAreaElement, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  prompt.dispatchEvent(event)
  return event
}

afterEach(() => {
  for (const region of regions.splice(0)) region.unmount()
  document.body.replaceChildren()
})

it('keeps message controls in the card and session controls in the row under it', () => {
  const { host } = mount()
  const card = host.querySelector('#composer')
  const meta = host.querySelector('.composer-meta')
  expect(card?.getAttribute('data-agnes-region')).toBe('composer')
  expect(card?.nextElementSibling).toBe(meta)
  // The approval mode sits beside the add button, inside the card.
  for (const id of [
    '#prompt',
    '#composer-attach',
    '#fixture-permission',
    '#fixture-model',
    '#send',
    '#cancel',
    '#composer-hint',
  ])
    expect(host.querySelector(id)?.closest('#composer'), id).toBe(card)
  for (const id of ['#composer-workspace', '#session-usage']) {
    expect(host.querySelector(id)?.closest('.composer-meta'), id).toBe(meta)
    expect(host.querySelector(id)?.closest('#composer'), id).toBeNull()
  }
  expect(host.querySelector('#prompt')?.getAttribute('data-agnes-region')).toBe('composer-input')
  expect(host.querySelectorAll('[data-agnes-region="composer-input"]')).toHaveLength(1)
  expect(host.querySelector('label[for="prompt"]')?.textContent).toBe('任务内容')
})

it('owns the draft as state: typing reports it, the host can replace it and read it back at once', () => {
  const { handle, prompt, props } = mount({ initialDraft: '已保存的草稿' })
  expect(prompt.value).toBe('已保存的草稿')
  expect(handle.getDraft()).toBe('已保存的草稿')

  type(prompt, '新的内容')
  expect(props.onDraftChange).toHaveBeenLastCalledWith('新的内容')
  expect(handle.getDraft()).toBe('新的内容')

  // A host command sets the draft and submits in the same tick; the read must not wait for a render.
  handle.setDraft('/plan')
  expect(handle.getDraft()).toBe('/plan')
  // Replacing the draft is the host's own change, not user input to report back.
  expect(props.onDraftChange).toHaveBeenCalledTimes(1)
})

it('reports each typed change once and adopts scripted writes to the textarea', async () => {
  const { handle, prompt, props } = mount()
  type(prompt, '一次')
  expect(props.onDraftChange).toHaveBeenCalledTimes(1)

  // Text expanders and automation assign the value and fire an input event themselves.
  prompt.value = '脚本写入'
  prompt.dispatchEvent(new Event('input', { bubbles: true }))
  expect(props.onDraftChange).toHaveBeenLastCalledWith('脚本写入')
  expect(props.onDraftChange).toHaveBeenCalledTimes(2)
  expect(handle.getDraft()).toBe('脚本写入')

  // Without an event the host still reads what is on screen, and clearing really clears it.
  await new Promise((resolve) => setTimeout(resolve, 0))
  prompt.value = '没有事件'
  expect(handle.getDraft()).toBe('没有事件')
  handle.setDraft('脚本写入')
  expect(prompt.value).toBe('脚本写入')
  expect(props.onDraftChange).toHaveBeenCalledTimes(2)
})

it('submits on Enter only: Shift+Enter and an active IME composition leave the draft alone', () => {
  const { prompt, props } = mount()
  type(prompt, '你好')
  expect(key(prompt, { key: 'Enter', keyCode: 13, shiftKey: true }).defaultPrevented).toBe(false)
  expect(key(prompt, { key: 'Enter', keyCode: 229 }).defaultPrevented).toBe(false)
  expect(key(prompt, { key: 'Enter', keyCode: 13, isComposing: true }).defaultPrevented).toBe(false)
  expect(props.onSubmit).not.toHaveBeenCalled()
  expect(key(prompt, { key: 'Enter', keyCode: 13 }).defaultPrevented).toBe(true)
  expect(props.onSubmit).toHaveBeenCalledTimes(1)
  // Command/Ctrl+Enter is the same contract as Enter.
  expect(key(prompt, { key: 'Enter', keyCode: 13, metaKey: true }).defaultPrevented).toBe(true)
  expect(props.onSubmit).toHaveBeenCalledTimes(2)
})

it('keeps the shortcut in the send tooltip when idle and shows the reason when sending is unavailable', () => {
  const { host, handle } = mount()
  const hint = () => host.querySelector('#composer-hint')
  expect(hint()?.textContent).toBe('Enter 发送，Shift+Enter 换行')
  // No shortcut chips inside the card: the send button's tooltip carries the contract.
  expect(host.querySelector('#composer kbd')).toBeNull()
  expect(host.querySelector('#send')?.getAttribute('title')).toBe('Enter 发送，Shift+Enter 换行')

  handle.render({
    ...idle,
    hint: { kind: 'state', text: '这个会话在这里只读，无法发送消息。请新开会话继续工作。' },
    input: { ...idle.input, disabled: true },
    send: { ...idle.send, disabled: true },
  })
  expect(hint()?.getAttribute('data-kind')).toBe('state')
  expect(hint()?.textContent).toBe('这个会话在这里只读，无法发送消息。请新开会话继续工作。')
  expect(host.querySelector('#send')?.getAttribute('title')).not.toBe('Enter 发送，Shift+Enter 换行')
  expect(host.querySelector<HTMLTextAreaElement>('#prompt')?.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('#send')?.disabled).toBe(true)
})

it('offers stop and pause while the agent runs and keeps their names for assistive technology', () => {
  const onPauseResume = vi.fn()
  const { host, handle, props } = mount({ onPauseResume })
  const send = host.querySelector<HTMLButtonElement>('#send')
  const cancel = host.querySelector<HTMLButtonElement>('#cancel')
  expect(send?.getAttribute('aria-label')).toBe('发送')
  expect(send?.getAttribute('data-mode')).toBe('idle')
  expect(send?.type).toBe('submit')
  expect(cancel?.hidden).toBe(true)
  expect(host.querySelector('#composer')?.getAttribute('data-busy')).toBe('false')

  handle.render({
    ...idle,
    cancel: { disabled: false, hidden: false, label: '停止' },
    controls: {
      paused: true,
      pending: false,
      disabled: false,
      pauseSupported: true,
      interruptSupported: true,
      reason: '',
    },
    send: { disabled: true, label: '排队指引', mode: 'busy', title: '排队指引（Enter）' },
  })
  expect(host.querySelector('#composer')?.getAttribute('data-busy')).toBe('true')
  expect(cancel?.hidden).toBe(false)
  expect(cancel?.getAttribute('aria-label')).toBe('停止')
  expect(cancel?.textContent).toBe('停止')
  expect(send?.getAttribute('aria-label')).toBe('排队指引')
  cancel?.click()
  expect(props.onCancel).toHaveBeenCalledTimes(1)
  const pause = host.querySelector<HTMLButtonElement>('[data-testid="composer-pause-resume"]')
  expect(pause?.getAttribute('aria-pressed')).toBe('true')
  expect(pause?.textContent).toBe('继续')
  pause?.click()
  expect(onPauseResume).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[data-testid="composer-paused"]')?.getAttribute('role')).toBe('status')
})

it('opens the workspace chooser from the row and hides the chip for a session with a fixed workspace', () => {
  const { host, handle, props } = mount()
  const workspace = host.querySelector<HTMLButtonElement>('#composer-workspace')
  expect(workspace?.hidden).toBe(false)
  expect(workspace?.querySelector('[data-workspace-label]')?.textContent).toBe('agnes')
  expect(workspace?.title).toBe('/workspace/agnes')
  workspace?.click()
  expect(props.onWorkspace).toHaveBeenCalledTimes(1)
  handle.render({ ...idle, workspace: { ...idle.workspace, visible: false } })
  expect(workspace?.hidden).toBe(true)
})

it('starts a reference from the add menu and removes the consumed query when one is chosen', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const candidate = { source: 'file', id: 'docs/readme.md', label: 'readme.md' }
    const references = createComposerReferences(async () => ({ items: [candidate], truncated: false }))
    const { host, handle, prompt, props } = mount({ references })
    type(prompt, '看一下')

    const add = host.querySelector<HTMLButtonElement>('#composer-attach')
    expect(add?.getAttribute('aria-label')).toBe('添加文件或引用')
    add?.click()
    const start = await vi.waitFor(() => {
      const item = document.querySelector<HTMLElement>('[data-testid="composer-add-reference"]')
      if (!item) throw new Error('add menu did not open')
      return item
    })
    expect(document.querySelector('[data-testid="composer-add-file"]')?.textContent).toBe('上传文件…')
    start.click()

    // The `@` is typed for the user after a separating space, and the picker takes over.
    await vi.waitFor(() => expect(handle.getDraft()).toBe('看一下 @'))
    expect(props.onDraftChange).toHaveBeenLastCalledWith('看一下 @')
    await vi.waitFor(() => expect(prompt.getAttribute('role')).toBe('combobox'))
    expect(document.activeElement).toBe(prompt)
    await vi.advanceTimersByTimeAsync(150)
    const option = await vi.waitFor(() => {
      const found = host.querySelector<HTMLElement>('[data-testid="reference-option"]')
      if (!found) throw new Error('no reference candidates')
      return found
    })
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))

    await vi.waitFor(() => expect(references.getSnapshot()).toEqual([candidate]))
    await vi.waitFor(() => expect(handle.getDraft()).toBe('看一下 '))
    expect(prompt.value).toBe('看一下 ')
    expect(host.querySelector('[data-testid="reference-draft-chips"]')?.textContent).toContain('readme.md')
  } finally {
    vi.useRealTimers()
  }
})
