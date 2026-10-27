/** @vitest-environment happy-dom */

import { type UsageView, userImagePolicy } from '@agnes/protocol'
import { setDisclosureOpen } from '@agnes/web-ui'
import type { ComposerView } from '@agnes/web-units'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMPOSER_SLOT } from '../src/region-slots.js'
import { fakeVoice } from './helpers/fake-voice.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const imagePngData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const imagePngBytes = Uint8Array.from(atob(imagePngData), (character) => character.charCodeAt(0))

const usage: UsageView = {
  totals: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  context: { tokens: 128, window: 8192, autoCompact: true, source: 'estimated' },
  model: { route: 'local', id: 'model-a', thinking: 'off', maxTokens: 1024 },
}

const readyView: ComposerView = {
  imagePolicy: userImagePolicy({ input: ['text', 'image'] }),
  cancel: { disabled: true, hidden: true, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' },
  input: { disabled: false, placeholder: '描述你想完成的事…' },
  loading: false,
  model: {
    accessibleName: '当前会话模型：model-a',
    disabled: false,
    label: 'model-a',
    options: [{ route: 'local', id: 'model-a', label: '本地模型' }],
    pending: false,
    selected: { route: 'local', id: 'model-a' },
  },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: false, label: '发送', mode: 'idle', title: '发送（Enter）' },
  stopping: false,
  usage,
  workspace: { disabled: false, label: 'agnes', title: '/workspace/agnes' },
}

// A slot contribution renders in well under half a second, but under a loaded runner an
// occasional commit takes longer than vi.waitFor's default one second.
const slotRender = { timeout: 5_000 }
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

describe('rendered composer region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    localStorage.clear()
    resetWebDom()
    if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL)
    else Reflect.deleteProperty(URL, 'createObjectURL')
    if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL)
    else Reflect.deleteProperty(URL, 'revokeObjectURL')
  })

  it('renders the complete composer through its public handle and keeps native keyboard submit', async () => {
    const submitted: string[] = []
    const drafts: string[] = []
    runtime = await mountRenderedIndex({
      composer: {
        onDraftChange: (value) => drafts.push(value),
        onSubmit: () => submitted.push('submit'),
      },
    })
    const handle = runtime.composer
    expect(handle).toBeDefined()
    handle?.render(readyView)

    const composer = document.querySelector<HTMLFormElement>('#composer')
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
    expect(composer?.closest('[data-slot="ui:composer"]')).toBeTruthy()
    expect(composer?.getAttribute('data-agnes-region')).toBe('composer')
    expect(prompt?.getAttribute('data-agnes-region')).toBe('composer-input')
    expect(prompt?.disabled).toBe(false)
    expect(document.querySelector('#composer-workspace')).toBeTruthy()
    expect(document.querySelector('#composer-permission')).toBeTruthy()
    expect(document.querySelector('#model')).toBeTruthy()
    const fileInput = document.querySelector<HTMLInputElement>('[data-testid="attachment-file-input"]')
    expect(fileInput?.type).toBe('file')
    expect(fileInput?.hidden).toBe(true)
    expect(fileInput?.multiple).toBe(true)
    // The gauge sits in the card's control row, right before the model picker it measures.
    const usage = document.querySelector<HTMLElement>('#session-usage')
    expect(usage?.hidden).toBe(false)
    expect(usage?.closest('.composer-controls')).toBeTruthy()
    expect(usage?.closest('.composer-meta')).toBeNull()
    expect(usage?.nextElementSibling?.classList.contains('model-field')).toBe(true)
    expect(usage?.querySelector('.usage-ring')).toBeTruthy()
    expect(document.querySelector('.usage-percent')?.textContent).toBe('2%')
    handle?.render({ ...readyView, readOnly: true, workspace: { ...readyView.workspace, visible: false } })
    expect(document.querySelector('.model-field')).toBeNull()
    expect(document.querySelector('#composer-permission')).toBeNull()
    expect(document.querySelector('#composer-workspace')?.hasAttribute('hidden')).toBe(true)
    expect(prompt?.disabled).toBe(true)
    expect(prompt?.placeholder).toContain('read-only')
    expect(document.querySelector('#send')?.hasAttribute('hidden')).toBe(true)
    composer?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    expect(submitted).toEqual([])
    handle?.render(readyView)
    expect(document.querySelector('#send')?.hasAttribute('hidden')).toBe(false)

    if (!prompt) throw new Error('missing composer input')
    // The draft is React state: write through the native setter so the input event reads as typing.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(prompt, '键盘提交')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    prompt.focus()
    const enter = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      keyCode: 13,
    })
    prompt.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(drafts).toEqual(['键盘提交'])
    expect(submitted).toEqual(['submit'])
    expect(document.activeElement).toBe(prompt)
    const newline = new KeyboardEvent('keydown', {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      keyCode: 13,
      shiftKey: true,
    })
    prompt.dispatchEvent(newline)
    expect(newline.defaultPrevented).toBe(false)
    expect(submitted).toEqual(['submit'])
    expect(document.activeElement).toBe(prompt)
  })

  it('clears session-scoped attachments and revokes their preview when the session changes', async () => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:session-image'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const onError = vi.fn()
    runtime = await mountRenderedIndex({ composer: { onError } })
    const skillPrompt = 'Use $fixture-skill to review this attachment'
    runtime.composer?.setDraft(skillPrompt)
    // The standalone fixture starts disconnected; app.ts normally supplies this model/input state.
    runtime.composer?.render(readyView)
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('composer input is missing')
    const pasted = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasted, 'clipboardData', {
      value: {
        files: [new File([imagePngBytes], 'one.png', { type: 'image/png' })],
        items: [],
        getData: () => '',
      },
    })
    prompt.dispatchEvent(pasted)
    await vi.waitFor(
      () =>
        expect(runtime?.composer?.getImageBlocks()).toEqual([
          { type: 'image', mimeType: 'image/png', data: imagePngData },
        ]),
      slotRender,
    )
    expect(onError).not.toHaveBeenCalled()
    expect(runtime.composer?.getDraft()).toBe(skillPrompt)
    expect(prompt.value).toBe(skillPrompt)

    runtime.session.setSession('another-session')

    await vi.waitFor(() => expect(runtime?.composer?.getImageBlocks()).toHaveLength(0), slotRender)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:session-image')
  })

  it('preserves context interaction across connection updates, session clear, DSH replacement and disposal', async () => {
    const added = vi.spyOn(document, 'addEventListener')
    const removed = vi.spyOn(document, 'removeEventListener')
    try {
      localStorage.setItem('agnes-locale', 'zh-CN')
      runtime = await mountRenderedIndex()
      const render = (next: Partial<ComposerView>) =>
        runtime?.composer?.render({
          ...readyView,
          usage: { ...usage, context: { ...usage.context, tokens: Math.ceil(usage.context.window * 0.6) } },
          ...next,
        })
      const host = () => required(document.querySelector<HTMLElement>('#session-usage'))
      expect(host().hidden).toBe(true)
      render({})
      const details = required(host().querySelector<HTMLElement>('.agh-disclosure'))
      const summary = required(details.querySelector<HTMLElement>('.agh-disclosure-summary'))
      setDisclosureOpen(details, true)
      summary.focus()
      render({ connected: false, sending: true })
      render({ connected: false })
      expect(host().querySelector<HTMLElement>('.agh-disclosure')).toBe(details)
      expect(details.dataset.open).toBe('true')
      expect(document.activeElement).toBe(summary)
      expect(host().textContent).toContain('上次同步')
      required(host().querySelector<HTMLElement>('.usage-popover')).click()
      expect(details.dataset.open).toBe('true')
      document.body.click()
      expect(details.dataset.open).toBe('false')
      setDisclosureOpen(details, true)
      render({ usage: undefined })
      runtime.registry.setSession('another-session')
      expect(host().hidden).toBe(true)
      expect(details.dataset.open).toBe('false')
      expect(host().querySelectorAll('dt')).toHaveLength(0)
      render({
        usage: {
          ...usage,
          context: { ...usage.context, tokens: 0, autoCompact: false },
          model: { route: 'local', id: 'next', thinking: 'off' },
        },
      })
      expect(host().hidden).toBe(false)
      expect(host().textContent).toContain('0 Token')
      expect(host().textContent).not.toContain('1,024')
      expect(details.dataset.open).toBe('false')
      const removeShadow = runtime.registry.register(
        { name: COMPOSER_SLOT as string, id: 'usage-shadow', owner: 'fixture', priority: -1 },
        () => createElement('div', null, 'shadow'),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(details.isConnected).toBe(false)
      removeShadow()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(host().querySelector<HTMLElement>('.agh-disclosure')).not.toBe(details)
      expect(host().textContent).toContain('0 Token')
      const restored = required(host().querySelector<HTMLElement>('.agh-disclosure'))
      expect(restored.dataset.open).toBe('false')
      await runtime.dispose()
      runtime = undefined
      expect(restored.isConnected).toBe(false)
      // Each open panel listened for outside clicks, and none of those listeners outlives it.
      const clicks = added.mock.calls.filter(([event]) => event === 'click')
      expect(clicks.length).toBeGreaterThanOrEqual(2)
      for (const [, listener] of clicks)
        expect(
          removed.mock.calls.some(([event, callback]) => event === 'click' && callback === listener),
        ).toBe(true)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it.each([false, true])(
    'edits a local draft while opening (read-only preview: %s) and refuses submission and attachments',
    async (readOnly) => {
      const submitted = vi.fn()
      runtime = await mountRenderedIndex({ composer: { onSubmit: submitted } })
      const handle = runtime.composer
      handle?.render({
        ...readyView,
        loading: true,
        readOnly,
        input: { ...readyView.input, disabled: false },
        send: { ...readyView.send, disabled: true },
      })
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
      if (!prompt) throw new Error('missing input')
      expect(prompt.disabled).toBe(false)
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        prompt,
        'Local draft',
      )
      prompt.dispatchEvent(new Event('input', { bubbles: true }))
      prompt.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 13 }),
      )
      expect(handle?.getDraft()).toBe('Local draft')
      expect(submitted).not.toHaveBeenCalled()
      expect(
        document.querySelector<HTMLInputElement>('[data-testid="attachment-file-input"]')?.disabled,
      ).toBe(true)
      handle?.render(readyView)
      expect(handle?.getDraft()).toBe('Local draft')
      prompt.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', keyCode: 13 }),
      )
      expect(submitted).toHaveBeenCalledOnce()
    },
  )

  it('restores the component and current draft after a composer shadow unloads', async () => {
    runtime = await mountRenderedIndex()
    runtime.composer?.render({
      cancel: { disabled: true, hidden: true, label: '停止' },
      connected: true,
      configured: true,
      hasSession: true,
      hint: { kind: 'shortcut', text: 'Enter 发送，Shift+Enter 换行' },
      input: { disabled: false, placeholder: '描述你想完成的事…' },
      loading: false,
      model: {
        accessibleName: '选择当前会话模型',
        disabled: true,
        label: '选择模型',
        options: [],
        pending: false,
      },
      permission: { disabled: true, pending: false, selected: 'workspace' },
      sending: false,
      send: { disabled: true, label: '发送', mode: 'idle', title: '发送（Enter）' },
      stopping: false,
      usage: undefined,
      workspace: { disabled: false, label: 'agnes', title: '/workspace/agnes' },
    })
    runtime.composer?.setDraft('保留草稿')
    const remove = runtime.registry.register(
      { name: COMPOSER_SLOT as string, id: 'fixture-composer-shadow', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'shadow-composer' }, '替换输入区'),
    )
    await vi.waitFor(() => {
      expect(document.querySelector('#shadow-composer')?.textContent).toBe('替换输入区')
      expect(document.querySelector('#composer')).toBeNull()
      expect(document.querySelector('#prompt')).toBeNull()
    }, slotRender)

    remove()
    await vi.waitFor(() => {
      expect(document.querySelector('#composer')).toBeTruthy()
      expect(document.querySelector<HTMLTextAreaElement>('#prompt')?.value).toBe('保留草稿')
      expect(document.querySelector('#session-usage')).toBeTruthy()
    }, slotRender)
  })

  it('places session input DSH contributions alongside the native composer controls', async () => {
    runtime = await mountRenderedIndex()
    const removeLeft = runtime.registry.register(
      { name: 'conversation.input.left', id: 'fixture-input-left', owner: 'fixture' },
      () =>
        createElement(
          'span',
          { id: 'fixture-input-left-content' },
          '左侧扩展',
          ...[1, 2, 3].map((index) =>
            createElement('button', { key: index, type: 'button' }, `Extra ${index}`),
          ),
          createElement('input', { id: 'fixture-extra-draft', defaultValue: 'keep draft' }),
        ),
    )
    const removeOverlay = runtime.registry.register(
      { name: 'conversation.input.overlay', id: 'fixture-input-overlay', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-input-overlay-content' }, '输入层扩展'),
    )
    // The page's session service is the source the registry is bound to. Setting the registry
    // directly races that binding: a region root that commits later binds the service and resets
    // the registry to the service's (empty) session, which hides every session-scoped entry.
    runtime.session.setSession('session-1')
    await vi.waitFor(() => {
      expect(document.querySelector('#fixture-input-left-content')?.closest('.composer-meta')).toBeTruthy()
      expect(document.querySelector('#fixture-input-overlay-content')?.closest('#composer')).toBeTruthy()
      expect(document.querySelector('#composer-workspace')).toBeTruthy()
      expect(document.querySelector('#send')).toBeTruthy()
    }, slotRender)
    await vi.waitFor(() =>
      expect(document.querySelector('.composer-extras')?.getAttribute('data-overflow')).toBe('true'),
    )
    const extras = required(document.querySelector<HTMLElement>('[data-testid="composer-extra-controls"]'))
    const extraDraft = required(document.querySelector<HTMLInputElement>('#fixture-extra-draft'))
    setDisclosureOpen(extras, true)
    extraDraft.value = 'unfinished plugin input'
    setDisclosureOpen(extras, false)
    setDisclosureOpen(extras, true)
    expect(document.querySelector('#fixture-extra-draft')).toBe(extraDraft)
    expect(extraDraft.value).toBe('unfinished plugin input')
    removeLeft()
    removeOverlay()
  })

  it('keeps composer dock contributions beside the native send controls', async () => {
    runtime = await mountRenderedIndex()
    runtime.session.setSession('session-composer-dock')
    const remove = runtime.registry.register(
      { name: 'conversation.composer.dock', id: 'fixture-composer-dock', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-composer-dock-content' }, '扩展 dock'),
    )
    await vi.waitFor(() => {
      expect(
        document.querySelector('#fixture-composer-dock-content')?.closest('[data-agnes-composer-dock]'),
      ).toBeTruthy()
      expect(document.querySelector('#send')).toBeTruthy()
    }, slotRender)
    remove()
  })

  it('renders the voice buttons before send only when the controls carry a voice port', async () => {
    runtime = await mountRenderedIndex()
    runtime.composer?.render(readyView)
    expect(document.querySelector('#send')).toBeTruthy()
    expect(document.querySelector('[data-testid="voice-mic"]')).toBeNull()
    await runtime.dispose()
    resetWebDom()
    const { voice } = fakeVoice()
    runtime = await mountRenderedIndex({ voice })
    runtime.composer?.render(readyView)
    const group = document.querySelector('#send')?.previousElementSibling
    expect(group?.querySelector('[data-testid="voice-mic"]')).toBeTruthy()
    expect(group?.querySelector('[data-testid="voice-wave"]')).toBeTruthy()
    document.querySelector<HTMLButtonElement>('[data-testid="voice-mic"]')?.click()
    expect(voice.toggleDictation).toHaveBeenCalledTimes(1)
    document.querySelector<HTMLButtonElement>('[data-testid="voice-wave"]')?.click()
    expect(voice.toggleConversation).toHaveBeenCalledTimes(1)
  })

  it('binds the composer so voice text lands in the draft and a session opens on demand', async () => {
    const prepareUploadSession = vi.fn(async () => 'session-new')
    const { voice, bound } = fakeVoice()
    runtime = await mountRenderedIndex({ voice, composer: { prepareUploadSession } })
    runtime.composer?.render(readyView)
    await vi.waitFor(() => expect(voice.bindComposer).toHaveBeenCalled())
    const composer = required(bound())
    composer.insertText('x')
    await vi.waitFor(() => expect(runtime?.composer?.getDraft()).toContain('x'))
    expect(await composer.ensureSession()).toBe('session-new')
    expect(prepareUploadSession).toHaveBeenCalledTimes(1)
    // With a session, the composer names it at once.
    runtime.session.setSession('session-1')
    await vi.waitFor(() => expect(runtime?.registry.sessionId).toBe('session-1'))
    expect(await required(bound()).ensureSession()).toBe('session-1')
    expect(prepareUploadSession).toHaveBeenCalledTimes(1)
  })

  it('keeps voice text that arrives while the composer is replaced', async () => {
    const { voice, bound } = fakeVoice()
    runtime = await mountRenderedIndex({ voice })
    runtime.composer?.render(readyView)
    await vi.waitFor(() => expect(voice.bindComposer).toHaveBeenCalled())
    const composer = required(bound())
    runtime.composer?.setDraft('前文')
    const remove = runtime.registry.register(
      { name: COMPOSER_SLOT as string, id: 'fixture-composer-shadow', owner: 'fixture', priority: -1 },
      () => createElement('div', { id: 'shadow-composer' }, '替换输入区'),
    )
    await vi.waitFor(() => expect(document.querySelector('#prompt')).toBeNull(), slotRender)
    composer.insertText('语音')
    expect(composer.submit()).toBe(false)
    remove()
    await vi.waitFor(
      () => expect(document.querySelector<HTMLTextAreaElement>('#prompt')?.value).toBe('前文语音'),
      slotRender,
    )
  })

  it('shows the voice buttons on the new-chat page before any session', async () => {
    const { voice } = fakeVoice()
    runtime = await mountRenderedIndex({ voice })
    expect(runtime.registry.sessionId).toBeUndefined()
    runtime.composer?.render({ ...readyView, hasSession: false })
    expect(document.querySelector('[data-testid="voice-mic"]')).toBeTruthy()
    expect(document.querySelector('[data-testid="voice-wave"]')).toBeTruthy()
  })

  it('explains a disabled voice button and links to its settings', async () => {
    const { voice } = fakeVoice({
      dictation: { visible: true, disabled: 'no-account', phase: 'idle', seconds: 0, level: 0 },
      conversation: { visible: false, phase: 'idle', level: 0 },
    })
    localStorage.setItem('agnes-locale', 'zh-CN')
    runtime = await mountRenderedIndex({ voice })
    runtime.composer?.render(readyView)
    const mic = required(document.querySelector<HTMLButtonElement>('[data-testid="voice-mic"]'))
    expect(mic.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('[data-testid="voice-wave"]')).toBeNull()
    mic.click()
    expect(voice.toggleDictation).not.toHaveBeenCalled()
    const configure = await vi.waitFor(() =>
      required(document.querySelector<HTMLButtonElement>('[data-testid="voice-configure"]')),
    )
    expect(configure.closest('.voice-reason')?.textContent).toContain('还没有语音账户')
    configure.click()
    expect(voice.openSettings).toHaveBeenCalledTimes(1)
  })

  it('shows the recording time, the conversation phase and a notice in the voice group', async () => {
    const { voice } = fakeVoice({
      dictation: { visible: true, phase: 'recording', seconds: 7, level: 3 },
      conversation: { visible: true, phase: 'idle', level: 0 },
      notice: { key: 'empty', at: 1 },
    })
    localStorage.setItem('agnes-locale', 'zh-CN')
    runtime = await mountRenderedIndex({ voice })
    runtime.composer?.render(readyView)
    const mic = required(document.querySelector<HTMLElement>('[data-testid="voice-mic"]'))
    expect(mic.getAttribute('data-level')).toBe('3')
    expect(document.querySelector('.composer-voice-status')?.textContent).toContain('7')
    const notice = required(document.querySelector('[data-testid="voice-notice"]'))
    expect(notice.getAttribute('role')).toBe('status')
    expect(notice.closest('.composer-voice')).toBeTruthy()
    expect(notice.textContent).toBe('没听清，请再说一次')
  })
})

function required<T>(value: T | null): T {
  if (value === null) throw new Error('missing fixture element')
  return value
}
