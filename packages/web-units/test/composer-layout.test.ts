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

it.each(['running', 'idle', 'interrupted', 'completed', 'failed', 'cancelled'] as const)(
  'shows only usable child controls and labels follow-ups (%s)',
  (status) => {
    const active = !['completed', 'failed', 'cancelled'].includes(status)
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
            controls: { stop: status === 'running', continue: active },
            totalTokens: 15,
            durationMs: 1200,
          },
        ],
      },
    )
    expect(host.querySelector('[data-testid="child-stop"]') !== null).toBe(status === 'running')
    expect(host.querySelector('[data-testid="child-continue"]') !== null).toBe(active)
    const metrics = host.querySelector('[data-testid="child-control-metrics"]')?.textContent
    expect(metrics).toContain('15')
    expect(metrics).toContain('1.2')
    // The built-in provider reads as a subagent; the end of the id keeps two children apart.
    const name = host.querySelector('.composer-child-name')
    expect(name?.textContent).toBe('子智能体 · child')
    expect(name?.getAttribute('title')).toBe('child')
    // Status is stated in words first; the tag tone only backs it.
    const state = host.querySelector('[data-testid="child-control-row"] [role="status"]')
    expect(state?.textContent).toBe(
      {
        running: '运行中',
        idle: '空闲',
        interrupted: '已停止',
        completed: '已完成',
        failed: '失败',
        cancelled: '已取消',
      }[status as 'running'],
    )
    expect(state?.getAttribute('data-tone')).toBe(
      { running: 'info', idle: null, interrupted: 'warn', completed: 'ok', failed: 'bad', cancelled: null }[
        status as 'running'
      ],
    )
    // The collapsed header still states how much of the tree is working.
    const header = host.querySelector('[data-testid="child-control-tree"] .agh-disclosure-meta')
    expect(header?.textContent ?? null).toBe(status === 'running' ? '1 个运行中' : null)
    const input = host.querySelector('[data-testid="child-continue-message"]')
    expect(input !== null).toBe(active)
    if (active) {
      expect(input?.getAttribute('placeholder')).toBe('发给子代理的消息')
      expect(input?.getAttribute('aria-label')).toBe('发给子代理的消息')
    }
  },
)

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
