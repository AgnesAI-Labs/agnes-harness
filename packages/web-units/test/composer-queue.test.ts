/** @vitest-environment happy-dom */
import { createRegionRenderer, type RegionRenderer } from '@agnes/web-ui'
import { createElement, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposerProps } from '../src/composer/contracts.js'
import {
  Composer,
  type ComposerDependencies,
  type ComposerHandle,
  type ComposerView,
} from '../src/composer.js'
import { webUnitsLocaleCatalog } from '../src/locales/index.js'

const translate: ComposerDependencies['translate'] = (key, vars) =>
  (webUnitsLocaleCatalog['zh-CN'][key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) =>
    vars && Object.hasOwn(vars, name) ? String(vars[name]) : match,
  )
const dependencies: ComposerDependencies = {
  translate,
  ModelPicker: () => null,
  PermissionPicker: () => null,
  UsagePanel: () => null,
  isSubmitShortcut: (event) => event.key === 'Enter' && !event.shiftKey,
}

const controls = {
  paused: false,
  pending: false,
  disabled: false,
  pauseSupported: true,
  interruptSupported: true,
  reason: '',
}
const busy: ComposerView = {
  cancel: { disabled: false, hidden: false, label: '停止' },
  connected: true,
  configured: true,
  hasSession: true,
  hint: { kind: 'state', text: '' },
  input: { disabled: false, placeholder: '补充或调整，Agent 会在下一步收到…' },
  loading: false,
  model: { accessibleName: 'model', disabled: false, label: 'model', options: [], pending: false },
  permission: { disabled: false, pending: false, selected: 'workspace' },
  sending: false,
  send: { disabled: true, label: '排队指引', mode: 'busy', title: '排队指引' },
  stopping: false,
  usage: undefined,
  workspace: { disabled: false, label: 'agnes', title: '/workspace/agnes', visible: false },
  controls,
  queue: {
    items: [
      { itemId: 'a', preview: '而且颜色也不太好看啊' },
      { itemId: 'b', preview: '主色换成深蓝' },
    ],
    disabled: false,
    interruptSupported: true,
  },
}

const regions: RegionRenderer[] = []
function mount(view: ComposerView = busy) {
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
    onPauseResume: vi.fn(),
    onSendNow: vi.fn(),
    onPromoteQueued: vi.fn(),
    onEditQueued: vi.fn(async () => {}),
    onRemoveQueued: vi.fn(),
  } satisfies Partial<ComposerProps> & Record<string, unknown>
  region.render(createElement(Composer, { ...props, ref: handle, dependencies, initialView: view }))
  region.flush()
  if (!handle.current) throw new Error('composer did not mount')
  return { host, handle: handle.current, props }
}
const press = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

afterEach(() => {
  for (const region of regions.splice(0)) region.unmount()
  document.body.replaceChildren()
})

describe('queue tray', () => {
  it('sits on the card, says when the messages arrive and lists one line per message', () => {
    const { host } = mount()
    const tray = host.querySelector('.composer-queue')
    // The tray is the card's previous sibling: joined to its top edge, not inside it.
    expect(tray?.nextElementSibling?.id).toBe('composer')
    expect(tray?.querySelector('.composer-queue-count')?.textContent).toBe('待发送 2 条 · 智能体完成后发送')
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="queued-steer"]')]
    expect(rows.map((row) => row.querySelector('.composer-queue-preview')?.textContent)).toEqual([
      '而且颜色也不太好看啊',
      '主色换成深蓝',
    ])
    // Each line takes focus and carries "send at next step", edit, delete and a menu for interrupting.
    for (const row of rows) {
      expect(row.tabIndex).toBe(0)
      expect(
        [...row.querySelectorAll('.composer-queue-actions [data-testid]')].map((node) =>
          node.getAttribute('data-testid'),
        ),
      ).toEqual(['queued-steer-promote', 'queued-steer-edit', 'queued-steer-withdraw', 'queued-steer-more'])
    }
    const promote = rows[0]?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-promote"]')
    expect(promote?.querySelector('.composer-queue-send-label')?.textContent).toBe('下一步就发')
    expect(promote?.getAttribute('aria-label')).toBe('第 1 条消息下一步就发')
    expect(rows[1]?.querySelector('[data-testid="queued-steer-withdraw"]')?.getAttribute('aria-label')).toBe(
      '删除第 2 条消息',
    )
  })

  it('marks a message already queued as guidance instead of offering to promote it', () => {
    const { host } = mount({
      ...busy,
      queue: { items: [{ itemId: 'a', preview: 'x', kind: 'steer' }], disabled: false },
    })
    const row = host.querySelector('[data-testid="queued-steer"]')
    expect(row?.querySelector('.composer-queue-kind')?.textContent).toBe('下一步')
    expect(row?.querySelector('[data-testid="queued-steer-promote"]')).toBeNull()
  })

  it('promotes a queued message to guidance and keeps interrupting in its menu', async () => {
    const { host, props } = mount()
    const first = () => host.querySelector<HTMLElement>('[data-testid="queued-steer"]')
    first()?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-promote"]')?.click()
    expect(props.onPromoteQueued).toHaveBeenCalledWith('a')
    expect(props.onSendNow).not.toHaveBeenCalled()
    first()?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-more"]')?.click()
    const interrupt = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-testid="queued-steer-interrupt"]')
      expect(found?.textContent).toBe('立即打断')
      return found
    })
    interrupt?.click()
    expect(props.onSendNow).toHaveBeenCalledWith('a')
  })

  it('queues on Enter and sends guidance on ⌘/Ctrl+Enter', () => {
    const { host, props } = mount({ ...busy, send: { ...busy.send, disabled: false } })
    const prompt = host.querySelector<HTMLTextAreaElement>('#prompt')
    if (!prompt) throw new Error('missing prompt')
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(prompt, '补充')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(props.onSubmit).toHaveBeenLastCalledWith(undefined)
    for (const modifier of ['metaKey', 'ctrlKey'] as const) {
      prompt.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true }),
      )
      expect(props.onSubmit).toHaveBeenLastCalledWith({ steer: true })
    }
    // The next plain Enter queues again.
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(props.onSubmit).toHaveBeenLastCalledWith(undefined)
  })

  it('deletes and edits with the same handlers as before', async () => {
    const { host, props } = mount()
    const first = () => host.querySelector<HTMLElement>('[data-testid="queued-steer"]')
    first()?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-withdraw"]')?.click()
    expect(props.onRemoveQueued).toHaveBeenCalledWith('a')
    first()?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-edit"]')?.click()
    const editor = await vi.waitFor(() => {
      const found = first()?.querySelector<HTMLTextAreaElement>('[data-testid="queued-steer-editor"]')
      expect(found?.value).toBe('而且颜色也不太好看啊')
      return found
    })
    expect(editor).toBeTruthy()
    // The save button keeps the edit id, so editing is "edit, change, edit again".
    first()?.querySelector<HTMLButtonElement>('[data-testid="queued-steer-edit"]')?.click()
    expect(props.onEditQueued).toHaveBeenCalledWith('a', '而且颜色也不太好看啊')
  })

  it('takes Delete and Enter on a focused line', async () => {
    const { host, props } = mount()
    const row = host.querySelectorAll<HTMLElement>('[data-testid="queued-steer"]')[1]
    if (!row) throw new Error('missing row')
    row.focus()
    press(row, 'Delete')
    expect(props.onRemoveQueued).toHaveBeenCalledWith('b')
    press(row, 'Enter')
    await vi.waitFor(() => expect(row.querySelector('[data-testid="queued-steer-editor"]')).toBeTruthy())
    // A key inside the text box is the text box's, not the line's.
    press(row.querySelector('[data-testid="queued-steer-editor"]') as Element, 'Delete')
    expect(props.onRemoveQueued).toHaveBeenCalledTimes(1)
  })

  it('pauses with an icon beside stop; paused, it continues and a strip says when messages arrive', () => {
    const { host, handle, props } = mount()
    const pause = host.querySelector<HTMLButtonElement>('[data-testid="composer-pause-resume"]')
    const stop = host.querySelector<HTMLButtonElement>('#cancel')
    expect(pause?.nextElementSibling === stop || pause?.closest('span')?.nextElementSibling === stop).toBe(
      true,
    )
    expect(pause?.getAttribute('aria-label')).toBe('暂停')
    expect(pause?.textContent).toBe('')
    expect(pause?.querySelector('svg')).toBeTruthy()
    expect(host.querySelector('[data-testid="composer-paused"]')).toBeNull()
    pause?.click()
    expect(props.onPauseResume).toHaveBeenCalledTimes(1)

    handle.render({ ...busy, controls: { ...controls, paused: true } })
    expect(pause?.getAttribute('aria-label')).toBe('继续')
    expect(pause?.getAttribute('aria-pressed')).toBe('true')
    const strip = host.querySelector('[data-testid="composer-paused"]')
    expect(strip?.getAttribute('role')).toBe('status')
    expect(strip?.textContent).toBe('已暂停。排队的 2 条消息会在继续后送达。')
    // The strip says when they arrive, so the tray keeps its lines and drops its heading.
    expect(strip?.nextElementSibling?.classList.contains('composer-queue')).toBe(true)
    expect(host.querySelector('.composer-queue-count')).toBeNull()
    expect(host.querySelectorAll('[data-testid="queued-steer"]')).toHaveLength(2)
  })
})
