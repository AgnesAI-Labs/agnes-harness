/** @vitest-environment happy-dom */

import type { UsageView } from '@agnes/protocol'
import { createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPOSER_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

const usage: UsageView = {
  totals: { input: 12, output: 8, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  reasoningComplete: true,
  billingComplete: true,
  context: { tokens: 128, window: 8192, autoCompact: true, source: 'estimated' },
  model: { route: 'local', id: 'model-a', thinking: 'off', maxTokens: 1024 },
}

describe('rendered composer region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
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
    handle?.render({
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
    })

    const composer = document.querySelector<HTMLFormElement>('#composer')
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')
    expect(composer?.closest('[data-slot="ui:composer"]')).toBeTruthy()
    expect(composer?.getAttribute('data-agnes-region')).toBe('composer')
    expect(prompt?.getAttribute('data-agnes-region')).toBe('composer-input')
    expect(prompt?.disabled).toBe(false)
    expect(document.querySelector('#composer-workspace')).toBeTruthy()
    expect(document.querySelector('#composer-permission')).toBeTruthy()
    expect(document.querySelector('#model')).toBeTruthy()
    expect(document.querySelector<HTMLElement>('#session-usage')?.hidden).toBe(false)

    if (!prompt) throw new Error('missing composer input')
    prompt.value = '键盘提交'
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
  })

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
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('#shadow-composer')?.textContent).toBe('替换输入区')
    expect(document.querySelector('#composer')).toBeNull()
    expect(document.querySelector('#prompt')).toBeNull()

    remove()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(document.querySelector('#composer')).toBeTruthy()
    expect(document.querySelector<HTMLTextAreaElement>('#prompt')?.value).toBe('保留草稿')
    expect(document.querySelector('#session-usage')).toBeTruthy()
  })

  it('places session input DSH contributions alongside the native composer controls', async () => {
    runtime = await mountRenderedIndex()
    const removeLeft = runtime.registry.register(
      { name: 'conversation.input.left', id: 'fixture-input-left', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-input-left-content' }, '左侧扩展'),
    )
    const removeOverlay = runtime.registry.register(
      { name: 'conversation.input.overlay', id: 'fixture-input-overlay', owner: 'fixture' },
      () => createElement('span', { id: 'fixture-input-overlay-content' }, '输入层扩展'),
    )
    runtime.registry.setSession('session-1')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(document.querySelector('#fixture-input-left-content')?.closest('.composer-controls')).toBeTruthy()
    expect(document.querySelector('#fixture-input-overlay-content')?.closest('#composer')).toBeTruthy()
    expect(document.querySelector('#composer-workspace')).toBeTruthy()
    expect(document.querySelector('#send')).toBeTruthy()
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
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(
      document.querySelector('#fixture-composer-dock-content')?.closest('[data-agnes-composer-dock]'),
    ).toBeTruthy()
    expect(document.querySelector('#send')).toBeTruthy()
    remove()
  })
})
