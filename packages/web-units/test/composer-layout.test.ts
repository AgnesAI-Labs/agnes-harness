/** @vitest-environment happy-dom */
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { act, createElement, createRef } from 'react'
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
  region.render(
    createElement(Composer, {
      ...props,
      ref: handle,
      dependencies: overrides.dependencies ?? dependencies,
      initialView: view,
    }),
  )
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
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('completes only the available slash commands and leaves a second Enter to submit', async () => {
  const view: ComposerView = { ...idle, input: { ...idle.input, commands: ['plan', 'goal', 'refine'] } }
  const { host, handle, prompt, props } = mount(
    { references: createComposerReferences(async () => ({ items: [], truncated: false })) },
    view,
  )
  const options = () => [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  const labels = () => options().map((option) => option.querySelector('span')?.textContent)
  const selected = () => host.querySelector('[role="option"][aria-selected="true"]')
  prompt.focus()
  await act(async () => type(prompt, '/'))
  expect(labels()).toEqual(['/plan', '/goal', '/refine'])
  expect(prompt.getAttribute('aria-expanded')).toBe('true')
  expect(prompt.getAttribute('aria-controls')).toBe(options()[0]?.closest('[role="listbox"]')?.id)
  expect(prompt.getAttribute('aria-activedescendant')).toBe(options()[0]?.id)
  await act(async () => key(prompt, { key: 'ArrowUp' }))
  expect(selected()?.textContent).toContain('/refine')
  await act(async () => key(prompt, { key: 'ArrowDown' }))
  await act(async () => key(prompt, { key: 'ArrowDown' }))
  expect(selected()?.textContent).toContain('/goal')
  await act(async () => key(prompt, { key: 'Tab' }))
  expect(handle.getDraft()).toBe('/goal ')
  expect(document.activeElement).toBe(prompt)
  expect(prompt.hasAttribute('aria-activedescendant')).toBe(false)

  await act(async () => type(prompt, '/ref'))
  expect(labels()).toEqual(['/refine'])
  await act(async () => key(prompt, { key: 'Enter', ctrlKey: true }))
  expect(handle.getDraft()).toBe('/refine ')
  expect(props.onSubmit).not.toHaveBeenCalled()
  await act(async () => key(prompt, { key: 'Enter' }))
  expect(props.onSubmit).toHaveBeenCalledTimes(1)

  await act(async () => type(prompt, '/plan'))
  await act(async () => options()[0]?.click())
  expect(handle.getDraft()).toBe('/plan ')
  expect(prompt.selectionStart).toBe('/plan '.length)
  await act(async () => type(prompt, '/'))
  await act(async () => key(prompt, { key: 'Escape' }))
  expect(options()).toHaveLength(0)
  expect(handle.getDraft()).toBe('/')

  await act(async () => handle.render({ ...view, input: { ...view.input, commands: ['plan'] } }))
  await act(async () => type(prompt, '/'))
  expect(labels()).toEqual(['/plan'])
  await act(async () => handle.render({ ...view, readOnly: true }))
  expect(options()).toHaveLength(0)
})

it('opens the slash menu only for a complete command word containing the caret', async () => {
  const { host, prompt } = mount({}, { ...idle, input: { ...idle.input, commands: ['plan'] } })
  const popup = () => host.querySelector('.slash-popup')
  prompt.focus()
  const absoluteHome = ['', 'Users', 'a'].join('/')
  for (const value of [absoluteHome, '/plan/a', '/plan\n', '/plan task', ' /plan', '/compact']) {
    await act(async () => type(prompt, value))
    expect(popup(), value).toBeNull()
  }
  await act(async () => type(prompt, '/pl'))
  expect(popup()).not.toBeNull()
  await act(async () => {
    prompt.setSelectionRange(0, 0)
    prompt.click()
  })
  expect(popup()).toBeNull()
  await act(async () => {
    prompt.setSelectionRange(1, 2)
    prompt.click()
  })
  expect(popup()).toBeNull()
  await act(async () => {
    prompt.setSelectionRange(2, 2)
    prompt.click()
  })
  expect(popup()).not.toBeNull()
})

it.each([false, true])(
  'keeps message controls and context use in the card (native sizing %s)',
  (nativeSizing) => {
    const supports = CSS.supports.bind(CSS)
    vi.spyOn(CSS, 'supports').mockImplementation((property: string, value?: string) => {
      if (
        (property === 'field-sizing' && value === 'content') ||
        (property === 'min-height' && value === '1lh')
      )
        return nativeSizing
      return value === undefined ? supports(property) : supports(property, value)
    })
    const { host, prompt, handle } = mount()
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
      '#session-usage',
    ])
      expect(host.querySelector(id)?.closest('#composer'), id).toBe(card)
    // Context use sits right before the model picker it measures.
    expect(host.querySelector('#session-usage')?.nextElementSibling?.classList.contains('model-field')).toBe(
      true,
    )
    expect(host.querySelector('#composer-workspace')?.closest('.composer-meta')).toBe(meta)
    expect(host.querySelector('#composer-workspace')?.closest('#composer')).toBeNull()
    expect(host.querySelector('#prompt')?.getAttribute('data-agnes-region')).toBe('composer-input')
    expect(host.querySelectorAll('[data-agnes-region="composer-input"]')).toHaveLength(1)
    expect(host.querySelector('label[for="prompt"]')?.textContent).toBe('任务内容')
    if (nativeSizing) {
      expect(prompt.style.height).toBe('auto')
      expect(prompt.style.minHeight).toBe('2lh')
      expect(prompt.style.maxHeight).toBe('8lh')
      expect(prompt.style.overflowY).toBe('auto')
    }
    prompt.focus()
    act(() => type(prompt, 'Retain my draft'))
    act(() => handle.render({ ...idle, input: { ...idle.input, placeholder: 'Updated placeholder' } }))
    expect(host.querySelector('#prompt')).toBe(prompt)
    expect(document.activeElement).toBe(prompt)
    expect(prompt.value).toBe('Retain my draft')
    expect(prompt.selectionStart).toBe(prompt.value.length)
  },
)

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
  await act(async () => {
    prompt.value = '脚本写入'
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(props.onDraftChange).toHaveBeenLastCalledWith('脚本写入')
  expect(props.onDraftChange).toHaveBeenCalledTimes(2)
  expect(handle.getDraft()).toBe('脚本写入')

  // Without an event the host still reads what is on screen, and clearing really clears it.
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
  // An icon button: its name is the action.
  expect(pause?.getAttribute('aria-label')).toBe('继续')
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

it('opens files directly without changing the draft on cancel and still accepts typed references', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const candidate = { source: 'file', id: 'docs/readme.md', label: 'readme.md' }
    const references = createComposerReferences(async () => ({ items: [candidate], truncated: false }))
    const { host, handle, prompt, props } = mount({ references })
    type(prompt, '看一下')

    const add = host.querySelector<HTMLButtonElement>('#composer-attach')
    const fileInput = host.querySelector<HTMLInputElement>('[data-testid="attachment-file-input"]')
    if (!add || !fileInput) throw new Error('missing upload control')
    const choose = vi.spyOn(fileInput, 'click').mockImplementation(() => {})
    expect(add.getAttribute('aria-label')).toBe('上传文件')
    expect(add.title).toBe('')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    await act(async () => add.focus())
    await vi.waitFor(() =>
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        host.querySelector('#composer-image-hint')?.textContent,
      ),
    )
    expect(add.hasAttribute('aria-haspopup')).toBe(false)
    expect(add.hasAttribute('aria-expanded')).toBe(false)
    add.click()
    // The chooser must open inside the button's click, before any async work.
    expect(choose).toHaveBeenCalledOnce()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(fileInput.multiple).toBe(true)
    fileInput.dispatchEvent(new Event('cancel', { bubbles: true }))
    await vi.waitFor(() => expect(handle.getDraft()).toBe('看一下'))
    expect(handle.getAttachmentBlocks()).toEqual([])
    expect(props.onDraftChange).toHaveBeenCalledExactlyOnceWith('看一下')
    expect(props.onError).not.toHaveBeenCalled()

    for (const blocked of [
      { ...idle, input: { ...idle.input, disabled: true } },
      { ...idle, sending: true },
      { ...idle, model: { ...idle.model, pending: true } },
    ]) {
      handle.render(blocked)
      expect(add.getAttribute('aria-disabled')).toBe('true')
      add.click()
      expect(choose).toHaveBeenCalledOnce()
    }
    handle.render(idle)

    // Typing `@` keeps the reference picker available without the former add menu.
    prompt.focus()
    type(prompt, '看一下 @')
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

it('adopts the whole catalog sentence mid-animation and keeps ordinary Tab focus navigation', async () => {
  vi.useFakeTimers()
  const examples = ['Review the sample patch.', 'Read the sales CSV.'] as const
  const { host, prompt, handle } = mount(
    { examplePrompts: examples },
    { ...idle, input: { ...idle.input, exampleHint: true } },
  )
  const hint = () => host.querySelector('.composer-example-hint')
  expect(prompt.placeholder).toBe(idle.input.placeholder)
  expect(hint()?.getAttribute('aria-hidden')).toBe('true')
  // The ghost lives in the input's own content box, below any header chip, never over it.
  expect(hint()?.closest('.composer-content')).not.toBeNull()
  // The offer is honest from the first frame: the full sentence is already available to Tab.
  expect(host.querySelector('#composer-suggestion')?.textContent).toContain(examples[0])
  expect(key(prompt, { key: 'Tab', shiftKey: true }).defaultPrevented).toBe(false)
  // Mid-animation the ghost shows a prefix, but Tab adopts the whole sentence.
  await act(async () => vi.advanceTimersByTime(55 * 4))
  expect(hint()?.textContent).toContain(examples[0].slice(0, 4))
  expect(hint()?.textContent).not.toContain(examples[0])
  expect(hint()?.querySelector('kbd')?.textContent).toBe('Tab')
  let adopted: KeyboardEvent | undefined
  await act(async () => {
    adopted = key(prompt, { key: 'Tab' })
  })
  expect(adopted?.defaultPrevented).toBe(true)
  expect(handle.getDraft()).toBe(examples[0])
  expect(prompt.selectionStart).toBe(examples[0].length)
  expect(prompt.selectionEnd).toBe(examples[0].length)
  expect(hint()).toBeNull()
  // With content there is nothing to adopt, so Tab navigates normally.
  await act(async () => {
    type(prompt, 'a scripted draft')
  })
  expect(key(prompt, { key: 'Tab' }).defaultPrevented).toBe(false)
  // Deleting the draft offers the suggestion again, ready to adopt.
  await act(async () => {
    type(prompt, '')
  })
  expect(hint()).not.toBeNull()
  let readopted: KeyboardEvent | undefined
  await act(async () => {
    readopted = key(prompt, { key: 'Tab' })
  })
  expect(readopted?.defaultPrevented).toBe(true)
  expect(handle.getDraft()).toBe(examples[0])
})

it('adopts a visible suggestion from a Tab pressed outside the input', async () => {
  vi.useFakeTimers()
  const examples = ['Review the sample patch.'] as const
  const { host, prompt, handle } = mount(
    { examplePrompts: examples },
    { ...idle, input: { ...idle.input, exampleHint: true } },
  )
  expect(host.querySelector('.composer-example-hint')).not.toBeNull()
  // An editable field elsewhere keeps Tab for itself.
  const field = document.createElement('input')
  document.body.append(field)
  field.focus()
  let kept: KeyboardEvent | undefined
  await act(async () => {
    kept = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    field.dispatchEvent(kept)
  })
  expect(kept?.defaultPrevented).toBe(false)
  expect(handle.getDraft()).toBe('')
  // The page, not the textarea, has focus — the case where Tab used to move focus instead.
  field.remove()
  prompt.blur()
  let pressed: KeyboardEvent | undefined
  await act(async () => {
    pressed = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.body.dispatchEvent(pressed)
  })
  expect(pressed?.defaultPrevented).toBe(true)
  expect(handle.getDraft()).toBe(examples[0])
  expect(document.activeElement).toBe(prompt)
})

it('stops on typing, resumes as soon as the draft is empty, and keeps Escape dismissal', async () => {
  vi.useFakeTimers()
  const { host, prompt, handle } = mount(
    { examplePrompts: ['Review the patch.'] },
    { ...idle, input: { ...idle.input, exampleHint: true } },
  )
  const hint = () => host.querySelector('.composer-example-hint')
  await act(async () => {
    prompt.focus()
    type(prompt, 'my task')
  })
  await act(async () => vi.advanceTimersByTime(5000))
  expect(hint()).toBeNull()
  expect(prompt.value).toBe('my task')
  expect(handle.getDraft()).toBe('my task')
  // Deleting the draft while still focused brings the suggestion back and Tab can adopt it.
  await act(async () => {
    type(prompt, '')
  })
  expect(hint()).not.toBeNull()
  expect(key(prompt, { key: 'Tab' }).defaultPrevented).toBe(true)
  // Escape is the person closing it: typing and deleting again must not reopen it.
  await act(async () => {
    key(prompt, { key: 'Escape' })
  })
  expect(hint()).toBeNull()
  await act(async () => {
    type(prompt, 'again')
  })
  await act(async () => {
    type(prompt, '')
  })
  expect(hint()).toBeNull()
  expect(key(prompt, { key: 'Tab' }).defaultPrevented).toBe(false)
  await act(async () =>
    handle.restoreAttachmentBlocks([
      { type: 'file', name: 'notes.txt', data: 'aGVsbG8=', mimeType: 'text/plain' },
    ]),
  )
  expect(hint()).toBeNull()
  expect(key(prompt, { key: 'Tab' }).defaultPrevented).toBe(false)
})

it('uses the normal accessible placeholder and ordinary Tab under reduced motion', async () => {
  const original = window.matchMedia.bind(window)
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const media = original(query)
    Object.defineProperty(media, 'matches', { value: query === '(prefers-reduced-motion: reduce)' })
    return media
  })
  const { host, prompt } = mount(
    { examplePrompts: ['Review the patch.'] },
    { ...idle, input: { ...idle.input, exampleHint: true } },
  )
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  expect(prompt.placeholder).toBe(idle.input.placeholder)
  expect(key(prompt, { key: 'Tab' }).defaultPrevented).toBe(false)
})

it('uses the shared ghost seam for live follow-up hints and invalidates dismissed, switched and stale turns', async () => {
  let invalidate: (() => void) | undefined
  const subscribeHintInvalidation = (listener: () => void) => {
    invalidate = listener
    return () => {
      invalidate = undefined
    }
  }
  const loads: Array<{ resolve(value: string): void; signal: AbortSignal }> = []
  const loadHint = vi.fn(
    (_scope, signal: AbortSignal) => new Promise<string>((resolve) => loads.push({ resolve, signal })),
  )
  const { host, prompt, handle, props } = mount({
    dependencies: { ...dependencies, loadHint, subscribeHintInvalidation },
  } as Partial<ComposerProps>)
  expect(loads).toHaveLength(0)
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  expect(key(prompt, { key: 'Enter' }).defaultPrevented).toBe(true)
  expect(props.onSubmit).not.toHaveBeenCalled()
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 1, completed: false } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 1, completed: true } },
    }),
  )
  await act(async () => {
    loads[0]?.resolve('What should I verify next?')
  })
  expect(host.querySelector('.composer-example-hint')?.textContent).toContain('What should I verify next?')
  expect(prompt.getAttribute('aria-describedby')).toContain('composer-suggestion')
  expect(host.querySelector('#composer-suggestion')?.textContent).toContain('What should I verify next?')
  await act(async () => {
    key(prompt, { key: 'Escape' })
    prompt.blur()
  })
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 2, completed: false } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 2, completed: true } },
    }),
  )
  await act(async () => {
    loads[1]?.resolve('Can we test this?')
  })
  await act(async () => {
    key(prompt, { key: 'Tab' })
  })
  expect(handle.getDraft()).toBe('Can we test this?')
  expect(prompt.selectionStart).toBe('Can we test this?'.length)
  expect(prompt.selectionEnd).toBe('Can we test this?'.length)
  await act(async () => {
    handle.setDraft('')
  })
  // Adopting pauses the hint only while the draft has content; an empty draft offers it again.
  expect(host.querySelector('.composer-example-hint')).not.toBeNull()
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 3, completed: false } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'a', turn: 3, completed: true } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'b', turn: 3, completed: true } },
    }),
  )
  await act(async () => {
    loads[2]?.resolve('stale?')
  })
  expect(loads[2]?.signal.aborted).toBe(true)
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  expect(loadHint).toHaveBeenCalledTimes(3)
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'b', turn: 4, completed: false } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'b', turn: 4, completed: true } },
    }),
  )
  await act(async () => {
    loads[3]?.resolve('What happens next?')
  })
  expect(host.querySelector('.composer-example-hint')).not.toBeNull()
  await act(async () => {
    type(prompt, 'my own question')
  })
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  await act(async () => {
    type(prompt, '')
  })
  // Deleting the draft clears the typing pause, so the same turn's suggestion returns.
  expect(host.querySelector('.composer-example-hint')).not.toBeNull()
  // Escape is a deliberate close and survives the emptied draft.
  await act(async () => {
    key(prompt, { key: 'Escape' })
  })
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  await act(async () => {
    type(prompt, 'ask again')
  })
  await act(async () => {
    type(prompt, '')
  })
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  // A newly mounted composer treats the existing successful turn as history.
  mount(
    { dependencies: { ...dependencies, loadHint } },
    { ...idle, input: { ...idle.input, hintScope: { sessionId: 'b', turn: 4, completed: true } } },
  )
  expect(loadHint).toHaveBeenCalledTimes(4)
  // Settings/provider changes invalidate a displayed or pending hint without requesting another.
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'b', turn: 5, completed: false } },
    }),
  )
  await act(async () =>
    handle.render({
      ...idle,
      input: { ...idle.input, hintScope: { sessionId: 'b', turn: 5, completed: true } },
    }),
  )
  await act(async () => {
    loads[4]?.resolve('Can we review this?')
  })
  expect(host.querySelector('.composer-example-hint')).not.toBeNull()
  await act(async () => {
    invalidate?.()
  })
  expect(host.querySelector('.composer-example-hint')).toBeNull()
  expect(loadHint).toHaveBeenCalledTimes(5)
})

it.each([
  'starting',
  'running',
  'waiting_approval',
  'paused',
  'disconnected',
  'idle',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const)('shows only usable child controls and labels follow-ups (%s)', (status) => {
  const active = !['completed', 'failed', 'cancelled'].includes(status)
  const working = status === 'starting' || status === 'running'
  const { host } = mount(
    {
      onChildControl: async () => {},
      dependencies: {
        ...dependencies,
        translate: (key, vars) =>
          (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
            String(vars?.[name] ?? name),
          ),
      },
    },
    {
      ...idle,
      children: [
        {
          id: 'child',
          parentId: 'parent',
          providerId: 'in-process',
          status,
          controls: { stop: working, continue: active },
          totalTokens: 15,
          durationMs: 1200,
        },
      ],
    },
  )
  expect(host.querySelector('[data-testid="child-stop"]') !== null).toBe(working)
  const steerToggle = host.querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')
  expect(steerToggle !== null).toBe(active)
  expect(host.querySelector('[data-testid="child-continue-message"]')).toBeNull()
  if (active) {
    act(() => {
      steerToggle?.click()
    })
    expect(host.querySelector('[data-testid="child-continue"]')?.textContent).toBe(working ? '发送' : '继续')
  } else {
    expect(host.querySelector('[data-testid="child-continue"]')).toBeNull()
  }
  const metrics = host.querySelector('[data-testid="child-control-metrics"]')?.textContent
  expect(metrics).toContain('15')
  expect(metrics).toContain('1.2')
  // The built-in provider reads as a subagent; the end of the id keeps two children apart.
  const name = host.querySelector('.composer-child-name')
  expect(name?.textContent).toBe('子智能体 · child')
  expect(name?.getAttribute('title')).toBe('child')
  // Status is stated in words first (never raw translation keys); the tag tone only backs it.
  const state = host.querySelector('[data-testid="child-control-row"] [role="status"]')
  expect(state?.textContent).toBe(
    {
      starting: '正在启动',
      running: '运行中',
      waiting_approval: '待审批',
      paused: '已暂停',
      disconnected: '已断开',
      idle: '空闲',
      completed: '已完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已停止',
    }[status],
  )
  expect(state?.getAttribute('data-tone')).toBe(
    {
      starting: 'info',
      running: 'info',
      waiting_approval: 'warn',
      paused: 'warn',
      disconnected: 'warn',
      idle: null,
      completed: 'ok',
      failed: 'bad',
      cancelled: null,
      interrupted: 'warn',
    }[status],
  )
  // The collapsed header always reports a non-blank status summary.
  const header = host.querySelector('[data-testid="child-control-tree"] .agh-disclosure-meta')
  expect(header?.textContent).toBe(
    working
      ? '1 个运行中'
      : status === 'waiting_approval' ||
          status === 'paused' ||
          status === 'disconnected' ||
          status === 'interrupted'
        ? '1 个待处理'
        : status === 'failed'
          ? '1 个失败'
          : '1 个已结束',
  )
  const input = host.querySelector('[data-testid="child-continue-message"]')
  expect(input !== null).toBe(active)
  if (active) {
    expect(input?.getAttribute('placeholder')).toBe('发给子代理的消息')
    expect(input?.getAttribute('aria-label')).toBe('发给子代理的消息')
  }
})

it('pins live children above folded idle and cancelled history and strips markdown from labels', () => {
  const { host } = mount(
    {
      onChildControl: async () => {},
      dependencies: {
        ...dependencies,
        translate: (key, vars) =>
          (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
            String(vars?.[name] ?? name),
          ),
      },
    },
    {
      ...idle,
      children: [
        {
          id: 'parent/old1',
          parentId: 'parent',
          providerId: 'in-process',
          label: '旧任务【北京】',
          status: 'idle',
          controls: { stop: false, continue: true },
          totalTokens: 100,
          durationMs: 2000,
        },
        {
          id: 'parent/new1',
          parentId: 'parent',
          providerId: 'in-process',
          label: '调研【北京】宜居情况。**重要：测试**',
          status: 'running',
          controls: { stop: true, continue: true },
          totalTokens: 200,
          durationMs: 3000,
        },
      ],
    },
  )
  expect(host.querySelector('[data-testid="child-control-tree"] .agh-disclosure-meta')?.textContent).toBe(
    '1 个运行中 · 1 个其他',
  )
  const topList = host.querySelector('.composer-children-list')
  expect(topList?.querySelectorAll('[data-testid="child-control-row"]')).toHaveLength(1)
  expect(topList?.querySelector('.composer-child-name')?.textContent).toBe('调研【北京】宜居情况。重要：测试')
  const history = host.querySelector('[data-testid="child-control-history"]')
  expect(history).not.toBeNull()
  expect(history?.hasAttribute('open')).toBe(false)
  expect(history?.textContent).toContain('空闲 / 已结束（1）')
})

it('asks the terminal panel for the child job when its name is clicked', () => {
  const view: ComposerView = {
    ...idle,
    children: [
      {
        id: 'parent/c1',
        parentId: 'parent',
        providerId: 'in-process',
        status: 'running',
        controls: { stop: true, continue: true },
        totalTokens: 0,
        durationMs: 0,
      },
    ],
  }
  const { host } = mount({ onChildControl: async () => {} }, view)
  const seen: unknown[] = []
  const listener = (event: Event) => seen.push((event as CustomEvent).detail)
  document.addEventListener('agnes:open-terminal-job', listener)
  try {
    const name = host.querySelector<HTMLButtonElement>('[data-testid="child-open"]')
    // The child is a job of this session; a session URL would name a session that cannot exist.
    expect(name?.classList.contains('composer-child-name')).toBe(true)
    expect(name?.classList.contains('agnes-ui-button')).toBe(true)
    expect(name?.tagName).toBe('BUTTON')
    expect(name?.hasAttribute('href')).toBe(false)
    name?.click()
    expect(seen).toEqual([{ childId: 'parent/c1' }])
  } finally {
    document.removeEventListener('agnes:open-terminal-job', listener)
  }
})

it.each([
  ['idle', 'pause'],
  ['paused', 'resume'],
  ['paused', 'close'],
  ['completed', 'recap'],
] as const)('routes %s child row action %s', async (status, action) => {
  const onChildControl = vi.fn(async () => {})
  const { host } = mount(
    { onChildControl },
    {
      ...idle,
      children: [
        {
          id: 'controlled-child',
          parentId: 'parent',
          providerId: 'in-process',
          status,
          controls: {
            stop: false,
            continue: false,
            pause: status === 'idle',
            resume: status === 'paused',
            close: status === 'paused',
          },
          totalTokens: 10,
          durationMs: 1200,
        },
      ],
    },
  )
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="child-${action}"]`)
  expect(button).not.toBeNull()
  await act(async () => button?.click())
  expect(onChildControl).toHaveBeenCalledWith('controlled-child', action, undefined, {
    commandId: expect.any(String),
  })
})

it('keeps idle ancestors with waiting_approval grandchildren out of history, preserves literal chars, formats unknown metrics and separates write from refresh', async () => {
  const retryRefresh = vi.fn(async () => {})
  const onChildControl = vi.fn(async () => ({ refreshFailed: 'network timeout', retryRefresh }))
  const zhTranslate = (key: string, vars?: Record<string, string | number>) =>
    (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(vars?.[name] ?? name),
    )
  const { host } = mount(
    {
      onChildControl,
      dependencies: { ...dependencies, translate: zhTranslate },
    },
    {
      ...idle,
      children: [
        {
          id: 'root/parent-a',
          parentId: 'root',
          providerId: 'in-process',
          label: '订单对账_g #42 (C# lane_1.txt)',
          status: 'idle',
          controls: { stop: false, continue: true },
          totalTokens: null,
          durationMs: null,
        },
        {
          id: 'root/parent-a/grandchild',
          parentId: 'root/parent-a',
          providerId: 'in-process',
          label: 'web_search `query` **bold**',
          status: 'waiting_approval',
          controls: { stop: true, continue: false },
          totalTokens: 0,
          durationMs: 0,
        },
        {
          id: 'root/finished-b',
          parentId: 'root',
          providerId: 'in-process',
          label: '已完成兄弟',
          status: 'completed',
          controls: { stop: false, continue: false },
          totalTokens: 50,
          durationMs: 1000,
        },
      ],
    },
  )
  // Header summarizes attention + settled without omitting pending grandchildren.
  expect(host.querySelector('[data-testid="child-control-tree"] .agh-disclosure-meta')?.textContent).toBe(
    '1 个待处理 · 2 个已结束',
  )
  // Active top list keeps idle parent-a AND its waiting_approval grandchild; only finished-b folds into history.
  const topList = host.querySelector('.composer-children-list')
  expect(topList?.querySelector('[data-child-id="root/parent-a"]')).not.toBeNull()
  expect(topList?.querySelector('[data-child-id="root/parent-a/grandchild"]')).not.toBeNull()
  const history = host.querySelector('[data-testid="child-control-history"]')
  expect(history?.querySelector('[data-child-id="root/finished-b"]')).not.toBeNull()
  expect(history?.querySelector('[data-child-id="root/parent-a/grandchild"]')).toBeNull()
  // Underscores and hashes are preserved while paired markdown markers are stripped.
  const parentRow = topList?.querySelector('[data-child-id="root/parent-a"]') as HTMLElement
  const grandchildRow = topList?.querySelector('[data-child-id="root/parent-a/grandchild"]') as HTMLElement
  expect(parentRow.querySelector('.composer-child-title')?.textContent).toBe('订单对账_g #42 (C# lane_1.txt)')
  expect(grandchildRow.querySelector('.composer-child-title')?.textContent).toBe('web_search query bold')
  // Null/null metrics render natural language instead of "未知 · 未知s"; known zeros stay visible.
  expect(parentRow.querySelector('[data-testid="child-control-metrics"]')?.textContent).toBe('暂无用量')
  expect(grandchildRow.querySelector('[data-testid="child-control-metrics"]')?.textContent).toContain('0.0s')
  // Accessible button labels include task context.
  const steerToggle = parentRow.querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')
  expect(steerToggle?.getAttribute('aria-label')).toContain('订单对账_g #42')
  // Write succeeds + refresh fails: clears draft, shows read-only refresh warning, retry does not re-send write.
  act(() => steerToggle?.click())
  const input = parentRow.querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!
  expect(input.getAttribute('aria-label')).toContain('订单对账_g #42')
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, '继续核对')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const sendBtn = parentRow.querySelector<HTMLButtonElement>('[data-testid="child-continue"]')!
  await act(async () => sendBtn.click())
  expect(onChildControl).toHaveBeenCalledTimes(1)
  expect(parentRow.querySelector('[data-testid="child-continue-message"]')).toBeNull()
  expect(parentRow.querySelector('[data-testid="child-refresh-warning"]')?.textContent).toContain(
    '操作已提交',
  )
  const retryBtn = parentRow.querySelector<HTMLButtonElement>('[data-testid="child-refresh-retry"]')!
  await act(async () => retryBtn.click())
  expect(retryRefresh).toHaveBeenCalledTimes(1)
  expect(onChildControl).toHaveBeenCalledTimes(1)
  expect(parentRow.querySelector('[data-testid="child-refresh-warning"]')).toBeNull()
})

it('pins continuable interrupted grandchildren in active tree, disambiguates duplicate names by short ID and reuses commandId on retry', async () => {
  const onChildControl = vi
    .fn()
    .mockRejectedValueOnce(new Error('network ack lost'))
    .mockRejectedValueOnce(new Error('still failing'))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
  const zhTranslate = (key: string, vars?: Record<string, string | number>) =>
    (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) =>
      String(vars?.[name] ?? name),
    )
  const { host } = mount(
    {
      onChildControl,
      dependencies: { ...dependencies, translate: zhTranslate },
    },
    {
      ...idle,
      children: [
        {
          id: 'root/parent-x',
          parentId: 'root',
          providerId: 'in-process',
          label: '同名调研任务',
          status: 'idle',
          controls: { stop: false, continue: true },
          totalTokens: 100,
          durationMs: 1000,
        },
        {
          id: 'root/parent-x/736YNQ',
          parentId: 'root/parent-x',
          providerId: 'in-process',
          label: '同名调研任务',
          status: 'interrupted',
          controls: { stop: false, continue: true },
          totalTokens: 20,
          durationMs: 500,
        },
        {
          id: 'root/998ABC',
          parentId: 'root',
          providerId: 'in-process',
          label: '同名调研任务',
          status: 'paused',
          controls: { stop: false, continue: true, resume: true },
          totalTokens: 30,
          durationMs: 600,
        },
        {
          id: 'root/dead-stop',
          parentId: 'root',
          providerId: 'in-process',
          label: '不可继续中断任务',
          status: 'interrupted',
          controls: { stop: false, continue: false },
          totalTokens: 10,
          durationMs: 400,
        },
      ],
    },
  )

  // Continuable interrupted grandchild keeps its idle ancestor in the active list; non-continuable interrupted folds into history.
  const topList = host.querySelector('.composer-children-list')!
  expect(topList.querySelector('[data-child-id="root/parent-x"]')).not.toBeNull()
  expect(topList.querySelector('[data-child-id="root/parent-x/736YNQ"]')).not.toBeNull()
  expect(topList.querySelector('[data-child-id="root/998ABC"]')).not.toBeNull()
  const history = host.querySelector('[data-testid="child-control-history"]')!
  expect(history.querySelector('[data-child-id="root/dead-stop"]')).not.toBeNull()
  expect(history.querySelector('[data-child-id="root/parent-x/736YNQ"]')).toBeNull()
  expect(host.querySelector('[data-testid="child-control-tree"] .agh-disclosure-meta')?.textContent).toBe(
    '2 个待处理 · 2 个已结束',
  )

  // Identically named tasks carry distinct short IDs in every button's accessible label while keeping testids intact.
  const firstNamed = topList.querySelector<HTMLElement>('[data-child-id="root/parent-x/736YNQ"]')!
  const secondNamed = topList.querySelector<HTMLElement>('[data-child-id="root/998ABC"]')!
  expect(firstNamed.querySelector('[data-testid="child-open"]')?.getAttribute('aria-label')).toContain(
    '736YNQ · 同名调研任务',
  )
  expect(secondNamed.querySelector('[data-testid="child-open"]')?.getAttribute('aria-label')).toContain(
    '998ABC · 同名调研任务',
  )
  expect(firstNamed.querySelector('[data-testid="child-steer-toggle"]')?.getAttribute('aria-label')).toBe(
    '继续：736YNQ · 同名调研任务',
  )
  expect(secondNamed.querySelector('[data-testid="child-resume"]')?.getAttribute('aria-label')).toBe(
    '恢复：998ABC · 同名调研任务',
  )

  // Retrying the same draft after a lost write receipt reuses the exact commandId; editing the draft rotates it.
  act(() => firstNamed.querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')?.click())
  const input = firstNamed.querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!
  expect(input.getAttribute('aria-label')).toContain('736YNQ · 同名调研任务')
  const setInputValue = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  act(() => setInputValue('继续处理'))
  const sendBtn = firstNamed.querySelector<HTMLButtonElement>('[data-testid="child-continue"]')!
  expect(sendBtn.getAttribute('aria-label')).toBe('继续：736YNQ · 同名调研任务')
  await act(async () => sendBtn.click())
  // Write failed: draft stays open so user can retry with the same commandId.
  expect(firstNamed.querySelector('[data-testid="child-continue-message"]')).not.toBeNull()
  await act(async () => sendBtn.click())
  const firstCmdId = (onChildControl.mock.calls[0]?.[3] as { commandId?: string } | undefined)?.commandId
  const retryCmdId = (onChildControl.mock.calls[1]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(firstCmdId).toBeTruthy()
  expect(retryCmdId).toBe(firstCmdId)
  // Editing the draft rotates to a new commandId, and once confirmed the draft clears.
  act(() => setInputValue('继续处理（修改后）'))
  await act(async () => sendBtn.click())
  const editedCmdId = (onChildControl.mock.calls[2]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(editedCmdId).toBeTruthy()
  expect(editedCmdId).not.toBe(firstCmdId)
  expect(firstNamed.querySelector('[data-testid="child-continue-message"]')).toBeNull()
  act(() => firstNamed.querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')?.click())
  const nextInput = firstNamed.querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(nextInput, '继续处理（修改后）')
    nextInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () =>
    firstNamed.querySelector<HTMLButtonElement>('[data-testid="child-continue"]')?.click(),
  )
  const nextCmdId = (onChildControl.mock.calls[3]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(nextCmdId).toBeTruthy()
  expect(nextCmdId).not.toBe(editedCmdId)
})

it('preserves pending commandId for recap and continue when a row remounts between active and folded history groups', async () => {
  const onChildControl = vi
    .fn()
    .mockRejectedValueOnce(new Error('recap receipt lost'))
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('continue receipt lost'))
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined)
  const oldChild = {
    id: 'root/old',
    parentId: 'root',
    providerId: 'in-process',
    label: 'Old task',
    status: 'idle' as const,
    controls: { stop: false, continue: true },
    totalTokens: 0,
    durationMs: 100,
  }
  const runningSibling = {
    ...oldChild,
    id: 'root/sibling',
    label: 'Active sibling',
    status: 'running' as const,
    controls: { stop: true, continue: true },
  }
  const view: ComposerView = { ...idle, children: [oldChild] }
  const { host, handle } = mount({ onChildControl }, view)

  // 1. Recap fails in top active group, row moves into folded history when a running sibling arrives,
  //    then user retries Recap in history: both calls carry the exact same commandId.
  const recapBtn = () =>
    host.querySelector<HTMLButtonElement>('[data-child-id="root/old"] [data-testid="child-recap"]')!
  expect(host.querySelector('.composer-children-list [data-child-id="root/old"]')).not.toBeNull()
  expect(host.querySelector('[data-testid="child-control-history"]')).toBeNull()
  await act(async () => recapBtn().click())
  await act(async () => handle.render({ ...view, children: [oldChild, runningSibling] }))
  const history = host.querySelector('[data-testid="child-control-history"]')
  expect(history).not.toBeNull()
  expect(history?.querySelector('[data-child-id="root/old"]')).not.toBeNull()
  expect(
    host.querySelector('.composer-children-list')?.querySelector('[data-child-id="root/old"]'),
  ).toBeNull()
  await act(async () => recapBtn().click())
  const recapFirstId = (onChildControl.mock.calls[0]?.[3] as { commandId?: string } | undefined)?.commandId
  const recapRetryId = (onChildControl.mock.calls[1]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(recapFirstId).toBeTruthy()
  expect(recapRetryId).toBe(recapFirstId)

  // 2. Continue fails while row is in folded history, sibling finishes so row remounts back into the
  //    top active group, then user retries the exact same draft: both calls carry the exact same commandId.
  const row = () => host.querySelector<HTMLElement>('[data-child-id="root/old"]')!
  const setValue = (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  act(() => row().querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')?.click())
  act(() =>
    setValue(
      row().querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!,
      'same follow-up',
    ),
  )
  await act(async () => row().querySelector<HTMLButtonElement>('[data-testid="child-continue"]')?.click())

  await act(async () =>
    handle.render({
      ...view,
      children: [
        oldChild,
        { ...runningSibling, status: 'completed', controls: { stop: false, continue: false } },
      ],
    }),
  )
  expect(host.querySelector('[data-testid="child-control-history"]')).toBeNull()
  expect(host.querySelector('.composer-children-list > [data-child-id="root/old"]')).not.toBeNull()
  act(() => row().querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')?.click())
  act(() =>
    setValue(
      row().querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!,
      'same follow-up',
    ),
  )
  await act(async () => row().querySelector<HTMLButtonElement>('[data-testid="child-continue"]')?.click())
  const contFirstId = (onChildControl.mock.calls[2]?.[3] as { commandId?: string } | undefined)?.commandId
  const contRetryId = (onChildControl.mock.calls[3]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(contFirstId).toBeTruthy()
  expect(contRetryId).toBe(contFirstId)

  // 3. After confirmation succeeds, sending the same draft again allocates a new commandId.
  act(() => row().querySelector<HTMLButtonElement>('[data-testid="child-steer-toggle"]')?.click())
  act(() =>
    setValue(
      row().querySelector<HTMLInputElement>('[data-testid="child-continue-message"]')!,
      'same follow-up',
    ),
  )
  await act(async () => row().querySelector<HTMLButtonElement>('[data-testid="child-continue"]')?.click())
  const contFreshId = (onChildControl.mock.calls[4]?.[3] as { commandId?: string } | undefined)?.commandId
  expect(contFreshId).toBeTruthy()
  expect(contFreshId).not.toBe(contFirstId)
})
