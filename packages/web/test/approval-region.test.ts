/** @vitest-environment happy-dom */

import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APPROVAL_SLOT } from '../src/region-slots.js'
import { mountRenderedIndex, resetWebDom } from './web-dom-fixture.js'

describe('rendered approval region', () => {
  let runtime: Awaited<ReturnType<typeof mountRenderedIndex>> | undefined

  afterEach(async () => {
    await runtime?.dispose()
    runtime = undefined
    resetWebDom()
  })

  it('renders the live-region card through the public approval handle', async () => {
    runtime = await mountRenderedIndex()
    const approval = document.querySelector<HTMLElement>('#approval')
    const handle = runtime.approval
    expect(handle).toBeDefined()
    expect(approval?.getAttribute('aria-live')).toBe('polite')

    const selected: string[] = []
    handle?.render({
      key: 'live:tool-1',
      title: '需要你的确认',
      summary: '读取工作区文件',
      impact: '请核对工具及参数后决定是否继续。',
      preview: '{"path":"README.md"}',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: false,
    })
    await vi.waitFor(() => {
      expect(approval?.hidden).toBe(false)
      expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认')
      expect(approval?.querySelectorAll('.approval-actions button')).toHaveLength(2)
    })

    expect(
      approval?.querySelector('[data-slot="ui:approval"] [data-agnes-region-unit="approval"]'),
    ).toBeTruthy()
    expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认')
    expect(approval?.querySelector('pre')?.textContent).toBe('{"path":"README.md"}')
    expect(approval?.querySelectorAll<HTMLButtonElement>('.approval-actions button')).toHaveLength(2)

    const reject = approval?.querySelector<HTMLButtonElement>('.approval-actions button:nth-child(2)')
    reject?.focus()
    handle?.render({
      key: 'live:tool-1',
      title: '需要你的确认',
      summary: '读取工作区文件',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: true,
    })
    await vi.waitFor(() => {
      const disabledReject = approval?.querySelector<HTMLButtonElement>(
        '.approval-actions button:nth-child(2)',
      )
      expect(disabledReject?.disabled).toBe(true)
      expect(document.activeElement).not.toBe(disabledReject)
    })
    handle?.render({
      key: 'live:tool-1',
      title: '需要你的确认',
      summary: '读取工作区文件',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [
        { id: 'allow', label: '仅允许这次', onSelect: () => selected.push('allow') },
        { id: 'reject', label: '拒绝', onSelect: () => selected.push('reject') },
      ],
      disabled: false,
    })
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        approval?.querySelector<HTMLButtonElement>('.approval-actions button:nth-child(2)'),
      )
    })
    handle?.render(undefined)
    await vi.waitFor(() => expect(approval?.hidden).toBe(true))
    expect(selected).toEqual([])
  })

  it('keeps approval actions natively keyboard-activatable', async () => {
    runtime = await mountRenderedIndex()
    const handle = runtime.approval
    const selected: string[] = []
    handle?.render({
      key: 'live:keyboard-1',
      title: '需要你的确认',
      summary: '执行命令',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [{ id: 'allow', label: '允许', onSelect: () => selected.push('allow') }],
      disabled: false,
    })
    await vi.waitFor(() => {
      expect(document.querySelector('#approval .approval-actions button')).toBeTruthy()
    })

    const allow = document.querySelector<HTMLButtonElement>('#approval .approval-actions button')
    expect(allow?.type).toBe('button')
    allow?.focus()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    allow?.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    allow?.click()
    expect(selected).toEqual(['allow'])
  })

  it('shadows only approval and restores the built-in component after unload', async () => {
    runtime = await mountRenderedIndex()
    const approval = document.querySelector('#approval')
    runtime.approval?.render({
      key: 'shadow-replay',
      title: '需要你的确认',
      summary: '恢复当前审批',
      impact: '请核对工具及参数后决定是否继续。',
      actions: [],
      disabled: false,
    })
    await vi.waitFor(() => expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认'))
    const remove = runtime.registry.register(
      {
        name: APPROVAL_SLOT as string,
        id: 'fixture-approval-shadow',
        owner: 'fixture',
        priority: -1,
      },
      () => createElement('div', { id: 'shadow-approval' }, '替换审批'),
    )
    await vi.waitFor(() => {
      expect(approval?.querySelector('#shadow-approval')?.textContent).toBe('替换审批')
      expect(approval?.querySelector('#approval-content')).toBeNull()
    })

    expect(document.querySelector('[data-slot="ui:conversation"] #transcript')).toBeTruthy()
    expect(document.querySelector('[data-slot="ui:composer"] #prompt')).toBeTruthy()

    remove()
    await vi.waitFor(() => {
      expect(approval?.querySelector('[data-agnes-region-unit="approval"]')).toBeTruthy()
      expect(approval?.querySelector('#approval-content')).toBeTruthy()
      expect(approval?.querySelector('h2')?.textContent).toBe('需要你的确认')
      expect(approval?.querySelector('p')?.textContent).toBe('恢复当前审批')
    })
  })
})
